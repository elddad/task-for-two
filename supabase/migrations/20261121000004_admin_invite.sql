-- תיקון: יצירת משתמש מהפאנל נכשלה, כי Supabase שומר את app_metadata רק אחרי שהשורה נוצרת,
-- כך שהטריגר לא ראה את created_by_admin.
-- במקום זה: פונקציית admin (עם מפתח השרת) שומרת "הזמנה" לאימייל ל-60 שניות ב-app_config,
-- והטריגר מאשר ומוחק אותה. app_config בלי הרשאות לדפדפן, אז רק השרת יכול ליצור הזמנה.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_admin_email text := lower(trim((select c.value from public.app_config c where c.key = 'admin_email')));
  v_is_admin    boolean := v_admin_email is not null and lower(new.email) = v_admin_email;
  v_invited     boolean;
begin
  delete from public.app_config c
   where c.key = 'invite:' || lower(new.email)
  returning c.value::timestamptz > now() into v_invited;

  if not v_is_admin and not coalesce(v_invited, false) then
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
