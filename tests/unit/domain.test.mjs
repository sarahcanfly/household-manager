import test from 'node:test';
import assert from 'node:assert/strict';
import { domain as d, members, ev, plus } from './helpers.mjs';

test('timezone helpers', () => {
  // 2026-07-01 03:30 UTC is still June 30 in New York
  assert.equal(d.todayIn('America/New_York', new Date('2026-07-01T03:30:00Z')), '2026-06-30');
  assert.equal(d.zoned(new Date('2026-07-01T15:05:00Z'), 'America/New_York').time, '11:05');
  assert.equal(d.wallToUtc('2026-07-01', '14:00', 'America/New_York').toISOString(), '2026-07-01T18:00:00.000Z');
  assert.equal(d.wallToUtc('2026-12-01', '14:00', 'America/New_York').toISOString(), '2026-12-01T19:00:00.000Z');
  assert.equal(d.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(d.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(d.weekdayOf('2026-10-10'), 'Saturday');
  assert.equal(d.prettyTime('14:00'), '2pm');
  assert.equal(d.prettyTime('00:30'), '12:30am');
  assert.equal(d.prettyTime(''), 'all day');
  assert.equal(d.hhmm('9:05:00'), '09:05');
});

test('conflicts: driver twice, driver with own appointment, kid in two places', () => {
  const m = members(), day = plus(2);
  const soccer = ev({ title: 'Soccer', date: day, time: '17:30', for_ids: ['k2'], driver: 's1' });
  const baseball = ev({ title: 'Baseball', date: day, time: '17:30', for_ids: ['k3'], driver: 's1' });
  const book = ev({ title: 'Book club', date: day, time: '18:00', for_ids: ['s1'] });
  const out = d.conflicts([soccer, baseball, book], m);
  assert.equal(out.length, 3);
  assert.match(out[0].why[0], /Alex is driving both/);
  assert.ok(out.some((c) => /Alex is driving "Soccer" but has "Book club"/.test(c.why.join())));
  const twoPlaces = d.conflicts([ev({ date: day, time: '09:00', for_ids: ['k1'] }), ev({ date: day, time: '09:30', for_ids: ['k1'] })], m);
  assert.match(twoPlaces[0].why[0], /Mia is in both/);
  assert.equal(d.conflicts([ev({ date: day, time: '09:00', for_ids: ['k1'] }), ev({ date: day, time: '10:00', for_ids: ['k1'] })], m).length, 0, 'back-to-back is fine');
  assert.equal(d.conflicts([ev({ date: day, time: '', for_ids: ['k1'] }), ev({ date: day, time: '10:00', for_ids: ['k1'] })], m).length, 0, 'all-day never conflicts');
  assert.equal(d.conflicts([ev({ date: day, time: '09:00', driver: 'none', for_ids: ['k1'] }), ev({ date: day, time: '09:00', driver: 'none', for_ids: ['k2'] })], m).length, 0, "'none' is not a driver");
});

test('needsDriver: only timed kid events with nobody assigned', () => {
  const m = members();
  assert.equal(d.needsDriver(ev({ time: '13:30', for_ids: ['k1'] }), m), true);
  assert.equal(d.needsDriver(ev({ time: '13:30', for_ids: ['k1'], driver: 'none' }), m), false);
  assert.equal(d.needsDriver(ev({ time: '', for_ids: ['k1'] }), m), false);
  assert.equal(d.needsDriver(ev({ time: '13:30', for_ids: ['s1'] }), m), false);
});

test('cleanFields resolves names and refuses bad input', () => {
  const m = members(), today = plus(0);
  const f = d.cleanFields({ title: ' Dentist ', date: plus(30), time: '9:00', for: ['leo'], driver: 'Jor', where: 'Main St' }, m, today, false);
  assert.deepEqual([f.title, f.time, f.for_ids, f.driver, f.place], ['Dentist', '09:00', ['k2'], 'm1', 'Main St']);
  const bad = [
    [{ title: 'x', date: '2026-02-30' }, /not a real date/],
    [{ title: 'x', date: plus(1), for: ['Bob'] }, /Nobody in the household/],
    [{ title: 'x', date: plus(1), for: ['Oldie'] }, /Nobody in the household/],      // inactive
    [{ title: 'x', date: plus(1), time: '25:00' }, /HH:mm/],
    [{ title: 'x', date: plus(1), driver: 'Ivy' }, /kid and cannot be the driver/],
    [{ title: 'x', date: plus(1), with_us: ['Alex'] }, /with us/],
    [{ title: 'x', date: '1999-01-01' }, /outside the range/],
    [{ title: '  ', date: plus(1) }, /title/],
    [{ date: plus(1) }, /title is required/],
  ];
  for (const [input, re] of bad) assert.throws(() => d.cleanFields(input, m, today, false), re, JSON.stringify(input));
  assert.deepEqual(d.cleanFields({ time: '15:00' }, m, today, true), { time: '15:00' }, 'partial keeps only given fields');
});

test('isFillOnly and diff', () => {
  const m = members();
  const cur = ev({ title: 'Ortho', time: '13:30', for_ids: ['k1'], driver: '', place: '' });
  assert.equal(d.isFillOnly(cur, { driver: 'Jordan' }), true);
  assert.equal(d.isFillOnly(cur, { driver: 'Jordan', where: 'Main St' }), true);
  assert.equal(d.isFillOnly({ ...cur, driver: 's1' }, { driver: 'Jordan' }), false, 'changing a driver is not a fill');
  assert.equal(d.isFillOnly(cur, { time: '14:00' }), false);
  assert.equal(d.isFillOnly(cur, { driver: '' }), false, 'blanking is not a fill');
  assert.equal(d.isFillOnly(cur, {}), false);
  assert.deepEqual(d.diff(cur, { time: '14:00', driver: 'none' }, m), ['time: 1:30pm -> 2pm', 'driver: not set -> no driving needed']);
  assert.deepEqual(d.diff(cur, { time: '13:30' }, m), []);
});

test('secrets are trimmed of stray spaces and line breaks', async () => {
  const { env } = await import('../../.build/supabase/functions/_shared/env.js');
  process.env.HM_TEST_SECRET = '  abc123@group.calendar.google.com\n';
  assert.equal(env('HM_TEST_SECRET'), 'abc123@group.calendar.google.com');
  process.env.HM_TEST_SECRET = '  \n';
  assert.equal(env('HM_TEST_SECRET', 'fallback'), 'fallback');
  delete process.env.HM_TEST_SECRET;
});
