-- Phone notifications (Web Push), replacing carrier email-to-text.
-- Each phone that turns notifications on stores one subscription. The server
-- signs pushes with a key pair it makes itself on first use (push_keys), so
-- there is nothing to set up by hand. Both tables have row security on and no
-- policies: only the functions below and the server (service key) touch them.

create table public.push_subscriptions (
  endpoint   text primary key,
  email      text not null,
  p256dh     text not null,
  auth       text not null,
  device     text not null default '',
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;

create table public.push_keys (
  id          int primary key default 1 check (id = 1),
  public_key  text not null,   -- base64url, uncompressed P-256 point (what the browser needs)
  private_jwk jsonb not null,
  created_at  timestamptz not null default now()
);
alter table public.push_keys enable row level security;

insert into public.settings (key, value) values
  ('push', '{"weekly": true, "reminders": true, "digest": true}')
on conflict (key) do nothing;

create or replace function public.save_push_subscription(endpoint text, p256dh text, auth text, device text default '')
returns void language plpgsql security definer set search_path = public as $$
declare me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_household() or me = '' then raise exception 'Not allowed' using errcode = '42501'; end if;
  if endpoint !~ '^https://' or length(endpoint) > 1000 or coalesce(p256dh, '') = '' or coalesce(auth, '') = '' then
    raise exception 'That does not look like a notification subscription.';
  end if;
  insert into public.push_subscriptions as s (endpoint, email, p256dh, auth, device)
  values (save_push_subscription.endpoint, me, save_push_subscription.p256dh, save_push_subscription.auth, left(coalesce(save_push_subscription.device, ''), 80))
  on conflict on constraint push_subscriptions_pkey do update set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth,
    device = excluded.device, created_at = now();
end $$;

create or replace function public.remove_push_subscription(endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_household() then raise exception 'Not allowed' using errcode = '42501'; end if;
  delete from public.push_subscriptions s where s.endpoint = remove_push_subscription.endpoint;
end $$;

-- Public half of the signing key, so a phone can subscribe. Null until the server first makes it.
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = public as $$
  select public_key from public.push_keys where public.is_household() and id = 1;
$$;

revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.remove_push_subscription(text) from public, anon;
revoke all on function public.push_public_key() from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.remove_push_subscription(text) to authenticated;
grant execute on function public.push_public_key() to authenticated;
