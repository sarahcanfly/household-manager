-- Template: who can sign in, and household settings. Fill in and run in Supabase → SQL Editor.
-- (If you were given a filled-in copy, run that instead.) Safe to run again.

begin;

insert into public.allowed_users (email) values
  ('you@example.com'),
  ('partner@example.com')
on conflict (email) do nothing;

insert into public.settings (key, value) values
  ('notify', '["you@example.com", "partner@example.com"]'),
  ('weekly', '{"enabled": true, "day": "MONDAY", "hour": 7}'),
  ('reminders', '{"enabled": true, "hour": 18}'),
  ('digest', '{"enabled": true, "hour": 19}'),
  ('timezone', '"America/New_York"'),
  -- Texts via carrier email gateways, e.g. vzwpix.com (Verizon), tmomail.net (T-Mobile), txt.att.net (AT&T)
  ('sms', '{"enabled": false, "weekly": true, "reminders": true, "digest": false, "max_chars": 600, "recipients": []}'),
  -- Calendar feeds read every hour: [{"name": "...", "url": "https://...ics", "exclude": [], "tag": [{"match": "School", "who": ["Kid"]}]}]
  ('feeds', '[]'),
  -- Google Docs read every hour (share each with the service account): [{"id": "...", "name": "...", "type": "doc"}]
  ('docs', '[]'),
  ('ics_rules', '{"rename": [], "tag": []}')
on conflict (key) do update set value = excluded.value;

commit;
