-- Household Manager: schema, security rules and the few operations that must be atomic.
--
-- Who can see anything: only signed-in people whose email is in allowed_users.
-- Everyone else, signed in or not, gets nothing. Server functions use the
-- service role and bypass these rules on purpose; they do their own checks.

create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* Who is allowed in                                                   */
/* ------------------------------------------------------------------ */

create table public.allowed_users (
  email text primary key check (email = lower(email))
);

create or replace function public.is_household() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.allowed_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.am_i_household() returns boolean
language sql stable as $$ select public.is_household(); $$;

create or replace function public.short_id() returns text
language sql volatile as $$ select substr(md5(gen_random_uuid()::text), 1, 8); $$;

create or replace function public.current_actor() returns text
language sql stable as $$ select coalesce(auth.jwt() ->> 'email', 'system'); $$;

/* ------------------------------------------------------------------ */
/* Settings (timezone, reminder hours, feeds, who gets email)          */
/* ------------------------------------------------------------------ */

create table public.settings (
  key text primary key,
  value jsonb not null
);

insert into public.settings (key, value) values
  ('timezone',      '"America/New_York"'),
  ('weekly',        '{"enabled": true, "day": "MONDAY", "hour": 7}'),
  ('reminders',     '{"enabled": true, "hour": 18}'),
  ('digest',        '{"enabled": true, "hour": 19}'),
  ('notify',        '[]'),
  ('sms',           '{"enabled": false, "weekly": true, "reminders": true, "digest": false, "max_chars": 600, "recipients": []}'),
  ('feeds',         '[]'),
  ('docs',          '[]'),
  ('ics_rules',     '{"rename": [], "tag": []}'),
  ('colors',        '["#3F6B54", "#8E4767", "#3B5A8A", "#A8752A", "#2E6E75", "#9A4B2E", "#4C5B3F", "#7A4E7E"]'),
  ('max_recurrence_weeks', '4')
on conflict (key) do nothing;

create or replace function public.hm_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from public.settings where key = 'timezone'), 'America/New_York');
$$;

create or replace function public.hm_today() returns date
language sql stable as $$ select (now() at time zone public.hm_tz())::date; $$;

/* ------------------------------------------------------------------ */
/* The household data                                                  */
/* ------------------------------------------------------------------ */

create table public.members (
  id     text primary key default public.short_id(),
  name   text not null check (length(trim(name)) > 0),
  kind   text not null check (kind in ('adult', 'kid', 'other')),
  color  text not null default '#5C6763',
  active boolean not null default true,
  sort   int not null default 0
);

create table public.events (
  id         text primary key default public.short_id(),
  title      text not null check (length(trim(title)) > 0),
  date       date not null,
  time       time,                               -- null = all day
  for_ids    text[] not null default '{}',
  driver     text,                               -- member id, 'none' (nobody needs to drive), or null (undecided)
  with_us    text[] not null default '{}',       -- which kids are at this house that day
  place      text not null default '',
  note       text not null default '',
  source     text not null default 'manual',
  created_by text default public.current_actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_date_idx on public.events (date);

create table public.ideas (
  id         text primary key default public.short_id(),
  title      text not null check (length(trim(title)) > 0),
  date       date,
  time       time,
  for_ids    text[] not null default '{}',
  cost       text not null default '',
  link       text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now()
);

create table public.pending (
  id         text primary key default public.short_id(),
  title      text not null check (length(trim(title)) > 0),
  date       date not null,
  time       time,
  for_ids    text[] not null default '{}',
  place      text not null default '',
  note       text not null default '',
  source     text not null default 'text',
  source_ref text not null default '',
  confidence text not null default 'high' check (confidence in ('high', 'low')),
  created_at timestamptz not null default now()
);
-- The same email scanned twice must not queue the same event twice.
create unique index pending_dedupe on public.pending (lower(title), date, time) nulls not distinct;

create table public.log (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  actor  text not null default public.current_actor(),
  action text not null,
  detail text not null default ''
);
create index log_at_idx on public.log (at desc);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end; $$;
create trigger events_touch before update on public.events
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------------ */
/* Server-only bookkeeping (no policies: invisible to the app)         */
/* ------------------------------------------------------------------ */

create table public.cal_map (
  event_id     text primary key,     -- no foreign key: the row must outlive a deleted event
  cal_event_id text not null,
  hash         text not null,
  all_day      boolean not null,
  synced_at    timestamptz not null default now()
);

create table public.agent_pending (
  token      uuid primary key default gen_random_uuid(),
  action     text not null check (action in ('update', 'delete')),
  args       jsonb not null,
  summary    text not null,
  created_by text,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table public.job_lock (
  name  text primary key,
  until timestamptz not null default 'epoch'
);

create table public.notify_sent (
  kind    text not null,
  period  text not null,
  sent_at timestamptz not null default now(),
  primary key (kind, period)
);

-- A lease, so two calendar syncs can never run at once and duplicate events.
create or replace function public.take_lock(lock_name text, seconds int) returns boolean
language plpgsql security definer set search_path = public as $$
declare got boolean;
begin
  insert into public.job_lock (name) values (lock_name) on conflict (name) do nothing;
  update public.job_lock set until = now() + make_interval(secs => seconds)
    where name = lock_name and until < now()
    returning true into got;
  return coalesce(got, false);
end; $$;

create or replace function public.release_lock(lock_name text) returns void
language sql security definer set search_path = public as $$
  update public.job_lock set until = 'epoch' where name = lock_name;
$$;

-- Single use: a confirmation token is deleted the moment it is redeemed.
create or replace function public.redeem_agent_token(t uuid) returns public.agent_pending
language plpgsql security definer set search_path = public as $$
declare row public.agent_pending;
begin
  delete from public.agent_pending where token = t and expires_at > now() returning * into row;
  delete from public.agent_pending where expires_at <= now();
  return row;
end; $$;

/* ------------------------------------------------------------------ */
/* Security rules                                                      */
/* ------------------------------------------------------------------ */

alter table public.allowed_users enable row level security;
alter table public.settings      enable row level security;
alter table public.members       enable row level security;
alter table public.events        enable row level security;
alter table public.ideas         enable row level security;
alter table public.pending       enable row level security;
alter table public.log           enable row level security;
alter table public.cal_map       enable row level security;
alter table public.agent_pending enable row level security;
alter table public.job_lock      enable row level security;
alter table public.notify_sent   enable row level security;

create policy household_all on public.members  for all to authenticated using (public.is_household()) with check (public.is_household());
create policy household_all on public.events   for all to authenticated using (public.is_household()) with check (public.is_household());
create policy household_all on public.ideas    for all to authenticated using (public.is_household()) with check (public.is_household());
create policy household_all on public.pending  for all to authenticated using (public.is_household()) with check (public.is_household());
create policy household_all on public.settings for all to authenticated using (public.is_household()) with check (public.is_household());
create policy household_read on public.log for select to authenticated using (public.is_household());
create policy household_add  on public.log for insert to authenticated with check (public.is_household() and actor = public.current_actor());

revoke all on function public.take_lock(text, int)        from public, anon, authenticated;
revoke all on function public.release_lock(text)          from public, anon, authenticated;
revoke all on function public.redeem_agent_token(uuid)    from public, anon, authenticated;
grant execute on function public.take_lock(text, int)     to service_role;
grant execute on function public.release_lock(text)       to service_role;
grant execute on function public.redeem_agent_token(uuid) to service_role;

/* ------------------------------------------------------------------ */
/* Operations that must happen all-or-nothing                          */
/* Security invoker: the rules above still apply to whoever calls.     */
/* ------------------------------------------------------------------ */

create or replace function public.require_household() returns void
language plpgsql stable as $$
begin
  if not public.is_household() then raise exception 'Not allowed' using errcode = '42501'; end if;
end; $$;

create or replace function public.text_array(j jsonb) returns text[]
language sql immutable as $$
  select coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end)), '{}');
$$;

create or replace function public.nullif_time(t text) returns time
language sql immutable as $$ select case when coalesce(trim(t), '') = '' then null else trim(t)::time end; $$;

-- Approve one waiting item onto the calendar, with any edits made on screen.
create or replace function public.approve_pending(p jsonb) returns text
language plpgsql as $$
declare src public.pending; new_id text;
begin
  perform public.require_household();
  select * into src from public.pending where id = p ->> 'id' for update;
  if not found then raise exception 'That item is no longer waiting.'; end if;
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
  delete from public.pending where id = src.id;
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
  delete from public.pending where id = src.id;
  return new_id;
end; $$;

-- Bulk versions: each item stands alone, so one bad row does not sink the rest.
create or replace function public.approve_many(ps jsonb) returns jsonb
language plpgsql as $$
declare item jsonb; done int := 0; failed text[] := '{}';
begin
  perform public.require_household();
  for item in select * from jsonb_array_elements(ps) loop
    begin
      perform public.approve_pending(item); done := done + 1;
    exception when others then
      failed := failed || (coalesce(item ->> 'title', '?') || ': ' || sqlerrm);
    end;
  end loop;
  return jsonb_build_object('done', done, 'failed', to_jsonb(failed));
end; $$;

create or replace function public.shelve_many(ps jsonb) returns jsonb
language plpgsql as $$
declare item jsonb; done int := 0; failed text[] := '{}';
begin
  perform public.require_household();
  for item in select * from jsonb_array_elements(ps) loop
    begin
      perform public.shelve_pending(item); done := done + 1;
    exception when others then
      failed := failed || (coalesce(item ->> 'title', '?') || ': ' || sqlerrm);
    end;
  end loop;
  return jsonb_build_object('done', done, 'failed', to_jsonb(failed));
end; $$;

create or replace function public.event_to_idea(event_id text, idea_id text) returns void
language plpgsql as $$
declare ev public.events;
begin
  perform public.require_household();
  delete from public.events where id = event_id returning * into ev;
  if not found then raise exception 'That event is gone.'; end if;
  insert into public.ideas (id, title, date, time, for_ids, note)
  values (idea_id, ev.title, ev.date, ev.time, ev.for_ids,
          trim(both ' ' from concat_ws(' · ', nullif(ev.place, ''), nullif(ev.note, ''))));
end; $$;

create or replace function public.idea_to_event(idea_id text, event_id text, d date, t text) returns void
language plpgsql as $$
declare it public.ideas;
begin
  perform public.require_household();
  delete from public.ideas where id = idea_id returning * into it;
  if not found then raise exception 'That idea is gone.'; end if;
  insert into public.events (id, title, date, time, for_ids, note, source)
  values (event_id, it.title, d, public.nullif_time(t), it.for_ids, it.note, 'shelf');
end; $$;

-- Undo helpers: put a row back exactly as it was and remove what replaced it.
create or replace function public.restore_event(ev jsonb, remove_idea text) returns void
language plpgsql as $$
begin
  perform public.require_household();
  if remove_idea is not null then delete from public.ideas where id = remove_idea; end if;
  insert into public.events (id, title, date, time, for_ids, driver, with_us, place, note, source)
  values (ev ->> 'id', ev ->> 'title', (ev ->> 'date')::date, public.nullif_time(ev ->> 'time'),
          public.text_array(ev -> 'for_ids'), nullif(ev ->> 'driver', ''), public.text_array(ev -> 'with_us'),
          coalesce(ev ->> 'place', ''), coalesce(ev ->> 'note', ''), coalesce(ev ->> 'source', 'manual'))
  on conflict (id) do nothing;
end; $$;

create or replace function public.restore_idea(it jsonb, remove_event text) returns void
language plpgsql as $$
begin
  perform public.require_household();
  if remove_event is not null then delete from public.events where id = remove_event; end if;
  insert into public.ideas (id, title, date, time, for_ids, cost, link, note)
  values (it ->> 'id', it ->> 'title', nullif(it ->> 'date', '')::date, public.nullif_time(it ->> 'time'),
          public.text_array(it -> 'for_ids'), coalesce(it ->> 'cost', ''), coalesce(it ->> 'link', ''), coalesce(it ->> 'note', ''))
  on conflict (id) do nothing;
end; $$;

-- Save the household roster in one go, keeping ids so old events keep their names.
create or replace function public.save_members(ms jsonb) returns void
language plpgsql as $$
declare m jsonb; i int := 0; palette jsonb; keep text[] := '{}'; mid text;
begin
  perform public.require_household();
  select value into palette from public.settings where key = 'colors';
  for m in select * from jsonb_array_elements(ms) loop
    if coalesce(trim(m ->> 'name'), '') = '' then continue; end if;
    mid := coalesce(nullif(m ->> 'id', ''), public.short_id());
    insert into public.members (id, name, kind, color, active, sort)
    values (mid, trim(m ->> 'name'), coalesce(m ->> 'kind', 'kid'),
            coalesce(palette ->> (i % greatest(jsonb_array_length(palette), 1)), '#5C6763'), true, i)
    on conflict (id) do update set name = excluded.name, kind = excluded.kind,
      color = excluded.color, active = true, sort = excluded.sort;
    keep := keep || mid;
    i := i + 1;
  end loop;
  -- People taken off the list are kept (their old events still need a name), just inactive.
  update public.members set active = false where not (id = any(keep));
  insert into public.log (action, detail) values ('saveMembers', i || ' people');
end; $$;

-- Server only: queue extracted events, skipping the past and anything already known.
create or replace function public.stage_pending(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; added int := 0; past int := 0; dupe int := 0; d date; t time; ttl text;
begin
  for r in select * from jsonb_array_elements(rows) loop
    ttl := left(trim(coalesce(r ->> 'title', '')), 120);
    begin d := (r ->> 'date')::date; exception when others then continue; end;
    if ttl = '' or d is null then continue; end if;
    t := public.nullif_time(r ->> 'time');
    if d < public.hm_today() then past := past + 1; continue; end if;
    if exists (select 1 from public.events e
               where lower(e.title) = lower(ttl) and e.date = d and e.time is not distinct from t) then
      dupe := dupe + 1; continue;
    end if;
    insert into public.pending (title, date, time, for_ids, place, note, source, source_ref, confidence)
    values (ttl, d, t, public.text_array(r -> 'for_ids'), left(coalesce(r ->> 'place', ''), 120),
            left(coalesce(r ->> 'note', ''), 500), coalesce(r ->> 'source', 'text'),
            coalesce(r ->> 'source_ref', ''), case when r ->> 'confidence' = 'low' then 'low' else 'high' end)
    on conflict do nothing;
    if found then added := added + 1; else dupe := dupe + 1; end if;
  end loop;
  return jsonb_build_object('added', added, 'past', past, 'dupe', dupe);
end; $$;
revoke all on function public.stage_pending(jsonb) from public, anon, authenticated;
grant execute on function public.stage_pending(jsonb) to service_role;

/* ------------------------------------------------------------------ */
/* Live updates between phones                                         */
/* ------------------------------------------------------------------ */

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.events, public.pending, public.ideas, public.members;
  end if;
end $$;
