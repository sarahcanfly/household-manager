-- Things the household said no to stay gone. Discarding an Inbox item (or deleting a calendar
-- event that came from a feed, email or photo) remembers its title, date and time, and the next
-- feed check or email scan skips it. Moving an item to the calendar, to-dos or shelf is not a no.

create table public.dismissed (
  title      text not null,
  date       date not null,
  time       time,
  source     text not null default '',
  created_at timestamptz not null default now()
);
create unique index dismissed_key on public.dismissed (lower(title), date, time) nulls not distinct;
alter table public.dismissed enable row level security;
create policy household_all on public.dismissed for all to authenticated using (public.is_household()) with check (public.is_household());

create or replace function public.remember_dismissed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('hm.moving', true), '') = '1' then return old; end if;
  if tg_table_name = 'events' and (old.source = 'manual' or old.source = 'agent' or old.source = 'shelf' or old.source like 'sync:%') then
    return old;   -- things we typed in ourselves, or calendars that stay in step on their own
  end if;
  insert into public.dismissed (title, date, time, source) values (old.title, old.date, old.time, old.source)
  on conflict do nothing;
  return old;
end; $$;

create trigger pending_dismissed after delete on public.pending for each row execute function public.remember_dismissed();
create trigger events_dismissed after delete on public.events for each row execute function public.remember_dismissed();

-- Approving and shelving delete the Inbox row too; mark those as moves, not discards.
create or replace function public.approve_pending(p jsonb) returns text
language plpgsql as $$
declare src public.pending; new_id text;
begin
  perform public.require_household();
  select * into src from public.pending where id = p ->> 'id' for update;
  if not found then raise exception 'That item is no longer waiting.'; end if;
  if src.kind = 'task' then
    insert into public.tasks (title, due, for_ids, note, source, source_ref)
    values (
      coalesce(nullif(trim(p ->> 'title'), ''), src.title),
      coalesce(nullif(p ->> 'date', '')::date, src.date),
      case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
      coalesce(p ->> 'note', src.note),
      src.source, src.source_ref
    ) returning id into new_id;
  else
    insert into public.events (title, date, time, for_ids, driver, with_us, place, note, source)
    values (
      coalesce(nullif(trim(p ->> 'title'), ''), src.title),
      coalesce(nullif(p ->> 'date', '')::date, src.date),
      case when p ? 'time' then public.nullif_time(p ->> 'time') else src.time end,
      case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
      nullif(p ->> 'driver', ''),
      public.text_array(p -> 'with_us'),
      coalesce(p ->> 'place', src.place),
      coalesce(p ->> 'note', src.note),
      src.source
    ) returning id into new_id;
  end if;
  perform set_config('hm.moving', '1', true);
  delete from public.pending where id = src.id;
  perform set_config('hm.moving', '', true);
  insert into public.log (action, detail) values ('approvePending', new_id || ' ' || src.title);
  return new_id;
end; $$;

create or replace function public.shelve_pending(p jsonb) returns text
language plpgsql as $$
declare src public.pending; new_id text;
begin
  perform public.require_household();
  select * into src from public.pending where id = p ->> 'id' for update;
  if not found then raise exception 'That item is no longer waiting.'; end if;
  insert into public.ideas (title, date, time, for_ids, note)
  values (
    coalesce(nullif(trim(p ->> 'title'), ''), src.title),
    coalesce(nullif(p ->> 'date', '')::date, src.date),
    case when p ? 'time' then public.nullif_time(p ->> 'time') else src.time end,
    case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
    trim(both ' ' from concat_ws(' · ', nullif(src.place, ''), nullif(src.note, '')))
  ) returning id into new_id;
  perform set_config('hm.moving', '1', true);
  delete from public.pending where id = src.id;
  perform set_config('hm.moving', '', true);
  return new_id;
end; $$;

-- Staging skips anything dismissed, and anything already parked on the shelf.
create or replace function public.stage_pending(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; added int := 0; past int := 0; dupe int := 0; d date; t time; ttl text; k text;
begin
  for r in select * from jsonb_array_elements(rows) loop
    ttl := left(trim(coalesce(r ->> 'title', '')), 120);
    begin d := (r ->> 'date')::date; exception when others then continue; end;
    if ttl = '' or d is null then continue; end if;
    k := case when r ->> 'kind' = 'task' then 'task' else 'event' end;
    t := case when k = 'task' then null else public.nullif_time(r ->> 'time') end;
    if d < public.hm_today() then past := past + 1; continue; end if;
    if (k = 'event' and exists (select 1 from public.events e
                                where lower(e.title) = lower(ttl) and e.date = d and e.time is not distinct from t))
       or (k = 'task' and exists (select 1 from public.tasks x where lower(x.title) = lower(ttl) and x.due = d))
       or exists (select 1 from public.dismissed x where lower(x.title) = lower(ttl) and x.date = d and x.time is not distinct from t)
       or exists (select 1 from public.ideas i where lower(i.title) = lower(ttl) and i.date = d) then
      dupe := dupe + 1; continue;
    end if;
    insert into public.pending (title, date, time, for_ids, place, note, source, source_ref, confidence, kind)
    values (ttl, d, t, public.text_array(r -> 'for_ids'), left(coalesce(r ->> 'place', ''), 120),
            left(coalesce(r ->> 'note', ''), 500), coalesce(r ->> 'source', 'text'),
            coalesce(r ->> 'source_ref', ''), case when r ->> 'confidence' = 'low' then 'low' else 'high' end, k)
    on conflict do nothing;
    if found then added := added + 1; else dupe := dupe + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'past', past, 'dupe', dupe);
end; $$;
revoke all on function public.stage_pending(jsonb) from public, anon, authenticated;
grant execute on function public.stage_pending(jsonb) to service_role;

-- Old dismissals are no use once their date has passed.
create or replace function public.prune_dismissed() returns void language sql security definer set search_path = public as $$
  delete from public.dismissed where date < public.hm_today() - 30;
$$;
revoke all on function public.prune_dismissed() from public, anon, authenticated;
grant execute on function public.prune_dismissed() to service_role;
