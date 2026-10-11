-- Personal keys for the "Ask Household" iPhone Shortcut, which cannot sign in like the app.
-- Only a hash of each key is stored; the key itself is shown once, when it is made.
create table if not exists public.shortcut_keys (
  email      text primary key,
  key_hash   text not null unique,
  created_at timestamptz not null default now()
);
alter table public.shortcut_keys enable row level security;   -- no policies: reached only through the functions below

-- Make (or replace) the signed-in person's key. Returns the key once.
create or replace function public.create_shortcut_key() returns text
language plpgsql volatile security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', '')); k text;
begin
  if not public.is_household() or me = '' then raise exception 'Not allowed' using errcode = '42501'; end if;
  k := 'hh_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.shortcut_keys (email, key_hash) values (me, encode(sha256(convert_to(k, 'UTF8')), 'hex'))
  on conflict (email) do update set key_hash = excluded.key_hash, created_at = now();
  return k;
end $$;

create or replace function public.revoke_shortcut_key() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.shortcut_keys where email = lower(coalesce(auth.jwt() ->> 'email', ''));
end $$;

create or replace function public.has_shortcut_key() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shortcut_keys where email = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- Changes the agent is holding for the signed-in person to confirm (from the app or from Siri).
create or replace function public.my_agent_pending() returns table (token uuid, summary text)
language sql stable security definer set search_path = public as $$
  select token, summary from public.agent_pending
  where public.is_household() and lower(created_by) = lower(coalesce(auth.jwt() ->> 'email', '')) and expires_at > now()
  order by expires_at;
$$;

-- Asked from the kitchen, confirmed later: keep staged changes for half a day.
alter table public.agent_pending alter column expires_at set default now() + interval '12 hours';
