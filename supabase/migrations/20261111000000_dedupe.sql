-- The same event should not be created twice. Titles match ignoring case, spacing and
-- punctuation, and a longer form of a short title is the same event ("No School" and
-- "No School: Veterans Day"). Approving or shelving a copy that is already on the
-- calendar or the shelf keeps the one already there.

create or replace function public.same_event_title(a text, b text) returns boolean
language sql immutable as $$
  with t as (
    select trim(regexp_replace(lower(coalesce(a, '')), '[^a-z0-9]+', ' ', 'g')) as x,
           trim(regexp_replace(lower(coalesce(b, '')), '[^a-z0-9]+', ' ', 'g')) as y
  )
  select x = y
     or (least(length(x), length(y)) >= 8 and (
          (length(x) < length(y) and y like x || ' %')
       or (length(y) < length(x) and x like y || ' %')))
  from t;
$$;
revoke all on function public.same_event_title(text, text) from public;
grant execute on function public.same_event_title(text, text) to authenticated, service_role;

create or replace function public.approve_pending(p jsonb) returns text
language plpgsql as $$
declare src public.pending; new_id text; ttl text; d date; t time;
begin
  perform public.require_household();
  select * into src from public.pending where id = p ->> 'id' for update;
  if not found then raise exception 'That item is no longer waiting.'; end if;
  ttl := coalesce(nullif(trim(p ->> 'title'), ''), src.title);
  d := coalesce(nullif(p ->> 'date', '')::date, src.date);
  t := case when p ? 'time' then public.nullif_time(p ->> 'time') else src.time end;
  if src.kind = 'task' then
    select x.id into new_id from public.tasks x
     where public.same_event_title(x.title, ttl) and x.due = d limit 1;
    if new_id is null then
      insert into public.tasks (title, due, for_ids, note, source, source_ref)
      values (
        ttl, d,
        case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
        coalesce(p ->> 'note', src.note),
        src.source, src.source_ref
      ) returning id into new_id;
    end if;
  else
    select e.id into new_id from public.events e
     where public.same_event_title(e.title, ttl) and e.date = d and e.time is not distinct from t
     limit 1;
    if new_id is null then
      insert into public.events (title, date, time, for_ids, driver, with_us, place, note, source)
      values (
        ttl, d, t,
        case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
        nullif(p ->> 'driver', ''),
        public.text_array(p -> 'with_us'),
        coalesce(p ->> 'place', src.place),
        coalesce(p ->> 'note', src.note),
        src.source
      ) returning id into new_id;
    end if;
  end if;
  perform set_config('hm.moving', '1', true);
  delete from public.pending where id = src.id;
  perform set_config('hm.moving', '', true);
  insert into public.log (action, detail) values ('approvePending', new_id || ' ' || src.title);
  return new_id;
end; $$;

create or replace function public.shelve_pending(p jsonb) returns text
language plpgsql as $$
declare src public.pending; new_id text; ttl text; d date; t time;
begin
  perform public.require_household();
  select * into src from public.pending where id = p ->> 'id' for update;
  if not found then raise exception 'That item is no longer waiting.'; end if;
  ttl := coalesce(nullif(trim(p ->> 'title'), ''), src.title);
  d := coalesce(nullif(p ->> 'date', '')::date, src.date);
  t := case when p ? 'time' then public.nullif_time(p ->> 'time') else src.time end;
  select i.id into new_id from public.ideas i
   where public.same_event_title(i.title, ttl) and i.date is not distinct from d
   limit 1;
  if new_id is null then
    insert into public.ideas (title, date, time, for_ids, note)
    values (
      ttl, d, t,
      case when p ? 'for_ids' then public.text_array(p -> 'for_ids') else src.for_ids end,
      trim(both ' ' from concat_ws(' · ', nullif(src.place, ''), nullif(src.note, '')))
    ) returning id into new_id;
  end if;
  perform set_config('hm.moving', '1', true);
  delete from public.pending where id = src.id;
  perform set_config('hm.moving', '', true);
  return new_id;
end; $$;

-- Staging skips anything dismissed, already on the calendar or the shelf, or already waiting,
-- including a longer form of the same title.
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
                                where public.same_event_title(e.title, ttl) and e.date = d and e.time is not distinct from t))
       or (k = 'task' and exists (select 1 from public.tasks x where public.same_event_title(x.title, ttl) and x.due = d))
       or exists (select 1 from public.dismissed x where public.same_event_title(x.title, ttl) and x.date = d and x.time is not distinct from t)
       or exists (select 1 from public.ideas i where public.same_event_title(i.title, ttl) and i.date = d)
       or exists (select 1 from public.pending p where public.same_event_title(p.title, ttl) and p.date = d and p.time is not distinct from t) then
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
