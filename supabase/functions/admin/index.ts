// פעולות מנהל שצריכות את מפתח השרת: רשימת משתמשים, יצירה, מחיקה, איפוס סיסמה.
// כל קריאה נבדקת: הטוקן של המשתמש המחובר חייב להיות של פרופיל עם is_admin = true.
import { db } from "../_shared/push.ts";

const MAX_USERS = 2;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  // מי קורא?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "not signed in" }, 401);
  const { data: who, error: whoErr } = await db.auth.getUser(token);
  if (whoErr || !who?.user) return reply({ error: "not signed in" }, 401);
  const me = who.user;
  const { data: myProfile } = await db.from("profiles").select("is_admin").eq("id", me.id).maybeSingle();
  if (!myProfile?.is_admin) return reply({ error: "רק מנהל יכול לעשות את זה" }, 403);

  let body: Record<string, string>;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "bad json" }, 400);
  }

  try {
    switch (body.action) {
      case "list": {
        const [{ data: users, error: uErr }, { data: profiles }, { data: subs }] = await Promise.all([
          db.auth.admin.listUsers({ perPage: 100 }),
          db.from("profiles").select("id, display_name, is_admin, created_at"),
          db.from("push_subscriptions").select("id, user_id, user_agent, created_at"),
        ]);
        if (uErr) throw uErr;
        const list = (users?.users ?? []).map((u) => {
          const p = profiles?.find((x) => x.id === u.id);
          return {
            id: u.id,
            email: u.email,
            display_name: p?.display_name ?? null,
            is_admin: p?.is_admin ?? false,
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at ?? null,
            devices: (subs ?? []).filter((s) => s.user_id === u.id),
          };
        });
        list.sort((a, b) => Number(b.is_admin) - Number(a.is_admin) || a.created_at.localeCompare(b.created_at));
        return reply({ users: list, max: MAX_USERS });
      }

      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const password = String(body.password ?? "");
        const display_name = String(body.display_name ?? "").trim();
        if (!EMAIL_RE.test(email)) return reply({ error: "אימייל לא תקין" }, 400);
        if (password.length < 6) return reply({ error: "הסיסמה צריכה להיות לפחות 6 תווים" }, 400);
        if (!display_name || display_name.length > 40) return reply({ error: "צריך שם (עד 40 תווים)" }, 400);

        const { count } = await db.from("profiles").select("id", { count: "exact", head: true });
        if ((count ?? 0) >= MAX_USERS) return reply({ error: "כבר יש שני משתמשים. מחקו אחד לפני שמוסיפים חדש." }, 409);

        const { data, error } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { display_name },
          app_metadata: { created_by_admin: true },
        });
        if (error) {
          if (/already been registered|already registered|exists/i.test(error.message)) {
            return reply({ error: "האימייל הזה כבר רשום" }, 409);
          }
          throw error;
        }
        return reply({ ok: true, id: data.user?.id });
      }

      case "delete": {
        const uid = String(body.user_id ?? "");
        if (!uid) return reply({ error: "חסר משתמש" }, 400);
        if (uid === me.id) return reply({ error: "אי אפשר למחוק את חשבון המנהל של עצמך" }, 400);

        const { data: removed, error: rpcErr } = await db.rpc("admin_before_delete_user", { p_uid: uid });
        if (rpcErr) throw rpcErr;
        const { error } = await db.auth.admin.deleteUser(uid);
        if (error) throw error;
        return reply({ ok: true, tasks_removed: removed ?? 0 });
      }

      case "reset_password": {
        const uid = String(body.user_id ?? "");
        const password = String(body.password ?? "");
        if (!uid) return reply({ error: "חסר משתמש" }, 400);
        if (password.length < 6) return reply({ error: "הסיסמה צריכה להיות לפחות 6 תווים" }, 400);
        const { error } = await db.auth.admin.updateUserById(uid, { password });
        if (error) throw error;
        return reply({ ok: true });
      }

      default:
        return reply({ error: "unknown action" }, 400);
    }
  } catch (err) {
    console.error(err);
    return reply({ error: (err as Error).message }, 500);
  }
});
