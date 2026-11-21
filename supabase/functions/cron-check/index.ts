// רץ כל 5 דקות (pg_cron). שולח:
//  ⏰ תזכורת שהגיע זמנה
//  ⚠️ 24 שעות לפני תפוגה (ושעה לפני, למשימות גבוהות/דחופות)
//  ⌛ משימה שפג תוקפה ולא בוצעה
//  🐢 משימה שלא בוצעה כבר X ימים (רק בין 9:00 ל-21:00)
//  📚 מבחן מחר (מ-20:00 בערב שלפני)
// כל התראה "נתפסת" קודם בעדכון מותנה (is null), כך ששתי ריצות במקביל לא ישלחו פעמיים.
import { allProfiles, db, fmtDateTime, fmtExamDate, israelDate, israelHour, json, pushTo, URGENCY } from "../_shared/push.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Task = {
  id: number;
  title: string;
  urgency: string;
  created_at: string;
  due_at: string | null;
  reminder_at: string | null;
  stale_days: number | null;
  reminder_sent_at: string | null;
  expiry_warned_at: string | null;
  expiry_urgent_warned_at: string | null;
  expired_notified_at: string | null;
  last_stale_nudge_at: string | null;
  task_assignees: { user_id: string; done_at: string | null }[];
};

/** מסמן עמודה רק אם עדיין ריקה. מחזיר true אם הריצה הזו "תפסה" את ההתראה. */
async function claim(table: string, id: number, column: string, onlyIfNull = true): Promise<boolean> {
  let q = db.from(table).update({ [column]: new Date().toISOString() }).eq("id", id);
  if (onlyIfNull) q = q.is(column, null);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

Deno.serve(async () => {
  const now = new Date();
  const log: string[] = [];

  try {
    const profiles = await allProfiles();
    const everyone = profiles.map((p) => p.id);

    const { data: tasks, error } = await db.from("tasks")
      .select("id, title, urgency, created_at, due_at, reminder_at, stale_days, reminder_sent_at, expiry_warned_at, expiry_urgent_warned_at, expired_notified_at, last_stale_nudge_at, task_assignees(user_id, done_at)")
      .is("completed_at", null);
    if (error) throw error;

    for (const t of (tasks ?? []) as Task[]) {
      const pending = t.task_assignees.filter((a) => !a.done_at).map((a) => a.user_id);
      const to = pending.length ? pending : everyone;
      const link = `./#task-${t.id}`;

      // ⏰ תזכורת
      if (t.reminder_at && !t.reminder_sent_at && Date.parse(t.reminder_at) <= now.getTime()) {
        if (await claim("tasks", t.id, "reminder_sent_at")) {
          await pushTo(to, {
            title: "⏰ תזכורת",
            body: `${t.title}${t.due_at ? `\nעד ${fmtDateTime(t.due_at)}` : ""}`,
            tag: `task-${t.id}`,
            url: link,
          });
          log.push(`reminder ${t.id}`);
        }
      }

      // תפוגה
      if (t.due_at) {
        const due = Date.parse(t.due_at);
        const left = due - now.getTime();
        const created = Date.parse(t.created_at);
        const important = t.urgency === "high" || t.urgency === "urgent";

        if (left <= 0) {
          if (!t.expired_notified_at && await claim("tasks", t.id, "expired_notified_at")) {
            await pushTo(everyone, {
              title: "⌛ פג התוקף של משימה",
              body: `${t.title}\nהמשימה לא בוצעה בזמן`,
              tag: `task-${t.id}`,
              url: link,
            });
            log.push(`expired ${t.id}`);
          }
        } else if (important && left <= HOUR) {
          if (!t.expiry_urgent_warned_at && await claim("tasks", t.id, "expiry_urgent_warned_at")) {
            await claim("tasks", t.id, "expiry_warned_at"); // אין צורך גם באזהרת 24 שעות
            if (created < due - HOUR) {
              await pushTo(to, {
                title: `${URGENCY[t.urgency]} · נשארה פחות משעה!`,
                body: t.title,
                tag: `task-${t.id}`,
                url: link,
              });
              log.push(`1h ${t.id}`);
            }
          }
        } else if (left <= DAY) {
          if (!t.expiry_warned_at && await claim("tasks", t.id, "expiry_warned_at")) {
            // משימה שנוצרה כבר בתוך 24 השעות האחרונות - כבר יודעים עליה
            if (created < due - DAY) {
              await pushTo(to, {
                title: "⚠️ נשארו פחות מ-24 שעות",
                body: `${t.title}\nעד ${fmtDateTime(t.due_at)}`,
                tag: `task-${t.id}`,
                url: link,
              });
              log.push(`24h ${t.id}`);
            }
          }
        }
      }

      // 🐢 משימה שמחכה הרבה זמן (רק בשעות סבירות)
      if (t.stale_days) {
        const hour = israelHour(now);
        // סופרים מהיצירה, או מהתזכורת אם נקבעה לאחר מכן (משימה שתוכננה לעתיד לא "תקועה")
        const start = Math.max(Date.parse(t.created_at), t.reminder_at ? Date.parse(t.reminder_at) : 0);
        const since = t.last_stale_nudge_at ? Date.parse(t.last_stale_nudge_at) : start;
        if (hour >= 9 && hour < 21 && now.getTime() - since >= t.stale_days * DAY) {
          const { data: got } = await db.from("tasks")
            .update({ last_stale_nudge_at: now.toISOString() })
            .eq("id", t.id)
            .filter("last_stale_nudge_at", t.last_stale_nudge_at ? "eq" : "is", t.last_stale_nudge_at ?? null)
            .select("id");
          if (got?.length) {
            const days = Math.floor((now.getTime() - start) / DAY);
            await pushTo(to, {
              title: `🐢 משימה מחכה כבר ${days} ימים`,
              body: `${t.title}\n${URGENCY[t.urgency] ?? ""}`,
              tag: `task-${t.id}`,
              url: link,
            });
            log.push(`stale ${t.id}`);
          }
        }
      }
    }

    // 📚 מבחן מחר
    if (israelHour(now) >= 20) {
      const tomorrow = israelDate(new Date(now.getTime() + DAY));
      const { data: exams, error: exErr } = await db.from("exams")
        .select("id, subject, exam_date, exam_time, owner_id")
        .eq("exam_date", tomorrow).is("day_before_sent_at", null);
      if (exErr) throw exErr;
      for (const e of exams ?? []) {
        if (await claim("exams", e.id, "day_before_sent_at")) {
          const owner = profiles.find((p) => p.id === e.owner_id)?.display_name;
          await pushTo(everyone, {
            title: "📚 מחר מבחן!",
            body: `${e.subject}${owner ? ` (${owner})` : ""}\n${fmtExamDate(e.exam_date, e.exam_time)} · בהצלחה!`,
            tag: `exam-${e.id}`,
            url: "./#exams",
          });
          log.push(`exam ${e.id}`);
        }
      }
    }

    return json({ ok: true, at: now.toISOString(), sent: log });
  } catch (err) {
    console.error(err);
    return json({ error: (err as Error).message }, 500);
  }
});
