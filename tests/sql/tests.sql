-- Security and behaviour tests. Any failed check raises and stops the run.
\set ON_ERROR_STOP on

create or replace function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok - %', msg; end $$;

create or replace function pg_temp.as_user(email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', email)::text, false);
  execute 'set role authenticated';
end $$;

-- Seed as the owner (bypasses rules)
insert into public.allowed_users values ('alex@x.com'), ('jordan@x.com');
insert into public.members (id, name, kind, sort) values
  ('s1','Alex','adult',0), ('m1','Jordan','adult',1), ('k1','Mia','kid',2), ('k2','Leo','kid',3);

-- 1. A stranger who is signed in sees nothing and cannot write
select pg_temp.as_user('stranger@x.com');
select pg_temp.check((select count(*) from public.members) = 0, 'stranger sees no members');
select pg_temp.check(not public.am_i_household(), 'stranger is not household');
do $$ begin
  insert into public.events (title, date) values ('hack', current_date);
  raise exception 'FAIL: stranger insert should be refused';
exception when insufficient_privilege then raise notice 'ok - stranger insert refused';
end $$;
do $$ begin
  perform public.approve_pending('{"id":"x"}');
  raise exception 'FAIL: stranger rpc should be refused';
exception when insufficient_privilege then raise notice 'ok - stranger cannot call approve_pending';
end $$;
reset role;

-- 2. Not signed in at all
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.check((select count(*) from public.events) = 0, 'anonymous sees no events');
select pg_temp.check((select count(*) from public.settings) = 0, 'anonymous sees no settings');
reset role;

-- 3. A household member can read and write, case-insensitively matched
select pg_temp.as_user('Alex@X.com');
select pg_temp.check(public.am_i_household(), 'email match ignores case');
insert into public.events (id, title, date, time, for_ids, driver) values ('e1', 'Ortho', current_date + 3, '13:30', '{k1}', null);
select pg_temp.check((select created_by from public.events where id = 'e1') = 'Alex@X.com', 'created_by filled in');
select pg_temp.check((select count(*) from public.members) = 4, 'member sees members');
select pg_temp.check((select count(*) from public.settings) > 5, 'member sees settings');
-- cannot see server bookkeeping
select pg_temp.check((select count(*) from public.cal_map) = 0, 'cal_map hidden (no policy)');
do $$ begin
  insert into public.cal_map values ('e1','x','h',false);
  raise exception 'FAIL: cal_map insert should be refused';
exception when insufficient_privilege then raise notice 'ok - cal_map not writable by app';
end $$;
do $$ begin
  perform public.stage_pending('[]');
  raise exception 'FAIL: stage_pending should be server-only';
exception when insufficient_privilege then raise notice 'ok - stage_pending is server only';
end $$;
do $$ begin
  perform public.take_lock('cal', 60);
  raise exception 'FAIL: take_lock should be server-only';
exception when insufficient_privilege then raise notice 'ok - take_lock is server only';
end $$;
-- log: can add own lines, cannot forge someone else's
insert into public.log (action, detail) values ('test', 'mine');
do $$ begin
  insert into public.log (actor, action) values ('jordan@x.com', 'forged');
  raise exception 'FAIL: forged log actor accepted';
exception when insufficient_privilege then raise notice 'ok - log actor cannot be forged';
end $$;
reset role;

-- 4. Server staging: past and duplicates skipped, repeats deduplicated
set role service_role;
select pg_temp.check(
  public.stage_pending(jsonb_build_array(
    jsonb_build_object('title','Soccer','date', current_date + 5, 'time','17:30','for_ids', '["k2"]','source','email'),
    jsonb_build_object('title','soccer','date', current_date + 5, 'time','17:30'),          -- same, different case
    jsonb_build_object('title','Old thing','date', current_date - 2),                       -- past
    jsonb_build_object('title','Ortho','date', current_date + 3, 'time','13:30'),           -- already on calendar
    jsonb_build_object('title','All day thing','date', current_date + 6),
    jsonb_build_object('title','All day thing','date', current_date + 6),                   -- null time dedupe
    jsonb_build_object('title','','date', current_date + 6),                                -- junk
    jsonb_build_object('title','Bad date','date', 'not-a-date')                             -- junk
  )) = '{"added": 2, "past": 1, "dupe": 3}'::jsonb,
  'stage_pending counts added/past/dupe');
select pg_temp.check((select count(*) from public.pending) = 2, 'two rows queued');
select pg_temp.check(public.take_lock('cal', 60), 'first lock taken');
select pg_temp.check(not public.take_lock('cal', 60), 'second lock refused while held');
select public.release_lock('cal');
select pg_temp.check(public.take_lock('cal', 60), 'lock available after release');
insert into public.agent_pending (token, action, args, summary) values ('00000000-0000-0000-0000-000000000001', 'delete', '{"id":"e1"}', 'x');
insert into public.agent_pending (token, action, args, summary, expires_at) values ('00000000-0000-0000-0000-000000000002', 'delete', '{"id":"e1"}', 'x', now() - interval '1 minute');
select pg_temp.check((public.redeem_agent_token('00000000-0000-0000-0000-000000000001')).token is not null, 'token redeems once');
select pg_temp.check((public.redeem_agent_token('00000000-0000-0000-0000-000000000001')).token is null, 'token cannot be reused');
select pg_temp.check((public.redeem_agent_token('00000000-0000-0000-0000-000000000002')).token is null, 'expired token refused');
reset role;

-- 5. Approve with edits, shelve, bulk with a failure
select pg_temp.as_user('jordan@x.com');
select pg_temp.check(
  (select public.approve_pending(jsonb_build_object('id', id, 'title', 'Soccer practice', 'time', '17:45', 'driver', 'm1', 'for_ids', '["k2"]'))
   from public.pending where title = 'Soccer') is not null, 'approve returns new id');
select pg_temp.check((select count(*) from public.events where title = 'Soccer practice' and time = '17:45' and driver = 'm1' and source = 'email') = 1,
  'approved event keeps edits and original source');
select pg_temp.check((select count(*) from public.pending where title = 'Soccer') = 0, 'approved item left the queue');
select pg_temp.check(
  public.approve_many(jsonb_build_array(
    (select jsonb_build_object('id', id) from public.pending where title = 'All day thing'),
    jsonb_build_object('id', 'missing', 'title', 'Ghost'))) ->> 'done' = '1', 'bulk approve: good one done');
select pg_temp.check((select time is null from public.events where title = 'All day thing'), 'all-day stays all-day');
-- shelf round trip
select public.event_to_idea('e1', 'i1');
select pg_temp.check((select count(*) from public.ideas where id = 'i1' and title = 'Ortho') = 1 and not exists (select 1 from public.events where id = 'e1'), 'event moved to shelf');
select public.restore_event(jsonb_build_object('id','e1','title','Ortho','date', current_date + 3,'time','13:30','for_ids','["k1"]'), 'i1');
select pg_temp.check(exists (select 1 from public.events where id = 'e1' and time = '13:30') and not exists (select 1 from public.ideas where id = 'i1'), 'undo restores event');
select public.idea_to_event((select id from public.ideas limit 1), 'e9', current_date + 9, '') where exists (select 1 from public.ideas);
-- roster: ids kept, removed people kept but inactive, colours by position
select public.save_members('[{"id":"s1","name":"Alex","kind":"adult"},{"id":"m1","name":"Mike","kind":"adult"},{"name":"Ivy","kind":"kid"}]');
select pg_temp.check((select name from public.members where id = 'm1') = 'Mike', 'rename keeps id');
select pg_temp.check((select active from public.members where id = 'k1') = false, 'removed member kept, inactive');
select pg_temp.check((select count(*) from public.members where name = 'Ivy' and active and color = '#3B5A8A') = 1, 'new member gets palette colour by position');
reset role;

-- 5b. Siri keys and staged confirmations
select pg_temp.as_user('jordan@x.com');
select pg_temp.check(not public.has_shortcut_key(), 'no key yet');
create temp table k1 as select public.create_shortcut_key() as k;
select pg_temp.check((select k from k1) ~ '^hh_[0-9a-f]{64}$', 'key has the expected shape');
select pg_temp.check(public.has_shortcut_key(), 'key now exists');
create temp table k2 as select public.create_shortcut_key() as k;
select pg_temp.check((select k from k1) <> (select k from k2), 'making a new key replaces the old one');
select pg_temp.check((select count(*) from public.shortcut_keys) = 0, 'key table hidden from the app');
reset role;
select pg_temp.check((select count(*) from public.shortcut_keys) = 1, 'one key per person');
select pg_temp.check((select key_hash from public.shortcut_keys) = encode(sha256(convert_to((select k from k2), 'UTF8')), 'hex'), 'only the hash is stored');
insert into public.agent_pending (action, args, summary, created_by) values ('delete', '{"id":"e1"}', 'Delete Ortho?', 'jordan@x.com'), ('delete', '{"id":"e2"}', 'Not mine', 'alex@x.com');
select pg_temp.check((select expires_at > now() + interval '11 hours' from public.agent_pending where summary = 'Delete Ortho?'), 'staged changes last half a day');
select pg_temp.as_user('Jordan@x.com');
select pg_temp.check((select count(*) from public.my_agent_pending()) = 1 and (select summary from public.my_agent_pending()) = 'Delete Ortho?', 'see only my own staged changes');
select public.revoke_shortcut_key();
select pg_temp.check(not public.has_shortcut_key(), 'key revoked');
reset role;
select pg_temp.as_user('stranger@x.com');
do $$ begin
  perform public.create_shortcut_key();
  raise exception 'FAIL: stranger made a key';
exception when insufficient_privilege then raise notice 'ok - stranger cannot make a key';
end $$;
select pg_temp.check((select count(*) from public.my_agent_pending()) = 0, 'stranger sees no staged changes');
reset role;

-- 5c. Phone notifications
select pg_temp.check((select value->>'reminders' from public.settings where key = 'push') = 'true', 'push setting defaults on');
select pg_temp.as_user('Jordan@x.com');
select pg_temp.check(public.push_public_key() is null, 'no signing key until the server makes one');
select public.save_push_subscription('https://web.push.apple.com/abc', 'p1', 'a1', 'iPhone');
select public.save_push_subscription('https://web.push.apple.com/abc', 'p2', 'a2', 'iPhone');
select pg_temp.check((select count(*) from public.push_subscriptions) = 0, 'subscriptions hidden from the app');
do $$ begin
  perform public.save_push_subscription('http://evil.example/x', 'p', 'a', '');
  raise exception 'FAIL: accepted a non-https endpoint';
exception when raise_exception then raise notice 'ok - non-https endpoint refused';
end $$;
reset role;
select pg_temp.check((select count(*) from public.push_subscriptions) = 1 and (select p256dh from public.push_subscriptions) = 'p2' and (select email from public.push_subscriptions) = 'jordan@x.com', 'resubscribing replaces, email lowercased');
insert into public.push_keys (public_key, private_jwk) values ('PUB', '{}');
select pg_temp.as_user('jordan@x.com');
select pg_temp.check(public.push_public_key() = 'PUB', 'household can read the public key');
select pg_temp.check((select count(*) from public.push_keys) = 0, 'private key hidden from the app');
select public.remove_push_subscription('https://web.push.apple.com/abc');
reset role;
select pg_temp.check((select count(*) from public.push_subscriptions) = 0, 'turning off removes it');
select pg_temp.as_user('stranger@x.com');
select pg_temp.check(public.push_public_key() is null, 'stranger gets no key');
do $$ begin
  perform public.save_push_subscription('https://web.push.apple.com/zzz', 'p', 'a', '');
  raise exception 'FAIL: stranger subscribed';
exception when insufficient_privilege then raise notice 'ok - stranger cannot subscribe';
end $$;
reset role;

-- 5d. To-dos, custody column, morning setting
select pg_temp.check((select value->>'hour' from public.settings where key = 'morning') = '7', 'morning notification defaults to 7am');
select public.stage_pending(jsonb_build_array(
  jsonb_build_object('title', 'Permission slip due', 'date', (public.hm_today() + 3)::text, 'time', '08:00', 'kind', 'task', 'for_ids', '["k1"]'::jsonb, 'source', 'email'),
  jsonb_build_object('title', 'Permission slip due', 'date', (public.hm_today() + 3)::text, 'kind', 'task'),
  jsonb_build_object('title', 'Old form', 'date', (public.hm_today() - 1)::text, 'kind', 'task')));
select pg_temp.check((select count(*) from public.pending where kind = 'task') = 1, 'to-do staged once, past one skipped');
select pg_temp.check((select time from public.pending where kind = 'task') is null, 'to-dos have no time');
select pg_temp.as_user('alex@x.com');
create temp table tid as select public.approve_pending(jsonb_build_object('id', (select id from public.pending where kind = 'task'), 'note', 'Sign and return')) as id;
select pg_temp.check((select count(*) from public.tasks where id = (select id from tid) and due = public.hm_today() + 3 and for_ids = '{k1}' and note = 'Sign and return' and not done and source = 'email') = 1, 'approving a to-do puts it on the list, not the calendar');
select pg_temp.check((select count(*) from public.events where title = 'Permission slip due') = 0, 'nothing added to the calendar');
update public.tasks set done = true, done_at = now() where id = (select id from tid);
select pg_temp.check((select done from public.tasks where id = (select id from tid)), 'household can tick a to-do');
reset role;
select public.stage_pending(jsonb_build_array(jsonb_build_object('title', 'Permission slip due', 'date', (public.hm_today() + 3)::text, 'kind', 'task')));
select pg_temp.check((select count(*) from public.pending where kind = 'task') = 0, 'an existing to-do is not queued again');
select pg_temp.as_user('stranger@x.com');
select pg_temp.check((select count(*) from public.tasks) = 0, 'stranger sees no to-dos');
reset role;
select pg_temp.check((select custody from public.events limit 1) = '', 'custody defaults to empty');

-- 5e. Event likes
select pg_temp.as_user('alex@x.com');
insert into public.event_taste (title, kind, vote) values ('Band on the common', 'music', 1);
select pg_temp.check((select by_email from public.event_taste) = 'alex@x.com', 'a like records who gave it');
reset role;
select pg_temp.as_user('stranger@x.com');
select pg_temp.check((select count(*) from public.event_taste) = 0, 'stranger sees no likes');
reset role;

-- 6. Removing someone from allowed_users locks them out immediately
delete from public.allowed_users where email = 'jordan@x.com';
select pg_temp.as_user('jordan@x.com');
select pg_temp.check((select count(*) from public.events) = 0, 'revoked user sees nothing');
reset role;

\echo ALL SQL TESTS PASSED
