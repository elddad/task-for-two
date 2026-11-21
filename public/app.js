import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";
import { SUPABASE_ANON_KEY, SUPABASE_URL, VAPID_PUBLIC_KEY } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "tasks-for-two-auth" },
});

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const URGENCY = {
  urgent: { label: "דחוף", icon: "🔴", rank: 4 },
  high: { label: "גבוהה", icon: "🟠", rank: 3 },
  medium: { label: "רגילה", icon: "🟡", rank: 2 },
  low: { label: "נמוכה", icon: "🟢", rank: 1 },
};

const state = {
  me: null,          // { id, display_name }
  other: null,       // הפרופיל של השני (או null אם עוד לא נרשם)
  profiles: [],
  tasks: [],
  exams: [],
  tab: "tasks",
  filter: "open",
  editingTask: null,
  editingExam: null,
};

// ================================================================ זמן ותאריכים

const pad = (n) => String(n).padStart(2, "0");
function toLocalInput(d) {
  if (!d) return "";
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
const todayStr = () => new Date().toLocaleDateString("en-CA");

const fmtWhen = (iso) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString("he-IL", { weekday: "short" });
  return `${day} ${d.getDate()}.${d.getMonth() + 1} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function dueText(iso) {
  const ms = new Date(iso) - Date.now();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000), hours = Math.round(abs / 3600000), days = Math.round(abs / 86400000);
  const span = mins < 60 ? `${mins} דק׳` : hours < 24 ? `${hours} שע׳` : days === 1 ? "יום" : `${days} ימים`;
  if (ms < 0) return { text: `פג לפני ${span}`, cls: "overdue" };
  return { text: `עוד ${span}`, cls: ms < 86400000 ? "soon" : "" };
}

function daysUntil(dateStr) {
  return Math.round((Date.parse(dateStr) - Date.parse(todayStr())) / 86400000);
}
function inDays(n) {
  if (n === 0) return "היום!";
  if (n === 1) return "מחר";
  if (n === 2) return "מחרתיים";
  if (n < 0) return `לפני ${-n} ימים`;
  return `בעוד ${n} ימים`;
}
function fmtExamDate(date, time) {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString("he-IL", { weekday: "long" });
  return `${day} ${d}.${m}${time ? ` · ${time.slice(0, 5)}` : ""}`;
}

// ================================================================ כללי

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

const nameOf = (id) => (id === state.me?.id ? "אני" : state.profiles.find((p) => p.id === id)?.display_name ?? "משתמש שנמחק");
const otherName = () => state.other?.display_name ?? "השני";

function friendlyError(err) {
  const m = err?.message || String(err);
  if (/SIGNUP_CLOSED/i.test(m)) return "רק המנהל יכול ליצור חשבונות.";
  if (/APP_FULL/i.test(m)) return "האפליקציה כבר מלאה – יש בה שני משתמשים.";
  if (/Database error creating new user/i.test(m)) return "יצירת החשבון נכשלה (שגיאת מסד נתונים).";
  if (/Database error saving new user|Signups not allowed/i.test(m)) return "אי אפשר להירשם. רק המנהל יוצר חשבונות.";
  if (/Invalid login credentials/i.test(m)) return "אימייל או סיסמה לא נכונים.";
  if (/already registered/i.test(m)) return "האימייל הזה כבר רשום. נסו להתחבר.";
  if (/Email not confirmed/i.test(m)) return "צריך לאשר את האימייל (בדקו את תיבת הדואר).";
  if (/Password should be/i.test(m)) return "הסיסמה צריכה להיות לפחות 6 תווים.";
  if (/Failed to fetch|NetworkError/i.test(m)) return "אין חיבור לאינטרנט.";
  return m;
}

// ================================================================ התחברות

let signupMode = false;
function setAuthMode(signup) {
  signupMode = signup;
  $("#name-row").hidden = !signup;
  $("#auth-form [name=display_name]").required = signup;
  $("#auth-form [name=password]").autocomplete = signup ? "new-password" : "current-password";
  $("#auth-submit").textContent = signup ? "יצירת חשבון מנהל" : "כניסה";
  $("#auth-toggle").textContent = signup ? "חזרה לכניסה" : "הגדרה ראשונה: יצירת חשבון מנהל";
  $("#auth-error").hidden = true;
}
$("#auth-toggle").addEventListener("click", () => setAuthMode(!signupMode));

// הרשמה פתוחה רק פעם אחת: למנהל, לפני שיש לו חשבון. את כל השאר המנהל יוצר בפאנל.
async function checkAdminSetup() {
  const { data } = await sb.rpc("admin_setup_open");
  $("#auth-toggle").hidden = data !== true;
  $("#auth-note").hidden = data === true;
}

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const email = f.email.value.trim(), password = f.password.value;
  const btn = $("#auth-submit");
  btn.disabled = true;
  $("#auth-error").hidden = true;
  try {
    if (signupMode) {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { display_name: f.display_name.value.trim() } },
      });
      if (error) throw error;
      if (!data.session) {
        showAuthError("נשלח אליך מייל לאישור. אחרי האישור – חזרו לכאן והתחברו.");
        setAuthMode(false);
        return;
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    showAuthError(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});
function showAuthError(msg) {
  $("#auth-error").textContent = msg;
  $("#auth-error").hidden = false;
}

$("#logout").addEventListener("click", async () => {
  await sb.auth.signOut();
});

let started = false;
sb.auth.onAuthStateChange((_event, session) => {
  if (session?.user) {
    if (!started || state.me?.id !== session.user.id) startApp(session.user);
  } else {
    started = false;
    stopRealtime();
    $("#app").hidden = true;
    $("#auth").hidden = false;
    setAuthMode(false);
    checkAdminSetup();
  }
});

// ================================================================ טעינה

async function startApp(user) {
  started = true;
  $("#auth").hidden = true;
  $("#app").hidden = false;
  state.me = { id: user.id, display_name: user.user_metadata?.display_name || "" };
  await loadAll();
  startRealtime();
  syncPushSubscription();
  handleHash();
}

async function loadAll() {
  const [p, t, e] = await Promise.all([
    sb.from("profiles").select("id, display_name, is_admin"),
    sb.from("tasks").select("*, task_assignees(user_id, done_at)").order("created_at", { ascending: false }),
    sb.from("exams").select("*").order("exam_date").order("exam_time", { nullsFirst: true }),
  ]);
  for (const r of [p, t, e]) if (r.error) { toast(friendlyError(r.error)); return; }
  state.profiles = p.data;
  state.me = p.data.find((x) => x.id === state.me.id) ?? state.me;
  state.other = p.data.find((x) => x.id !== state.me.id) ?? null;
  state.tasks = t.data;
  state.exams = e.data;
  render();
}

let channel, reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadAll, 250);
}
function startRealtime() {
  stopRealtime();
  channel = sb.channel("all-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "task_assignees" }, scheduleReload)
    .on("postgres_changes", { event: "*", schema: "public", table: "exams" }, scheduleReload)
    .subscribe();
}
function stopRealtime() {
  if (channel) sb.removeChannel(channel);
  channel = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && started) loadAll();
});

// ================================================================ ניווט

const TITLES = { tasks: "משימות", exams: "מבחנים", settings: "הגדרות" };
function setTab(tab) {
  state.tab = tab;
  for (const b of $$(".tabbar button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of $$(".tab")) s.hidden = s.id !== `tab-${tab}`;
  $("#page-title").textContent = TITLES[tab];
  $("#fab").hidden = tab === "settings";
  render();
}
for (const b of $$(".tabbar button")) b.addEventListener("click", () => setTab(b.dataset.tab));

$("#fab").addEventListener("click", () => (state.tab === "exams" ? openExam(null) : openTask(null)));

function handleHash(url = location.href) {
  const hash = new URL(url).hash;
  if (hash === "#exams") setTab("exams");
  const m = hash.match(/^#task-(\d+)$/);
  if (m) {
    setTab("tasks");
    const task = state.tasks.find((t) => t.id === Number(m[1]));
    if (task) {
      if (task.completed_at) state.filter = "done";
      render();
      const el = document.getElementById(`task-${task.id}`);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
    }
  }
  if (hash) history.replaceState(null, "", location.pathname + location.search);
}
window.addEventListener("hashchange", () => handleHash());
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (e.data?.type === "open") handleHash(e.data.url);
});

// ================================================================ רינדור

function render() {
  if (!state.me) return;
  const open = state.tasks.filter((t) => !t.completed_at);
  const mine = open.filter((t) => isPendingFor(t, state.me.id));
  $("#subtitle").textContent = state.tab === "tasks"
    ? `${mine.length ? `${mine.length} מחכות לך` : "אין משימות שמחכות לך"} · שלום ${state.me.display_name}`
    : state.tab === "exams"
      ? `${upcomingExams().length} מבחנים קרובים`
      : "";
  renderTasks();
  renderExams();
  renderSettings();
}

function isPendingFor(t, uid) {
  return t.task_assignees.some((a) => a.user_id === uid && !a.done_at);
}

function taskSort(a, b) {
  const overdueA = a.due_at && new Date(a.due_at) < new Date() ? 1 : 0;
  const overdueB = b.due_at && new Date(b.due_at) < new Date() ? 1 : 0;
  if (overdueA !== overdueB) return overdueB - overdueA;
  const u = URGENCY[b.urgency].rank - URGENCY[a.urgency].rank;
  if (u) return u;
  if (a.due_at && b.due_at) return new Date(a.due_at) - new Date(b.due_at);
  if (a.due_at) return -1;
  if (b.due_at) return 1;
  return new Date(b.created_at) - new Date(a.created_at);
}

function renderTasks() {
  const open = state.tasks.filter((t) => !t.completed_at);
  const filters = [
    ["open", "הכל", open.length],
    ["mine", "שלי", open.filter((t) => t.task_assignees.some((a) => a.user_id === state.me.id)).length],
    ["other", `של ${otherName()}`, open.filter((t) => state.other && t.task_assignees.some((a) => a.user_id === state.other.id)).length],
    ["repeat", "🔁 קבועות", open.filter((t) => t.repeat_kind).length],
    ["done", "בוצעו", state.tasks.length - open.length],
  ];
  $("#task-filters").innerHTML = filters.map(([key, label, n]) =>
    `<button type="button" class="chip ${state.filter === key ? "active" : ""}" data-filter="${key}">${esc(label)}${n ? ` <b>${n}</b>` : ""}</button>`).join("");

  let list;
  if (state.filter === "done") {
    list = state.tasks.filter((t) => t.completed_at).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at)).slice(0, 50);
  } else {
    list = open.filter((t) =>
      state.filter === "mine" ? t.task_assignees.some((a) => a.user_id === state.me.id)
        : state.filter === "other" ? state.other && t.task_assignees.some((a) => a.user_id === state.other.id)
          : state.filter === "repeat" ? Boolean(t.repeat_kind)
            : true).sort(taskSort);
  }

  $("#task-list").innerHTML = list.map(taskCard).join("");
  $("#task-empty").hidden = list.length > 0;
  $("#task-empty").textContent = state.filter === "done" ? "עוד לא בוצעו משימות" : "אין משימות פתוחות 🎉  לחצו + כדי להוסיף";
}

function whoText(t) {
  const ids = t.task_assignees.map((a) => a.user_id);
  if (ids.length > 1) return t.assign_mode === "each" ? "👥 שנינו – כל אחד" : "👥 אחד מאיתנו";
  return ids[0] === state.me.id ? "👤 אני" : `👤 ${esc(nameOf(ids[0]))}`;
}

function taskCard(t) {
  const u = URGENCY[t.urgency];
  const done = Boolean(t.completed_at);
  const meta = [`<span class="tag">${whoText(t)}</span>`];
  if (t.repeat_kind) meta.push(`<span class="tag repeat">🔁 ${esc(repeatText(t))}</span>`);
  if (!done && t.due_at) {
    const d = dueText(t.due_at);
    meta.push(`<span class="tag ${d.cls}" title="${esc(fmtWhen(t.due_at))}">⌛ ${d.text} · ${esc(fmtWhen(t.due_at))}</span>`);
  }
  if (!done && t.reminder_at && !t.reminder_sent_at) meta.push(`<span class="tag">⏰ ${esc(fmtWhen(t.reminder_at))}</span>`);
  if (done) meta.push(`<span class="tag">✅ ${esc(nameOf(t.completed_by))} · ${esc(fmtWhen(t.completed_at))}</span>`);
  else if (t.created_by !== state.me.id) meta.push(`<span class="tag subtle">נוסף ע״י ${esc(nameOf(t.created_by))}</span>`);

  // מצב "כל אחד": מראים מי כבר סיים
  let progress = "";
  if (!done && t.assign_mode === "each" && t.task_assignees.length > 1) {
    progress = `<div class="progress">${t.task_assignees.map((a) =>
      `<span class="${a.done_at ? "ok" : ""}">${a.done_at ? "✓" : "○"} ${esc(nameOf(a.user_id))}</span>`).join("")}</div>`;
  }

  const checked = done || (t.assign_mode === "each" && t.task_assignees.some((a) => a.user_id === state.me.id && a.done_at));
  return `<li class="task u-${t.urgency} ${done ? "done" : ""}" id="task-${t.id}" data-id="${t.id}">
    <button class="check ${checked ? "on" : ""}" type="button" data-check="${t.id}" aria-label="סימון בוצע">${checked ? "✓" : ""}</button>
    <div class="task-main" data-open="${t.id}">
      <div class="task-title"><span class="urg" title="${u.label}">${u.icon}</span>${esc(t.title)}</div>
      ${t.notes ? `<div class="task-notes">${esc(t.notes)}</div>` : ""}
      ${progress}
      <div class="meta">${meta.join("")}</div>
    </div>
  </li>`;
}

$("#task-filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  state.filter = b.dataset.filter;
  renderTasks();
});

$("#task-list").addEventListener("click", async (e) => {
  const check = e.target.closest("[data-check]");
  if (check) {
    const t = state.tasks.find((x) => x.id === Number(check.dataset.check));
    if (!t) return;
    const myRow = t.task_assignees.find((a) => a.user_id === state.me.id);
    const currentlyOn = t.completed_at || (t.assign_mode === "each" && myRow?.done_at);
    check.classList.toggle("on", !currentlyOn);
    const { error } = await sb.rpc("set_done", { p_task: t.id, p_done: !currentlyOn });
    if (error) toast(friendlyError(error));
    else if (!currentlyOn) {
      const waiting = t.assign_mode === "each" && t.task_assignees.length > 1
        && !t.task_assignees.every((a) => a.done_at || a.user_id === state.me.id);
      toast(waiting ? "סימנת שסיימת ✓ מחכים לשני"
        : t.repeat_kind ? "כל הכבוד! ✓ 🔁 הפעם הבאה כבר ברשימה" : "כל הכבוד! ✓");
    }
    await loadAll();
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open) openTask(state.tasks.find((x) => x.id === Number(open.dataset.open)));
});

function upcomingExams() {
  return state.exams.filter((x) => daysUntil(x.exam_date) >= 0);
}

function renderExams() {
  const upcoming = upcomingExams();
  const past = state.exams.filter((x) => daysUntil(x.exam_date) < 0).reverse().slice(0, 30);
  const card = (x) => {
    const n = daysUntil(x.exam_date);
    const whose = x.owner_id === null ? "👥 שנינו" : x.owner_id === state.me.id ? "👤 שלי" : `👤 ${esc(nameOf(x.owner_id))}`;
    const cls = n < 0 ? "past" : n <= 1 ? "soon" : n <= 7 ? "week" : "";
    return `<li class="exam ${cls}" data-exam="${x.id}">
      <div class="countdown"><b>${n >= 0 ? n : "✓"}</b><span>${n >= 0 ? (n === 1 ? "יום" : "ימים") : ""}</span></div>
      <div class="exam-main">
        <div class="task-title">${esc(x.subject)}</div>
        <div class="meta"><span class="tag ${cls}">${esc(inDays(n))}</span><span class="tag">📅 ${esc(fmtExamDate(x.exam_date, x.exam_time))}</span><span class="tag">${whose}</span></div>
        ${x.notes ? `<div class="task-notes">${esc(x.notes)}</div>` : ""}
      </div>
    </li>`;
  };
  $("#exam-list").innerHTML = upcoming.map(card).join("");
  $("#exam-empty").hidden = upcoming.length > 0;
  $("#past-exam-list").innerHTML = past.map(card).join("");
  $("#past-exams").hidden = past.length === 0;
  $("#subjects").innerHTML = [...new Set(state.exams.map((x) => x.subject))].map((s) => `<option value="${esc(s)}">`).join("");
}

for (const list of ["#exam-list", "#past-exam-list"]) {
  $(list).addEventListener("click", (e) => {
    const li = e.target.closest("[data-exam]");
    if (li) openExam(state.exams.find((x) => x.id === Number(li.dataset.exam)));
  });
}

// ================================================================ טופס משימה

function segValue(seg) {
  return $(".on", seg)?.dataset.value;
}
function setSeg(seg, value) {
  for (const b of $$("button", seg)) b.classList.toggle("on", b.dataset.value === value);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".seg button");
  if (!b || b.disabled) return;
  setSeg(b.parentElement, b.dataset.value);
  if (b.parentElement.id === "assign-seg") updateAssignHelp();
});

const ASSIGN_HELP = {
  me: "רק את/ה צריך/ה לבצע.",
  other: "רק השני צריך לבצע. גם את/ה יכול/ה לסמן שבוצע.",
  either: "מספיק שאחד מכם יבצע – מי שמסמן ראשון סוגר את המשימה.",
  each: "כל אחד מכם צריך לבצע. המשימה נסגרת רק כששניכם סימנתם.",
};
function updateAssignHelp() {
  $("#assign-help").textContent = ASSIGN_HELP[segValue($("#assign-seg"))] ?? "";
}

function buildAssignSeg() {
  const hasOther = Boolean(state.other);
  $("#assign-seg").innerHTML = `
    <button type="button" data-value="me">אני</button>
    <button type="button" data-value="other" ${hasOther ? "" : "disabled"}>${esc(otherName())}</button>
    <button type="button" data-value="either" ${hasOther ? "" : "disabled"}>שנינו – מי שיספיק</button>
    <button type="button" data-value="each" ${hasOther ? "" : "disabled"}>שנינו – כל אחד</button>`;
}

function assignKeyOf(t) {
  const ids = t.task_assignees.map((a) => a.user_id);
  if (ids.length > 1) return t.assign_mode;
  return ids[0] === state.me.id ? "me" : "other";
}

function openTask(t) {
  state.editingTask = t ?? null;
  const f = $("#task-form");
  f.reset();
  buildAssignSeg();
  $("#task-dialog-title").textContent = t ? "עריכת משימה" : "משימה חדשה";
  $("#task-delete").hidden = !t;
  $("#task-error").hidden = true;
  f.elements.title.value = t?.title ?? "";
  f.notes.value = t?.notes ?? "";
  setSeg($("[data-name=urgency]", f), t?.urgency ?? "medium");
  setSeg($("#assign-seg"), t ? assignKeyOf(t) : (state.other ? "either" : "me"));
  updateAssignHelp();
  f.due_at.value = toLocalInput(t?.due_at);
  f.reminder_at.value = toLocalInput(t?.reminder_at);
  f.stale_days.value = t ? (t.stale_days ?? "") : "3";
  // משימה קבועה
  f.repeat.value = repeatOptionOf(t);
  f.repeat_every.value = t?.repeat_every > 1 ? t.repeat_every : 2;
  setRepeatDays(t?.repeat_weekdays ?? []);
  updateRepeatUI(false);
  $("#task-dialog").showModal();
  if (!t) setTimeout(() => f.elements.title.focus(), 50);
}

// ---------------------------------------------------------------- משימה קבועה
const DAY_NAMES = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

function repeatDays() {
  return $$("#repeat-days button.on").map((b) => Number(b.dataset.day));
}
function setRepeatDays(days) {
  for (const b of $$("#repeat-days button")) b.classList.toggle("on", days.includes(Number(b.dataset.day)));
}

// אפשרויות בתפריט -> מה נשמר במסד (repeat_kind + האם בוחרים "כל כמה")
const REPEAT_OPTIONS = {
  daily:    { kind: "daily" },
  interval: { kind: "daily",   every: { unit: "ימים",   max: 365 } },
  weekly:   { kind: "weekly" },
  monthly:  { kind: "monthly" },
  months:   { kind: "monthly", every: { unit: "חודשים", max: 24 } },
  yearly:   { kind: "yearly" },
  years:    { kind: "yearly",  every: { unit: "שנים",   max: 10 } },
};

/** איזו אפשרות בתפריט מתאימה למשימה שמורה */
function repeatOptionOf(t) {
  if (!t?.repeat_kind) return "";
  const many = t.repeat_every > 1;
  if (t.repeat_kind === "daily") return many ? "interval" : "daily";
  if (t.repeat_kind === "monthly") return many ? "months" : "monthly";
  if (t.repeat_kind === "yearly") return many ? "years" : "yearly";
  return t.repeat_kind;
}

/** טקסט קצר לחוק החזרה, למשל "כל שבוע (א׳, ד׳)" */
function repeatText(t) {
  if (!t.repeat_kind) return "";
  const n = t.repeat_every;
  if (t.repeat_kind === "daily") return n > 1 ? `כל ${n} ימים` : "כל יום";
  if (t.repeat_kind === "monthly") return n > 1 ? `כל ${n} חודשים` : "כל חודש";
  if (t.repeat_kind === "yearly") return n > 1 ? `כל ${n} שנים` : "כל שנה";
  const days = (t.repeat_weekdays ?? []).slice().sort();
  return days.length ? `כל שבוע (${days.map((d) => DAY_NAMES[d]).join(", ")})` : "כל שבוע";
}

function updateRepeatUI(autofill) {
  const f = $("#task-form");
  const v = f.repeat.value;
  const every = REPEAT_OPTIONS[v]?.every;
  $("#repeat-every-row").hidden = !every;
  if (every) {
    $("#repeat-unit").textContent = every.unit;
    f.repeat_every.max = every.max;
    if (Number(f.repeat_every.value) > every.max) f.repeat_every.value = every.max;
  }
  $("#repeat-days").hidden = v !== "weekly";
  $("#due-label").textContent = v ? "תאריך יעד" : "תאריך תפוגה";
  $("#due-optional").textContent = v ? "(לפעם הראשונה)" : "(לא חובה)";

  if (autofill && v) {
    // למשימה קבועה צריך מועד ראשון. אם אין – היום ב-23:59 (או היום הקרוב שנבחר)
    if (!f.due_at.value && !f.reminder_at.value) {
      const d = new Date();
      d.setHours(23, 59, 0, 0);
      f.due_at.value = toLocalInput(d);
    }
    if (v === "weekly" && repeatDays().length === 0) {
      setRepeatDays([new Date(f.due_at.value || f.reminder_at.value || Date.now()).getDay()]);
    }
  }

  const help = $("#repeat-help");
  help.hidden = !v;
  help.textContent = "כשמסמנים שבוצעה, נוצרת אוטומטית הפעם הבאה – עם אותם משויכים, והתפוגה והתזכורת זזות בהתאם.";
}

$("#task-form [name=repeat]").addEventListener("change", () => updateRepeatUI(true));
$("#repeat-days").addEventListener("click", (e) => {
  const b = e.target.closest("[data-day]");
  if (b) b.classList.toggle("on");
});

function preset(kind) {
  const d = new Date();
  const at = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x; };
  switch (kind) {
    case "tonight": return at(0, 23, 59);
    case "tomorrow-eve": return at(1, 20);
    case "week": return at(7, 20);
    case "hour": d.setMinutes(d.getMinutes() + 60, 0, 0); return d;
    case "evening": return d.getHours() >= 20 ? at(1, 20) : at(0, 20);
    case "morning": return at(1, 8);
  }
}
for (const q of $$(".quick")) {
  q.addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (b) $(`[name=${q.dataset.for}]`, q.closest("form")).value = toLocalInput(preset(b.dataset.preset));
  });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-clear]");
  if (b) $(`[name=${b.dataset.clear}]`, b.closest("form")).value = "";
});

$("#task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.submitter?.value !== "save") { $("#task-dialog").close(); return; }
  const f = e.target;
  const assign = segValue($("#assign-seg"));
  const assignees = assign === "me" ? [state.me.id]
    : assign === "other" ? [state.other?.id]
      : [state.me.id, state.other?.id];
  const due = fromLocalInput(f.due_at.value);
  const reminder = fromLocalInput(f.reminder_at.value);
  if (due && reminder && new Date(reminder) > new Date(due)) {
    return showError("#task-error", "התזכורת אחרי תאריך התפוגה – כדאי להקדים אותה.");
  }
  const repeat = f.repeat.value;
  if (repeat && !due && !reminder) {
    return showError("#task-error", "למשימה קבועה צריך תאריך יעד או תזכורת לפעם הראשונה.");
  }
  if (repeat === "weekly" && repeatDays().length === 0) {
    return showError("#task-error", "בחרו באילו ימים בשבוע המשימה חוזרת.");
  }
  const opt = REPEAT_OPTIONS[repeat];
  const every = opt?.every ? Math.min(opt.every.max, Math.max(2, Number(f.repeat_every.value) || 2)) : 1;
  const save = $("#task-save");
  save.disabled = true;
  const { data: id, error } = await sb.rpc("save_task", {
    p_id: state.editingTask?.id ?? null,
    p_title: f.elements.title.value,
    p_notes: f.notes.value,
    p_urgency: segValue($("[data-name=urgency]", f)),
    p_assign_mode: assign === "each" ? "each" : "either",
    p_assignees: assignees.filter(Boolean),
    p_due_at: due,
    p_reminder_at: reminder,
    p_stale_days: f.stale_days.value ? Number(f.stale_days.value) : null,
    p_repeat_kind: opt?.kind ?? null,
    p_repeat_every: every,
    p_repeat_weekdays: repeat === "weekly" ? repeatDays() : null,
  });
  save.disabled = false;
  if (error) return showError("#task-error", friendlyError(error));
  $("#task-dialog").close();
  toast(state.editingTask ? "המשימה עודכנה" : (state.other ? `נוספה ✓ ${otherName()} יקבל/תקבל התראה` : "המשימה נוספה ✓"));
  await loadAll();
  if (state.filter === "done") { state.filter = "open"; renderTasks(); }
  document.getElementById(`task-${id}`)?.classList.add("flash");
});

$("#task-delete").addEventListener("click", async () => {
  const t = state.editingTask;
  if (!t || !confirm(`למחוק את "${t.title}"?`)) return;
  const { error } = await sb.from("tasks").delete().eq("id", t.id);
  if (error) return showError("#task-error", friendlyError(error));
  $("#task-dialog").close();
  toast("המשימה נמחקה");
  loadAll();
});

function showError(sel, msg) {
  $(sel).textContent = msg;
  $(sel).hidden = false;
}

// ================================================================ טופס מבחן

function openExam(x) {
  state.editingExam = x ?? null;
  const f = $("#exam-form");
  f.reset();
  $("#owner-seg").innerHTML = `
    <button type="button" data-value="me">שלי</button>
    ${state.other ? `<button type="button" data-value="other">של ${esc(otherName())}</button>` : ""}
    <button type="button" data-value="both">של שנינו</button>`;
  const ownerKey = !x ? "me" : x.owner_id === null ? "both" : x.owner_id === state.me.id ? "me" : "other";
  setSeg($("#owner-seg"), ownerKey);
  $("#exam-dialog-title").textContent = x ? "עריכת מבחן" : "מבחן חדש";
  $("#exam-delete").hidden = !x;
  $("#exam-error").hidden = true;
  f.subject.value = x?.subject ?? "";
  f.exam_date.value = x?.exam_date ?? "";
  f.exam_time.value = x?.exam_time?.slice(0, 5) ?? "";
  f.notes.value = x?.notes ?? "";
  $("#exam-dialog").showModal();
  if (!x) setTimeout(() => f.subject.focus(), 50);
}

$("#exam-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.submitter?.value !== "save") { $("#exam-dialog").close(); return; }
  const f = e.target;
  const owner = segValue($("#owner-seg"));
  const row = {
    subject: f.subject.value.trim(),
    exam_date: f.exam_date.value,
    exam_time: f.exam_time.value || null,
    owner_id: owner === "both" ? null : owner === "other" ? state.other?.id : state.me.id,
    notes: f.notes.value.trim() || null,
  };
  const q = state.editingExam
    ? sb.from("exams").update(row).eq("id", state.editingExam.id)
    : sb.from("exams").insert(row);
  const { error } = await q;
  if (error) return showError("#exam-error", friendlyError(error));
  $("#exam-dialog").close();
  toast(state.editingExam ? "המבחן עודכן" : "המבחן נוסף ✓ בהצלחה!");
  loadAll();
});

$("#exam-delete").addEventListener("click", async () => {
  const x = state.editingExam;
  if (!x || !confirm(`למחוק את המבחן ב${x.subject}?`)) return;
  const { error } = await sb.from("exams").delete().eq("id", x.id);
  if (error) return showError("#exam-error", friendlyError(error));
  $("#exam-dialog").close();
  toast("המבחן נמחק");
  loadAll();
});

// סגירת חלון בלחיצה על הרקע
for (const d of $$("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

// ================================================================ הגדרות

function renderSettings() {
  const nameInput = $("#name-form [name=display_name]");
  if (document.activeElement !== nameInput) nameInput.value = state.me.display_name ?? "";
  $("#partner-line").textContent = state.other
    ? `משתפים עם: ${state.other.display_name}`
    : state.me.is_admin
      ? "עוד אין משתמש שני. הוסיפו אותו בפאנל הניהול."
      : "עוד אין משתמש שני.";
  $("#admin-card").hidden = !state.me.is_admin;
  renderPushStatus();
}

// ================================================================ פאנל ניהול

let adminUsers = [];
let adminMax = 2;

async function adminCall(action, payload = {}) {
  const { data, error } = await sb.functions.invoke("admin", { body: { action, ...payload } });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* נשאר הודעה כללית */ }
    throw new Error(msg);
  }
  return data;
}

function genPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

$("#admin-open").addEventListener("click", () => {
  $("#admin-dialog").showModal();
  loadAdmin();
});
$("#admin-refresh").addEventListener("click", loadAdmin);
$("#admin-gen-pass").addEventListener("click", () => { $("#admin-add [name=password]").value = genPassword(); });

async function loadAdmin() {
  $("#admin-loading").hidden = false;
  $("#admin-loading").textContent = "טוען…";
  try {
    const res = await adminCall("list");
    adminUsers = res.users;
    adminMax = res.max;
    $("#admin-loading").hidden = true;
  } catch (err) {
    $("#admin-loading").textContent = friendlyError(err);
  }
  renderAdmin();
}

function renderAdmin() {
  $("#admin-users-title").textContent = `משתמשים (${adminUsers.length}/${adminMax})`;
  $("#admin-users").innerHTML = adminUsers.map((u) => {
    const self = u.id === state.me.id;
    const devices = u.devices.length
      ? u.devices.map((d) => `
          <li class="device">
            <span>📱 ${esc(deviceName(d.user_agent))} · ${esc(fmtWhen(d.created_at))}</span>
            <button class="link danger-text" data-act="device" data-id="${d.id}" type="button">הסרה</button>
          </li>`).join("")
      : `<li class="device muted">אין מכשיר עם התראות</li>`;
    return `
      <li class="card admin-user" data-id="${esc(u.id)}">
        <div class="admin-user-head">
          <strong>${esc(u.display_name ?? "—")}</strong>
          ${u.is_admin ? `<span class="tag">מנהל</span>` : ""}
          ${self ? `<span class="tag subtle">את/ה</span>` : ""}
        </div>
        <div class="muted small" dir="ltr">${esc(u.email)}</div>
        <div class="muted small">כניסה אחרונה: ${u.last_sign_in_at ? esc(fmtWhen(u.last_sign_in_at)) : "עוד לא נכנס/ה"}</div>
        <ul class="devices">${devices}</ul>
        <div class="row wrap">
          <button class="btn" data-act="rename" type="button">שינוי שם</button>
          <button class="btn" data-act="password" type="button">סיסמה חדשה</button>
          ${self ? "" : `<button class="btn danger-text" data-act="delete" type="button">מחיקה</button>`}
        </div>
      </li>`;
  }).join("");

  $("#admin-add").hidden = adminUsers.length >= adminMax;

  const open = state.tasks.filter((t) => !t.completed_at).length;
  const done = state.tasks.length - open;
  const today = todayStr();
  const pastExams = state.exams.filter((x) => x.exam_date < today).length;
  $("#admin-stats").textContent =
    `${open} משימות פתוחות · ${done} שבוצעו · ${state.exams.length - pastExams} מבחנים קרובים · ${pastExams} שעברו`;
  $("#admin-clear-done").disabled = done === 0;
  $("#admin-clear-exams").disabled = pastExams === 0;
}

function deviceName(ua = "") {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad|Macintosh.*Mobile/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh/.test(ua)) return "Mac";
  return "מכשיר";
}

$("#admin-users").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const u = adminUsers.find((x) => x.id === btn.closest("[data-id]")?.dataset.id);
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === "rename") {
      const name = prompt("שם חדש:", u.display_name ?? "")?.trim();
      if (!name) return;
      if (name.length > 40) throw new Error("השם ארוך מדי (עד 40 תווים)");
      const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", u.id);
      if (error) throw error;
      toast("השם עודכן");
      await Promise.all([loadAdmin(), loadAll()]);
    } else if (act === "password") {
      const pass = prompt(`סיסמה חדשה ל-${u.display_name} (לפחות 6 תווים):`, genPassword());
      if (pass === null) return;
      await adminCall("reset_password", { user_id: u.id, password: pass });
      toast("הסיסמה עודכנה. שלחו אותה לו/ה.");
    } else if (act === "delete") {
      const ok = confirm(
        `למחוק את ${u.display_name} (${u.email})?\n\n` +
        "• החשבון נמחק ואי אפשר לבטל.\n" +
        "• משימות שמשויכות רק אליו/ה יימחקו, וגם מבחנים שלו/ה.\n" +
        "• משימות משותפות ומשימות שהוא/היא יצר/ה בשבילך נשארות.");
      if (!ok) return;
      const res = await adminCall("delete", { user_id: u.id });
      toast(res.tasks_removed ? `נמחק. הוסרו גם ${res.tasks_removed} משימות שלו/ה.` : "המשתמש נמחק");
      await Promise.all([loadAdmin(), loadAll()]);
    } else if (act === "device") {
      if (!confirm("להסיר את המכשיר הזה? הוא יפסיק לקבל התראות עד שיפעילו אותן שוב.")) return;
      const { error } = await sb.from("push_subscriptions").delete().eq("id", Number(btn.dataset.id));
      if (error) throw error;
      toast("המכשיר הוסר");
      await loadAdmin();
    }
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$("#admin-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector("[type=submit]");
  btn.disabled = true;
  $("#admin-add-error").hidden = true;
  try {
    await adminCall("create", {
      display_name: f.elements.display_name.value.trim(),
      email: f.elements.email.value.trim(),
      password: f.elements.password.value,
    });
    toast("החשבון נוצר");
    f.reset();
    await Promise.all([loadAdmin(), loadAll()]);
  } catch (err) {
    showError("#admin-add-error", friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$("#admin-clear-done").addEventListener("click", async () => {
  const n = state.tasks.filter((t) => t.completed_at).length;
  if (!confirm(`למחוק ${n} משימות שבוצעו? אי אפשר לבטל.`)) return;
  const { error } = await sb.from("tasks").delete().not("completed_at", "is", null);
  if (error) return toast(friendlyError(error));
  toast("המשימות שבוצעו נמחקו");
  await loadAll();
  renderAdmin();
});

$("#admin-clear-exams").addEventListener("click", async () => {
  const today = todayStr();
  const n = state.exams.filter((x) => x.exam_date < today).length;
  if (!confirm(`למחוק ${n} מבחנים שעברו? אי אפשר לבטל.`)) return;
  const { error } = await sb.from("exams").delete().lt("exam_date", today);
  if (error) return toast(friendlyError(error));
  toast("המבחנים שעברו נמחקו");
  await loadAll();
  renderAdmin();
});

$("#name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.display_name.value.trim();
  const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", state.me.id);
  if (error) return toast(friendlyError(error));
  toast("השם נשמר");
  loadAll();
});

// ================================================================ התראות Push

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => (swReg = r)).catch((e) => console.warn("sw", e));
}

function urlB64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = swReg ?? await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from("push_subscriptions").upsert({
    user_id: state.me.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200),
  }, { onConflict: "endpoint" });
  if (error) throw error;
}

// בכל פתיחה: אם כבר יש הרשאה, מוודאים שהמנוי שמור בשרת
async function syncPushSubscription() {
  try {
    if (!pushSupported || Notification.permission !== "granted") return renderPushStatus();
    let sub = await currentSubscription();
    if (!sub) {
      const reg = await navigator.serviceWorker.ready;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    }
    await saveSubscription(sub);
  } catch (e) {
    console.warn("push sync", e);
  }
  renderPushStatus();
}

async function renderPushStatus() {
  const status = $("#push-status");
  const enable = $("#push-enable"), disable = $("#push-disable"), test = $("#push-test"), bell = $("#bell");
  $("#ios-help").hidden = !(isIOS && !isStandalone);
  if (!pushSupported) {
    status.textContent = isIOS && !isStandalone
      ? "כדי לקבל התראות באייפון צריך קודם להוסיף את האפליקציה למסך הבית (הוראות למטה)."
      : "הדפדפן הזה לא תומך בהתראות.";
    enable.hidden = disable.hidden = test.hidden = true;
    bell.hidden = false; bell.textContent = "🔕";
    return;
  }
  const sub = await currentSubscription().catch(() => null);
  const on = Notification.permission === "granted" && sub;
  if (Notification.permission === "denied") {
    status.textContent = "ההתראות חסומות. אפשר לפתוח אותן בהגדרות הטלפון → התראות → משימות.";
  } else {
    status.textContent = on ? "ההתראות פעילות במכשיר הזה ✓" : "ההתראות כבויות במכשיר הזה.";
  }
  enable.hidden = Boolean(on) || Notification.permission === "denied";
  disable.hidden = test.hidden = !on;
  bell.hidden = false;
  bell.textContent = on ? "🔔" : "🔕";
}

$("#push-enable").addEventListener("click", async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { renderPushStatus(); return toast("לא אושרו התראות"); }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) });
    await saveSubscription(sub);
    toast("ההתראות הופעלו 🔔");
  } catch (e) {
    toast(friendlyError(e));
  }
  renderPushStatus();
});

$("#push-disable").addEventListener("click", async () => {
  const sub = await currentSubscription();
  if (sub) {
    await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  toast("ההתראות כובו במכשיר הזה");
  renderPushStatus();
});

$("#push-test").addEventListener("click", async () => {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("בדיקה ✓", { body: "ככה ייראו ההתראות", icon: "icons/icon-192.png", lang: "he", dir: "rtl" });
});

$("#bell").addEventListener("click", () => setTab("settings"));
