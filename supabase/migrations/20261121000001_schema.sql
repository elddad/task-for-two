-- משימות ומבחנים לשניים: טבלאות, הרשאות, טריגרים ותזמון

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------- config
-- כתובת ה-Edge Functions. מתמלא במיגרציה 002 (לא סודי). רק השרת יכול לקרוא.
create table public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
);

-- פרופיל נוצר אוטומטית בהרשמה. האפליקציה לשני אנשים בלבד: נרשם שלישי -> ההרשמה נכשלת.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.profiles) >= 2 then
    raise exception 'APP_FULL: האפליקציה כבר מלאה (שני משתמשים)';
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- tasks
create table public.tasks (
  id            bigint generated always as identity primary key,
  title         text not null check (length(trim(title)) between 1 and 200),
  notes         text check (notes is null or length(notes) <= 2000),
  urgency       text not null default 'medium' check (urgency in ('low', 'medium', 'high', 'urgent')),
  -- either = מספיק שאחד מהמשויכים יבצע, each = כל משויך צריך לבצע
  assign_mode   text not null default 'either' check (assign_mode in ('either', 'each')),
  created_by    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),
  due_at        timestamptz,  -- תפוגה
  reminder_at   timestamptz,  -- תזכורת
  stale_days    int default 3 check (stale_days is null or stale_days between 1 and 60),  -- "לא בוצע הרבה זמן"
  completed_at  timestamptz,
  completed_by  uuid references public.profiles(id) on delete set null,
  -- משימה קבועה: כשמסיימים אותה נוצרת אוטומטית הפעם הבאה
  repeat_kind     text check (repeat_kind is null or repeat_kind in ('daily', 'weekly', 'monthly')),
  repeat_every    int not null default 1 check (repeat_every between 1 and 365),  -- daily: כל X ימים
  repeat_weekdays smallint[],  -- weekly: 0=ראשון ... 6=שבת
  series_id       bigint,      -- המשימה הראשונה בסדרה
  next_task_id    bigint,      -- הפעם הבאה שכבר נוצרה (כדי לא ליצור פעמיים)
  -- מעקב התראות שנשלחו (כדי לא לשלוח פעמיים)
  notified_at              timestamptz,
  done_notified_at         timestamptz,
  reminder_sent_at         timestamptz,
  expiry_warned_at         timestamptz,
  expiry_urgent_warned_at  timestamptz,
  expired_notified_at      timestamptz,
  last_stale_nudge_at      timestamptz
);
create index tasks_open_idx on public.tasks (completed_at) where completed_at is null;

create table public.task_assignees (
  task_id  bigint not null references public.tasks(id) on delete cascade,
  user_id  uuid   not null references public.profiles(id) on delete cascade,
  done_at  timestamptz,
  primary key (task_id, user_id)
);

-- כששדה זמן משתנה, מאפסים את סימון ההתראה המתאימה כדי שתישלח מחדש
create function public.tasks_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.reminder_at is distinct from old.reminder_at then
    new.reminder_sent_at := null;
  end if;
  if new.due_at is distinct from old.due_at then
    new.expiry_warned_at := null;
    new.expiry_urgent_warned_at := null;
    new.expired_notified_at := null;
  end if;
  if new.completed_at is null and old.completed_at is not null then
    new.done_notified_at := null;
    new.completed_by := null;
  end if;
  return new;
end $$;

create trigger tasks_before_update
  before update on public.tasks
  for each row execute function public.tasks_before_update();

-- ---------------------------------------------------------------- משימות קבועות
-- המועד הבא אחרי p_base לפי החוק, לפי שעון ישראל, ותמיד בעתיד (מדלג על מועדים שהוחמצו)
create function public.next_occurrence(p_base timestamptz, p_kind text, p_every int, p_weekdays smallint[])
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  tz      constant text := 'Asia/Jerusalem';
  v_local timestamp := p_base at time zone tz;
  v_next  timestamp := v_local;
  v_every int := greatest(coalesce(p_every, 1), 1);
  i       int := 0;
begin
  loop
    i := i + 1;
    if i > 2000 then return null; end if;
    if p_kind = 'daily' then
      v_next := v_local + make_interval(days => i * v_every);
    elsif p_kind = 'monthly' then
      v_next := v_local + make_interval(months => i);  -- 31 בחודש -> היום האחרון בחודשים קצרים
    elsif p_kind = 'weekly' then
      if coalesce(array_length(p_weekdays, 1), 0) = 0 then
        v_next := v_local + make_interval(weeks => i);
      else
        v_next := v_local + make_interval(days => i);
        continue when not (extract(dow from v_next)::smallint = any (p_weekdays));
      end if;
    else
      return null;
    end if;
    exit when (v_next at time zone tz) > now();
  end loop;
  return v_next at time zone tz;
end $$;

-- יוצר את הפעם הבאה של משימה קבועה (פעם אחת בלבד), עם אותם משויכים,
-- ומזיז את התפוגה והתזכורת באותו פער לפי שעון הקיר בישראל
create function public.spawn_next(p_id bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  tz      constant text := 'Asia/Jerusalem';
  t       public.tasks;
  v_base  timestamptz;
  v_next  timestamptz;
  v_shift interval;
  v_new   bigint;
begin
  select * into t from public.tasks where id = p_id for update;
  if not found or t.repeat_kind is null or t.next_task_id is not null then return null; end if;

  v_base := coalesce(t.due_at, t.reminder_at);
  if v_base is null then return null; end if;
  v_next := public.next_occurrence(v_base, t.repeat_kind, t.repeat_every, t.repeat_weekdays);
  if v_next is null then return null; end if;
  v_shift := (v_next at time zone tz) - (v_base at time zone tz);

  insert into public.tasks (title, notes, urgency, assign_mode, created_by, due_at, reminder_at, stale_days,
                            repeat_kind, repeat_every, repeat_weekdays, series_id, notified_at)
  values (t.title, t.notes, t.urgency, t.assign_mode, t.created_by,
          case when t.due_at is null then null else ((t.due_at at time zone tz) + v_shift) at time zone tz end,
          case when t.reminder_at is null then null else ((t.reminder_at at time zone tz) + v_shift) at time zone tz end,
          t.stale_days, t.repeat_kind, t.repeat_every, t.repeat_weekdays, coalesce(t.series_id, t.id),
          now())  -- notified_at: לא שולחים "משימה חדשה" על כל חזרה
  returning id into v_new;

  insert into public.task_assignees (task_id, user_id)
  select v_new, user_id from public.task_assignees where task_id = p_id;

  update public.tasks set next_task_id = v_new where id = p_id;
  return v_new;
end $$;
revoke execute on function public.spawn_next(bigint) from public, anon, authenticated;

-- מחשב אם המשימה גמורה לפי מצב השיוך
create function public.recompute_task(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_mode  text;
  v_total int;
  v_done  int;
  v_last  timestamptz;
  v_by    uuid;
begin
  select assign_mode into v_mode from public.tasks where id = p_id;
  if not found then return; end if;

  select count(*), count(done_at), max(done_at)
    into v_total, v_done, v_last
    from public.task_assignees where task_id = p_id;

  select user_id into v_by from public.task_assignees
   where task_id = p_id and done_at is not null
   order by done_at desc limit 1;

  if v_total > 0 and ((v_mode = 'either' and v_done > 0) or (v_mode = 'each' and v_done = v_total)) then
    update public.tasks set completed_at = v_last, completed_by = v_by
     where id = p_id and completed_at is null;
    if found then
      perform public.spawn_next(p_id);  -- משימה קבועה -> הפעם הבאה
    end if;
  else
    update public.tasks set completed_at = null
     where id = p_id and completed_at is not null;
  end if;
end $$;

create function public.task_assignees_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.recompute_task(coalesce(new.task_id, old.task_id));
  return null;
end $$;

create trigger task_assignees_changed
  after insert or update or delete on public.task_assignees
  for each row execute function public.task_assignees_changed();

-- יצירה/עריכה של משימה + המשויכים בפעולה אחת
create function public.save_task(
  p_id          bigint,
  p_title       text,
  p_notes       text,
  p_urgency     text,
  p_assign_mode text,
  p_assignees   uuid[],
  p_due_at      timestamptz,
  p_reminder_at timestamptz,
  p_stale_days  int,
  p_repeat_kind     text default null,
  p_repeat_every    int default 1,
  p_repeat_weekdays smallint[] default null
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare v_id bigint;
begin
  if p_assignees is null or coalesce(array_length(p_assignees, 1), 0) = 0 then
    raise exception 'צריך לבחור למי המשימה';
  end if;
  if p_repeat_kind is not null and p_due_at is null and p_reminder_at is null then
    raise exception 'למשימה קבועה צריך תאריך יעד או תזכורת';
  end if;

  if p_id is null then
    insert into public.tasks (title, notes, urgency, assign_mode, due_at, reminder_at, stale_days,
                              repeat_kind, repeat_every, repeat_weekdays)
    values (trim(p_title), nullif(trim(p_notes), ''), p_urgency, p_assign_mode, p_due_at, p_reminder_at, p_stale_days,
            p_repeat_kind, coalesce(p_repeat_every, 1), p_repeat_weekdays)
    returning id into v_id;
  else
    update public.tasks
       set title = trim(p_title), notes = nullif(trim(p_notes), ''), urgency = p_urgency,
           assign_mode = p_assign_mode, due_at = p_due_at, reminder_at = p_reminder_at,
           stale_days = p_stale_days, repeat_kind = p_repeat_kind,
           repeat_every = coalesce(p_repeat_every, 1), repeat_weekdays = p_repeat_weekdays
     where id = p_id
    returning id into v_id;
    if v_id is null then raise exception 'המשימה לא נמצאה'; end if;
    delete from public.task_assignees where task_id = v_id and not (user_id = any (p_assignees));
  end if;

  insert into public.task_assignees (task_id, user_id)
  select v_id, u from unnest(p_assignees) as u
  on conflict do nothing;

  perform public.recompute_task(v_id);
  return v_id;
end $$;

-- סימון בוצע / ביטול
-- משויך מסמן את עצמו. מי שלא משויך (למשל עשה משימה של השני) מסמן את כולה.
create function public.set_done(p_task bigint, p_done boolean) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_mode text;
  v_mine boolean;
begin
  select assign_mode into v_mode from public.tasks where id = p_task;
  if not found then raise exception 'המשימה לא נמצאה'; end if;

  select exists (select 1 from public.task_assignees where task_id = p_task and user_id = auth.uid())
    into v_mine;

  if p_done then
    if v_mine then
      update public.task_assignees set done_at = now()
       where task_id = p_task and user_id = auth.uid() and done_at is null;
    else
      update public.task_assignees set done_at = now()
       where task_id = p_task and done_at is null;
    end if;
    -- מי שלחץ הוא מי שסיים
    update public.tasks set completed_by = auth.uid()
     where id = p_task and completed_at is not null;
  else
    if v_mine and v_mode = 'each' then
      update public.task_assignees set done_at = null
       where task_id = p_task and user_id = auth.uid();
    else
      update public.task_assignees set done_at = null where task_id = p_task;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------- exams
create table public.exams (
  id                  bigint generated always as identity primary key,
  subject             text not null check (length(trim(subject)) between 1 and 100),
  exam_date           date not null,
  exam_time           time,
  owner_id            uuid references public.profiles(id) on delete cascade,  -- null = של שנינו
  notes               text check (notes is null or length(notes) <= 1000),
  created_by          uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at          timestamptz not null default now(),
  notified_at         timestamptz,
  day_before_sent_at  timestamptz
);

create function public.exams_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.exam_date is distinct from old.exam_date then
    new.day_before_sent_at := null;
  end if;
  return new;
end $$;

create trigger exams_before_update
  before update on public.exams
  for each row execute function public.exams_before_update();

-- ---------------------------------------------------------------- push subscriptions
create table public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- הרשאות API
-- מפורש, כדי שיעבוד גם כש-"Grant API access to new tables automatically" כבוי
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on
  public.profiles, public.tasks, public.task_assignees, public.exams, public.push_subscriptions
  to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on function public.save_task(bigint, text, text, text, text, uuid[], timestamptz, timestamptz, int, text, int, smallint[]) to authenticated;
grant execute on function public.set_done(bigint, boolean) to authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.profiles           enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_assignees     enable row level security;
alter table public.exams              enable row level security;
alter table public.push_subscriptions enable row level security;

-- יש רק שני משתמשים, ושניהם רואים ועורכים הכל
create policy "profiles read"   on public.profiles for select to authenticated using (true);
create policy "profiles update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy "tasks read"   on public.tasks for select to authenticated using (true);
create policy "tasks insert" on public.tasks for insert to authenticated with check (created_by = auth.uid());
create policy "tasks update" on public.tasks for update to authenticated using (true) with check (true);
create policy "tasks delete" on public.tasks for delete to authenticated using (true);

create policy "assignees all" on public.task_assignees for all to authenticated using (true) with check (true);

create policy "exams read"   on public.exams for select to authenticated using (true);
create policy "exams insert" on public.exams for insert to authenticated with check (created_by = auth.uid());
create policy "exams update" on public.exams for update to authenticated using (true) with check (true);
create policy "exams delete" on public.exams for delete to authenticated using (true);

create policy "own push subs" on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.tasks, public.task_assignees, public.exams;

-- ---------------------------------------------------------------- notifications
-- טריגר ששולח לפונקציית notify: משימה/מבחן חדשים, משימה שהושלמה.
-- pg_net שולח רק אחרי commit, אז הפונקציה רואה גם את המשויכים.
create function public.fire_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_url text;
begin
  select value into v_url from public.app_config where key = 'functions_url';
  if v_url is null then return null; end if;

  if tg_op = 'UPDATE' then
    if not (old.completed_at is null and new.completed_at is not null) then
      return null;
    end if;
    perform net.http_post(
      url  := v_url || '/notify',
      body := jsonb_build_object('table', tg_table_name, 'id', new.id, 'event', 'done'));
  else
    perform net.http_post(
      url  := v_url || '/notify',
      body := jsonb_build_object('table', tg_table_name, 'id', new.id, 'event', 'insert'));
  end if;
  return null;
end $$;

create trigger tasks_notify_insert after insert on public.tasks
  for each row execute function public.fire_notify();
create trigger tasks_notify_done after update of completed_at on public.tasks
  for each row execute function public.fire_notify();
create trigger exams_notify_insert after insert on public.exams
  for each row execute function public.fire_notify();

-- כל 5 דקות: תזכורות, תפוגה, משימות תקועות, מבחן מחר
create function public.run_cron_check() returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text;
begin
  select value into v_url from public.app_config where key = 'functions_url';
  if v_url is null then return; end if;
  perform net.http_post(url := v_url || '/cron-check', body := '{}'::jsonb);
end $$;
revoke execute on function public.run_cron_check() from public, anon, authenticated;

select cron.schedule('tasks-for-two-check', '*/5 * * * *', 'select public.run_cron_check()');
