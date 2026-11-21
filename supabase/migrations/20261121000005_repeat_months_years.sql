-- משימות קבועות: גם "כל X חודשים" ו"כל X שנים" (repeat_every משמש עכשיו גם לחודשים ולשנים)
alter table public.tasks drop constraint tasks_repeat_kind_check;
alter table public.tasks add constraint tasks_repeat_kind_check
  check (repeat_kind is null or repeat_kind in ('daily', 'weekly', 'monthly', 'yearly'));

create or replace function public.next_occurrence(p_base timestamptz, p_kind text, p_every int, p_weekdays smallint[])
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
      v_next := v_local + make_interval(months => i * v_every);  -- 31 בחודש -> היום האחרון בחודשים קצרים
    elsif p_kind = 'yearly' then
      v_next := v_local + make_interval(years => i * v_every);   -- 29.2 -> 28.2 בשנים רגילות
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
