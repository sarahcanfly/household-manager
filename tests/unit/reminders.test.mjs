import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, fakeClaude, use, say, lastToolResults } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const H = await import(B + 'holidays.js');
const { runNotify } = await import(B + 'notifyjob.js');
const { Agent } = await import(B + 'agent.js');

test('collection holidays match the town\'s 2026 list', () => {
  assert.deepEqual(H.collectionHolidays(2026).map((h) => h.date), [
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-20', '2026-05-25', '2026-06-19',
    '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']);   // July 4 2026 is a Saturday
  assert.ok(H.collectionHolidays(2027).some((h) => h.date === '2027-07-05') === false && H.collectionHolidays(2027).some((h) => h.date === '2027-10-11'));
  assert.equal(H.holidayBefore('2026-10-16').name, "Indigenous Peoples' Day");
  assert.equal(H.holidayBefore('2026-10-23'), null);
  assert.equal(H.holidayBefore('2026-11-10'), null, 'Veterans Day is Wednesday: Tuesday is not affected');
  assert.equal(H.holidayBefore('2026-11-13').name, "Veterans' Day");
});

const trash = (holiday) => ({ id: 't', title: 'Trash & recycling', note: '', days: [5], hour: 7, every_weeks: 1, start_date: '2026-10-12', holiday });

test('Friday trash reminder: skipped, moved to Saturday, or unchanged in a holiday week', () => {
  const fires = (r, from, n) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10); return [d, H.firesOn(r, d)]; }).filter(([, f]) => f.fire);
  assert.deepEqual(fires(trash('skip'), '2026-10-12', 28).map(([d]) => d), ['2026-10-23', '2026-10-30', '2026-11-06'], 'Oct 16 skipped (holiday Monday)');
  const shifted = fires(trash('shift'), '2026-10-12', 28);
  assert.deepEqual(shifted.map(([d]) => d), ['2026-10-17', '2026-10-23', '2026-10-30', '2026-11-06']);
  assert.match(shifted[0][1].note, /A day late this week because of Indigenous Peoples' Day/);
  assert.deepEqual(fires(trash('none'), '2026-10-12', 7).map(([d]) => d), ['2026-10-16']);
  // Christmas on a Friday moves Friday pickup to Saturday
  assert.equal(H.firesOn({ ...trash('shift'), start_date: '2026-12-01' }, '2026-12-26').fire, true);
  assert.equal(H.firesOn({ ...trash('skip'), start_date: '2026-12-01' }, '2026-12-25').fire, false);
  assert.equal(H.describeReminder(trash('skip')), 'Trash & recycling: every Friday at 7am, skipped in holiday weeks');
});

test('the hourly job sends a due reminder once, at its hour, to everyone\'s phone', async () => {
  const store = new MemoryStore();
  store.rems = [{ ...trash('shift'), note: 'Recycling too' }];
  const pushes = [], claimed = new Set();
  const run = (iso) => runNotify({ store, now: new Date(iso), appUrl: 'https://app', mail: async () => {}, push: async (m) => pushes.push(m),
    claim: async (k, p) => { if (claimed.has(k + p)) return false; claimed.add(k + p); return true; } });
  await run('2026-10-16T11:05:00Z');   // Fri 7:05am, holiday week: nothing
  await run('2026-10-17T10:05:00Z');   // Sat 6:05am: not yet
  await run('2026-10-17T11:05:00Z');   // Sat 7:05am: moved reminder
  await run('2026-10-17T11:40:00Z');   // same hour again: not twice
  assert.deepEqual(pushes.map((p) => [p.title, p.body]), [['Trash & recycling', "Recycling too A day late this week because of Indigenous Peoples' Day."]]);
});

test('the agent sets up a reminder and says when it will go off', async () => {
  const store = new MemoryStore();
  const claude = fakeClaude([use('reminders', { action: 'add', title: 'Trash & recycling', days: ['Friday'], hour: 7, holiday: 'skip' }), say('Done.')]);
  const agent = new Agent({ store, claude, actor: 'sarah@x.com', notify: async () => {}, now: new Date('2026-10-12T13:40:00Z') });
  await agent.ask('remind us about trash every Friday morning except holiday weeks', []);
  const res = JSON.parse(lastToolResults(claude)[0].content);
  assert.equal(res.reminder, 'Trash & recycling: every Friday at 7am, skipped in holiday weeks');
  assert.deepEqual(res.next, ['Fri Oct 23', 'Fri Oct 30', 'Fri Nov 6']);
  assert.match(res.note, /holiday, so it is skipped this week/);
  assert.deepEqual(store.rems[0].days, [5]);
  const c2 = fakeClaude([use('reminders', { action: 'list' }), use('reminders', { action: 'remove', id: store.rems[0].id }), say('Removed.')]);
  await new Agent({ store, claude: c2, actor: 'sarah@x.com', notify: async () => {} }).ask('stop the trash reminder', []);
  assert.equal(store.rems.length, 0);
});
