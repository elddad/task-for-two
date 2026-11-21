// שליחת Web Push לכל המכשירים של משתמשים, וכלים משותפים לפונקציות
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// מפתח שרת: בפרויקטים חדשים מגיע כ-SUPABASE_SECRET_KEYS (JSON), בישנים כ-SUPABASE_SERVICE_ROLE_KEY
function serverKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, string>;
      const key = keys.default ?? Object.values(keys)[0];
      if (key) return key;
    } catch { /* נופלים למפתח הישן */ }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("no server key in environment");
  return legacy;
}

export const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), {
  auth: { persistSession: false },
});

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT")!,
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

export type PushPayload = { title: string; body: string; tag?: string; url?: string };

/** שולח לכל המנויים של המשתמשים האלה. מוחק מנויים שכבר לא קיימים. מחזיר כמה נשלחו. */
export async function pushTo(userIds: string[], payload: PushPayload): Promise<number> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return 0;

  const { data: subs, error } = await db
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", ids);
  if (error) throw error;

  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        console.error("push failed", code, (e as Error).message);
      }
    }
  }));
  return sent;
}

export async function allProfiles(): Promise<{ id: string; display_name: string }[]> {
  const { data, error } = await db.from("profiles").select("id, display_name");
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------- טקסטים

export const TZ = "Asia/Jerusalem";

export const URGENCY: Record<string, string> = {
  low: "🟢 נמוכה",
  medium: "🟡 רגילה",
  high: "🟠 גבוהה",
  urgent: "🔴 דחוף",
};

/** "יום ג׳ 3.12 בשעה 14:00" לפי שעון ישראל */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, weekday: "short" }).format(d);
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, day: "numeric", month: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${day} ${date} בשעה ${time}`;
}

/** תאריך (YYYY-MM-DD) לפי שעון ישראל */
export function israelDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** שעה (0-23) לפי שעון ישראל */
export function israelHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(d)) % 24;
}

export function fmtExamDate(date: string, time?: string | null): string {
  const [y, m, d] = date.split("-").map(Number);
  const asDate = new Date(Date.UTC(y, m - 1, d, 12));
  const day = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", weekday: "long" }).format(asDate);
  return `${day} ${d}.${m}${time ? ` בשעה ${time.slice(0, 5)}` : ""}`;
}

/** כמה ימים מהיום (שעון ישראל) עד התאריך */
export function daysUntil(date: string, now = new Date()): number {
  const today = israelDate(now);
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

export function inDays(n: number): string {
  if (n === 0) return "היום";
  if (n === 1) return "מחר";
  if (n === 2) return "מחרתיים";
  if (n < 0) return `לפני ${-n} ימים`;
  return `בעוד ${n} ימים`;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
