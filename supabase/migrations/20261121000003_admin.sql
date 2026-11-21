-- פאנל ניהול: מנהל אחד יוצר/מוחק משתמשים, מאפס סיסמאות, משנה שמות ומנקה תוכן.
-- אימייל המנהל נשמר ב-app_config (key = 'admin_email') ולא בקוד, כי הריפו ציבורי.

-- ---------------------------------------------------------------- מנהל
alter table public.profiles add column is_admin boolean not null default false;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------- הרשמה סגורה
-- אפשר להירשם רק: (1) המנהל עצמו, באימייל שהוגדר, או (2) חשבון שהמנהל יצר (app_metadata.created_by_admin).
-- app_metadata אי אפשר לקבוע מהדפדפן, רק מהשרת.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_admin_email text := lower(trim((select c.value from public.app_config c where c.key = 'admin_email')));
  v_is_admin    boolean := v_admin_email is not null and lower(new.email) = v_admin_email;
begin
  if not v_is_admin and coalesce(new.raw_app_meta_data->>'created_by_admin', '') <> 'true' then
    raise exception 'SIGNUP_CLOSED: רק המנהל יכול ליצור חשבונות';
  end if;
  if (select count(*) from public.profiles) >= 2 then
    raise exception 'APP_FULL: האפליקציה כבר מלאה (שני משתמשים)';
  end if;
  insert into public.profiles (id, display_name, is_admin)
  values (new.id,
          coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), split_part(new.email, '@', 1)),
          v_is_admin);
  return new;
end $$;

-- האם מסך הכניסה צריך להציע "יצירת חשבון מנהל" (מוגדר אימייל מנהל, ועוד אין לו חשבון)
create function public.admin_setup_open() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_config c where c.key = 'admin_email')
     and not exists (
       select 1 from auth.users u
       where lower(u.email) = lower(trim((select c.value from public.app_config c where c.key = 'admin_email'))));
$$;
revoke execute on function public.admin_setup_open() from public;
grant execute on function public.admin_setup_open() to anon, authenticated;

-- ---------------------------------------------------------------- הרשאות על פרופילים
-- משתמש רגיל משנה רק את השם של עצמו; המנהל משנה כל שם. is_admin לא ניתן לשינוי מהדפדפן.
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

drop policy "profiles update" on public.profiles;
create policy "profiles update" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- המנהל רואה ומוחק מכשירי התראות של כולם
create policy "admin reads push subs" on public.push_subscriptions for select to authenticated
  using (public.is_admin());
create policy "admin deletes push subs" on public.push_subscriptions for delete to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------- מחיקת משתמש לא מוחקת את מה שהוא יצר
alter table public.tasks alter column created_by drop not null;
alter table public.tasks drop constraint tasks_created_by_fkey;
alter table public.tasks add constraint tasks_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

alter table public.exams alter column created_by drop not null;
alter table public.exams drop constraint exams_created_by_fkey;
alter table public.exams add constraint exams_created_by_fkey
  foreign key (created_by) references public.profiles(id) on delete set null;

-- לפני מחיקת משתמש (נקרא מפונקציית admin עם מפתח השרת):
-- משימות שמשויכות רק אליו נמחקות; משימות משותפות נשארות לשני.
create function public.admin_before_delete_user(p_uid uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  delete from public.tasks t
  where exists (select 1 from public.task_assignees a where a.task_id = t.id and a.user_id = p_uid)
    and not exists (select 1 from public.task_assignees a where a.task_id = t.id and a.user_id <> p_uid);
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.admin_before_delete_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_before_delete_user(uuid) to service_role;
