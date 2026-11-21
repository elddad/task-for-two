-- כתובת ה-Edge Functions של הפרויקט (לא סודי)
insert into public.app_config (key, value)
values ('functions_url', 'https://edxbmfqlueuzewpvfdwb.supabase.co/functions/v1')
on conflict (key) do update set value = excluded.value;
