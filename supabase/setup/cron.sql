-- Scheduled jobs and the instant calendar sync.
-- Run once in Supabase → SQL Editor AFTER the first deploy. Change ONE thing first:
-- replace YOUR-PROJECT-REF below with your project's reference (the part before .supabase.co).
-- Safe to run again.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Where the functions live, and a secret only the scheduler and the functions know.
do $$
begin
  if exists (select 1 from vault.secrets where name = 'hm_project_url') then
    perform vault.update_secret((select id from vault.secrets where name = 'hm_project_url'), 'https://rolkzfoxypghantxcuev.supabase.co');
  else
    perform vault.create_secret('https://rolkzfoxypghantxcuev.supabase.co', 'hm_project_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'hm_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'hm_cron_secret');
  end if;
end $$;

create or replace function public.hm_call(fn text) returns bigint
language sql security definer set search_path = public, extensions as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'hm_project_url') || '/functions/v1/' || fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'hm_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$;
revoke all on function public.hm_call(text) from public, anon, authenticated;

-- Re-create the jobs cleanly.
select cron.unschedule(jobname) from cron.job where jobname like 'hm-%';
select cron.schedule('hm-calendar-sync', '*/10 * * * *', $$ select public.hm_call('calendar-sync') $$);
select cron.schedule('hm-poll',          '7 * * * *',    $$ select public.hm_call('poll') $$);
select cron.schedule('hm-notify',        '2 * * * *',    $$ select public.hm_call('notify') $$);

-- Any change to the calendar pushes to Google Calendar right away.
create or replace function public.hm_events_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.hm_call('calendar-sync');
  return null;
end $$;
drop trigger if exists hm_events_sync on public.events;
create trigger hm_events_sync after insert or update or delete on public.events
  for each statement execute function public.hm_events_changed();

-- Copy this value into Edge Functions → Secrets as CRON_SECRET.
select decrypted_secret as "CRON_SECRET (copy this)" from vault.decrypted_secrets where name = 'hm_cron_secret';
