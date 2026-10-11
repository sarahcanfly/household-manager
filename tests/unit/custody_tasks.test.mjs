import test from 'node:test';
import assert from 'node:assert/strict';
import { domain as d, members, ev, task, MemoryStore, fakeClaude, use, say, lastToolResults } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const { desiredRows, planSync, custodyPlace } = await import(B + 'feedsync.js');
const { morningText, tomorrowText, weeklyText, digestText } = await import(B + 'notify.js');
const { runNotify } = await import(B + 'notifyjob.js');
const { parseExtraction, buildPrompt } = await import(B + 'extract.js');
const { Agent } = await import(B + 'agent.js');

const m = members();
// Mia & Leo stand in for Aaron & Ozzie. Rose is the other parent.
const away = (date) => ev({ title: "M&L @Rose's", date, for_ids: ['k1', 'k2'], driver: 'none', with_us: [], custody: "Rose's", source: 'sync:Co-parent' });
const home = (date) => ev({ title: "M&L @Alex's", date, for_ids: ['k1', 'k2'], driver: 'none', with_us: ['k1', 'k2'], custody: "Alex's", source: 'sync:Co-parent' });

test('custody place comes from the title', () => {
  assert.equal(custodyPlace("A&O @Eli's"), "Eli's");
  assert.equal(custodyPlace("A&O @ Sarah's"), "Sarah's");
  assert.equal(custodyPlace('Dad week'), 'Dad week');
});

test('co-parent sync marks custody days and fills the marker in on existing rows', () => {
  const feed = { name: 'Co-parent', url: 'x', mode: 'sync', default_for: ['Mia', 'Leo'], custody: [{ match: "@Rose's", with_us: [] }, { match: "@Alex's", with_us: ['Mia', 'Leo'] }] };
  const items = [
    { uid: 'a', title: "M&L @Rose's", date: '2026-10-16', time: '', for_ids: [], place: '', note: '' },
    { uid: 'b', title: 'Dentist', date: '2026-10-16', time: '10:00', for_ids: [], place: '', note: '' },
  ];
  const rows = desiredRows(items, feed, m);
  assert.deepEqual(rows.map((r) => r.custody), ["Rose's", '']);
  const existing = [{ ...rows[0], id: 'e1', custody: '' }, { ...rows[1], id: 'e2' }];
  const plan = planSync(rows, existing, '2026-10-01');
  assert.deepEqual(plan.update, [{ id: 'e1', patch: { custody: "Rose's" } }]);
});

test('custody days, labels and ranges', () => {
  const evs = [home('2026-10-12'), away('2026-10-13'), away('2026-10-14'), away('2026-10-15'), home('2026-10-16')];
  const map = d.custodyDays(evs);
  assert.equal(map.has('2026-10-12'), false, 'home days have nobody away');
  assert.equal(d.custodyLabel(map.get('2026-10-13'), m), "Mia & Leo at Rose's");
  assert.deepEqual(d.custodyRanges(evs, '2026-10-12', 6, m), ["Tue Oct 13 – Thu Oct 15: Mia & Leo at Rose's"]);
});

test('our kid events on the other parent\'s days are flagged; theirs and all-day ones are not', () => {
  const evs = [away('2026-10-13'),
    ev({ id: 'soc', title: 'Soccer', date: '2026-10-13', time: '17:00', for_ids: ['k2'], driver: 's1' }),
    ev({ id: 'theirs', title: 'Piano', date: '2026-10-13', time: '16:00', for_ids: ['k1'], source: 'sync:Co-parent' }),
    ev({ id: 'ns', title: 'No school', date: '2026-10-13', time: '', for_ids: ['k1', 'k2'] }),
    ev({ id: 'ivy', title: 'Swim', date: '2026-10-13', time: '15:00', for_ids: ['k3'] })];
  const c = d.awayClashes(evs, m);
  assert.deepEqual(c.map((x) => x.e.id), ['soc']);
  assert.equal(d.awayLine(c[0], m), "Tue Oct 13 5pm Soccer: Leo is at Rose's that day");
});

test('morning note: events with notes, custody, to-dos due soon; nothing on an empty day', () => {
  const today = '2026-10-13';
  const w = { members: m, pending: [], ideas: [], events: [away(today),
    ev({ title: 'Early release', date: today, time: '', for_ids: ['k3'], note: 'Pickup at 12:30' }),
    ev({ title: 'Dentist', date: today, time: '09:30', for_ids: ['s1'] })],
  tasks: [task({ title: 'Field trip form', due: '2026-10-12', for_ids: ['k3'] }), task({ title: 'Camp deposit', due: '2026-10-15' }),
    task({ title: 'Far away', due: '2026-10-30' }), task({ title: 'Done one', due: today, done: true })] };
  const msg = morningText(w, today, 'https://app');
  assert.equal(msg.subject, 'Today: 2 on, 2 to do');
  assert.deepEqual(msg.sms.split('\n'), [
    "Mia & Leo at Rose's", 'All day Early release (Ivy) — Pickup at 12:30', '9:30am Dentist (Alex)',
    'Overdue: Field trip form', 'Due Thu Oct 15: Camp deposit']);
  assert.equal(morningText({ ...w, events: [away(today)], tasks: [] }, today, ''), null, 'custody alone is not worth a ping');
});

test('evening reminder and weekly summary include to-dos and custody, and skip the custody event itself', () => {
  const w = { members: m, pending: [{ id: 'p', title: 'Return form', date: '2026-10-20', time: '', kind: 'task', for_ids: [] }], ideas: [],
    events: [away('2026-10-14'), ev({ title: 'Soccer', date: '2026-10-14', time: '17:00', for_ids: ['k2'], driver: 's1' })],
    tasks: [task({ title: 'Picture money', due: '2026-10-14', for_ids: ['k1'] })] };
  const t = tomorrowText(w, '2026-10-14', '');
  assert.match(t.body, /Mia & Leo at Rose's/);
  assert.match(t.body, /Due tomorrow:\n- Picture money \(Mia\)/);
  assert.match(t.body, /CUSTODY .*Leo is at Rose's/);
  assert.doesNotMatch(t.body, /M&L @Rose's/);
  assert.equal(tomorrowText({ ...w, events: [], tasks: [task({ due: '2026-10-14', title: 'Only a form' })] }, '2026-10-14', '').subject, 'Tomorrow: 1 thing');
  const wk = weeklyText(w, '2026-10-12', '');
  assert.match(wk.body, /To do:\n- Picture money \(Mia\) — due Wed Oct 14/);
  assert.match(wk.body, /Wednesday Oct 14 — Mia & Leo at Rose's/);
  assert.match(digestText(w, '').body, /to do Return form/);
});

test('morning note goes out at its hour as a notification, email only if asked', async () => {
  const now = new Date('2026-10-13T11:05:00Z');   // 7:05am New York
  const store = new MemoryStore({ events: [ev({ title: 'Dentist', date: '2026-10-13', time: '09:30', for_ids: ['s1'] })], settings: { notify: ['a@x.com'] } });
  const pushes = [], mails = [];
  const deps = { store, now, appUrl: '', claim: async () => true, mail: async (to, s) => mails.push(s), push: async (p) => pushes.push(p) };
  assert.deepEqual(await runNotify(deps), ['morning']);
  assert.equal(pushes[0].title, 'Today: 1 on'); assert.equal(pushes[0].body, '9:30am Dentist (Alex)');
  assert.equal(mails.length, 0);
  store.s.morning = { enabled: true, hour: 7, email: true };
  await runNotify(deps);
  assert.equal(mails.length, 1);
  store.s.morning = { enabled: false, hour: 7, email: true };
  assert.deepEqual(await runNotify(deps), []);
});

test('extraction tells deadlines from events', () => {
  assert.match(buildPrompt('email', { today: '2026-10-11', weekday: 'Sunday', members: m, maxWeeks: 4 }), /"deadline"/);
  const out = parseExtraction(JSON.stringify([
    { title: 'Return field trip form', date: '2026-10-16', time: '08:00', kind: 'deadline', for: ['k1'] },
    { title: 'Concert', date: '2026-10-20', time: '18:30', kind: 'event' },
    { title: 'Old style', date: '2026-10-21', time: '' }]), m);
  assert.deepEqual(out.map((x) => [x.kind, x.time]), [['task', ''], ['event', '18:30'], ['event', '']]);
});

function agentWith(store, script) {
  const claude = fakeClaude(script);
  return { claude, agent: new Agent({ store, claude, actor: 'alex@x.com', notify: async () => {} }) };
}

test('agent adds, lists and ticks off to-dos without touching the calendar', async () => {
  const store = new MemoryStore();
  const due = d.addDays(d.todayIn('America/New_York'), 5);
  let { agent, claude } = agentWith(store, [use('add_task', { title: 'Register for spring soccer', due, for: ['Leo'] }), say('Added to your to-dos.')]);
  const r = await agent.ask('remind me to register Leo for spring soccer', []);
  assert.equal(r.changed, true);
  assert.equal(store.events.length, 0);
  assert.deepEqual([store.tasks[0].title, store.tasks[0].due, store.tasks[0].for_ids, store.tasks[0].source], ['Register for spring soccer', due, ['k2'], 'agent']);
  assert.match(claude.calls[0].system, /to-do list with add_task/);
  const id = store.tasks[0].id;
  ({ agent, claude } = agentWith(store, [use('list_tasks', {}), use('update_task', { id, done: true }), say('Ticked off.')]));
  await agent.ask('I registered him', []);
  assert.equal(store.tasks[0].done, true);
  ({ agent, claude } = agentWith(store, [use('add_task', { title: 'X', due: '2026-02-30' }), say('That date is not real.')]));
  await agent.ask('add x', []);
  assert.match(lastToolResults(claude)[0].content, /not a real date/);
});

test('agent hears about custody: in its instructions and when adding on an away day', async () => {
  const day = d.addDays(d.todayIn('America/New_York'), 2);
  const store = new MemoryStore({ events: [away(day)] });
  const { agent, claude } = agentWith(store, [use('add_event', { title: 'Soccer', date: day, time: '17:00', for: ['Leo'], driver: 'Alex' }), say('Added, but Leo is at Rose\'s that day.')]);
  await agent.ask('add soccer for Leo', []);
  assert.match(claude.calls[0].system, /Custody, next three weeks: .*Mia & Leo at Rose's/);
  const res = JSON.parse(lastToolResults(claude)[0].content);
  assert.match(res.away[0], /Leo is at Rose's that day/);
});

test('two co-parent calendars on the same day stay separate', () => {
  // Mia & Leo with Rose, Ivy with Sam (stand-ins for Aaron & Ozzie with Eli, Reid with Jenn)
  const ivyAway = (date) => ev({ title: "Ivy @Sam's", date, for_ids: ['k3'], driver: 'none', with_us: [], custody: "Sam's", source: 'sync:Ivy custody' });
  const ivyHome = (date) => ev({ title: "Ivy @Alex's", date, for_ids: ['k3'], driver: 'none', with_us: ['k3'], custody: "Alex's", source: 'sync:Ivy custody' });
  const evs = [away('2026-10-13'), ivyAway('2026-10-13'), home('2026-10-14'), ivyAway('2026-10-14'), away('2026-10-15'), ivyHome('2026-10-15'),
    ev({ id: 'swim', title: 'Swim', date: '2026-10-13', time: '16:00', for_ids: ['k3', 'k2'] })];
  const map = d.custodyDays(evs);
  assert.equal(d.custodyLabel(map.get('2026-10-13'), m), "Mia & Leo at Rose's; Ivy at Sam's");
  assert.equal(d.custodyLabel(map.get('2026-10-14'), m), "Ivy at Sam's");
  assert.equal(d.custodyLabel(map.get('2026-10-15'), m), "Mia & Leo at Rose's");
  assert.deepEqual(d.custodyRanges(evs, '2026-10-13', 3, m), [
    "Tue Oct 13: Mia & Leo at Rose's; Ivy at Sam's", "Wed Oct 14: Ivy at Sam's", "Thu Oct 15: Mia & Leo at Rose's"]);
  const lines = d.awayClashes(evs, m).map((c) => d.awayLine(c, m));
  assert.deepEqual(lines, ["Tue Oct 13 4pm Swim: Leo is at Rose's that day", "Tue Oct 13 4pm Swim: Ivy is at Sam's that day"]);
});
