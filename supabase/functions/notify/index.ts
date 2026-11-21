// נקרא מטריגר במסד הנתונים: משימה חדשה, מבחן חדש, משימה שהושלמה.
// שולח התראה לשני (לא למי שעשה את הפעולה).
// כל אירוע נשלח פעם אחת בלבד (notified_at / done_notified_at), אז קריאה כפולה לא מזיקה.
import { allProfiles, daysUntil, db, fmtDateTime, fmtExamDate, inDays, json, pushTo, URGENCY } from "../_shared/push.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { table?: string; id?: number; event?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "bad id" }, 400);

  try {
    const profiles = await allProfiles();
    const name = (uid: string | null) => profiles.find((p) => p.id === uid)?.display_name ?? "מישהו";
    const others = (uid: string | null) => profiles.filter((p) => p.id !== uid).map((p) => p.id);

    if (body.table === "tasks" && body.event === "insert") {
      const { data: claimed } = await db.from("tasks")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", id).is("notified_at", null)
        .select("id, title, urgency, assign_mode, created_by, due_at, task_assignees(user_id)");
      const t = claimed?.[0];
      if (!t) return json({ skipped: "already notified" });

      const assignees = (t.task_assignees ?? []).map((a: { user_id: string }) => a.user_id);
      const recipients = others(t.created_by);
      let forWhom = "";
      if (assignees.length > 1) forWhom = t.assign_mode === "each" ? "לשניכם (כל אחד)" : "לאחד מכם";
      else if (assignees[0] && recipients.includes(assignees[0])) forWhom = "בשבילך";
      else if (assignees[0]) forWhom = `בשביל ${name(assignees[0])}`;

      const parts = [t.title, `${URGENCY[t.urgency] ?? ""} · ${forWhom}`];
      if (t.due_at) parts.push(`עד ${fmtDateTime(t.due_at)}`);
      const sent = await pushTo(recipients, {
        title: `📌 משימה חדשה מ${name(t.created_by)}`,
        body: parts.join("\n"),
        tag: `task-${t.id}`,
        url: `./#task-${t.id}`,
      });
      return json({ sent });
    }

    if (body.table === "tasks" && body.event === "done") {
      const { data: claimed } = await db.from("tasks")
        .update({ done_notified_at: new Date().toISOString() })
        .eq("id", id).is("done_notified_at", null).not("completed_at", "is", null)
        .select("id, title, completed_by");
      const t = claimed?.[0];
      if (!t) return json({ skipped: "already notified or not done" });

      const sent = await pushTo(others(t.completed_by), {
        title: `✅ ${name(t.completed_by)} סימן/ה שבוצע`,
        body: t.title,
        tag: `task-${t.id}`,
        url: `./#task-${t.id}`,
      });
      return json({ sent });
    }

    if (body.table === "exams" && body.event === "insert") {
      const { data: claimed } = await db.from("exams")
        .update({ notified_at: new Date().toISOString() })
        .eq("id", id).is("notified_at", null)
        .select("id, subject, exam_date, exam_time, owner_id, created_by");
      const e = claimed?.[0];
      if (!e) return json({ skipped: "already notified" });

      const recipients = others(e.created_by);
      const whose = e.owner_id === null
        ? "של שניכם"
        : recipients.includes(e.owner_id) ? "שלך" : `של ${name(e.owner_id)}`;
      const sent = await pushTo(recipients, {
        title: `📚 מבחן חדש מ${name(e.created_by)}`,
        body: `${e.subject} (${whose})\n${fmtExamDate(e.exam_date, e.exam_time)} · ${inDays(daysUntil(e.exam_date))}`,
        tag: `exam-${e.id}`,
        url: "./#exams",
      });
      return json({ sent });
    }

    return json({ error: "unknown event" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});
