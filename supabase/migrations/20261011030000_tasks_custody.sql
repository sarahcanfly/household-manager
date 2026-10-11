-- To-dos with due dates, custody days on the calendar, and the morning notification.

/* ---------- to-dos ---------- */
-- Things to do by a date (a form due, a registration window, a payment), kept off
-- the calendar. They nag before they are due and drop off once ticked.
create table public.tasks (
  id         text primary key default public.short_id(),
  title      text not null check (length(trim(title)) > 0),
  due        date not null,
  for_ids    text[] not null default '{}',
  note       text not null default '',
  done       boolean not null default false,
  done_at    timestamptz,
  source     text not null default 'manual',
  source_ref text not null default '',
  created_by text not null default public.current_actor(),
  created_at timestamptz not null default now()
);
create index tasks_open on public.tasks (due) where not done;
alter table public.tasks enable row level security;
create policy household_all on public.tasks for all to authenticated using (public.is_household()) with check (public.is_household());

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;

-- Items in the Inbox are now either an event or a to-do.
alter table public.pending add column kind text not null default 'event' check (kind in ('event', 'task'));

/* ---------- custody days ---------- */
-- Set by the co-parent calendar sync on its custody all-day events: whose house
-- the kids are at ("Eli's", "Sarah's"). Empty for every other event.
alter table public.events add column custody text not null default '';

/* ---------- morning notification ---------- */
insert into public.settings (key, value) values
  ('morning', '{"enabled": true, "hour": 7, "email": false}')
on conflict (key) do nothing;

/* ---------- approving a to-do from the Inbox ---------- */
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
  delete from public.pending where id = src.id;
  insert into public.log (action, detail) values ('approvePending', new_id || ' ' || src.title);
  return new_id;
end; $$;

/* ---------- staging to-dos found in emails and photos ---------- */
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
       or (k = 'task' and exists (select 1 from public.tasks x where lower(x.title) = lower(ttl) and x.due = d)) then
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
