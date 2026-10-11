-- Events can have an end time, and repeating events share a series id
-- ("robotics every Mon/Tue/Wed") so the whole run can be changed or removed together.
alter table public.events add column end_time time;
alter table public.events add column series text not null default '';
create index events_series on public.events (series) where series <> '';

create or replace function public.restore_event(ev jsonb, remove_idea text) returns void
language plpgsql as $$
begin
  perform public.require_household();
  if remove_idea is not null then delete from public.ideas where id = remove_idea; end if;
  insert into public.events (id, title, date, time, end_time, for_ids, driver, with_us, place, note, source, series)
  values (ev ->> 'id', ev ->> 'title', (ev ->> 'date')::date, public.nullif_time(ev ->> 'time'), public.nullif_time(ev ->> 'end_time'),
          public.text_array(ev -> 'for_ids'), nullif(ev ->> 'driver', ''), public.text_array(ev -> 'with_us'),
          coalesce(ev ->> 'place', ''), coalesce(ev ->> 'note', ''), coalesce(ev ->> 'source', 'manual'), coalesce(ev ->> 'series', ''))
  on conflict (id) do nothing;
end; $$;
