// Calendars that sync straight onto the household calendar (e.g. a co-parenting calendar).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, members, plus } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const ics = await import(B + 'ics.js');
const fs = await import(B + 'feedsync.js');
const { pollSources } = await import(B + 'intake.js');

const TZ = 'America/New_York';
const d = (s) => s.replace(/-/g, '');
// Mirrors the shape of an iCloud shared calendar: two alternating multi-day custody blocks
// every two weeks, a moved holiday occurrence, a cancelled one, a yearly birthday, timed events.
function sampleIcs(today) {
  const a0 = plus(-100, new Date(today + 'T12:00:00')), b0 = plus(-91, new Date(today + 'T12:00:00'));
  const moved = plus(-100 + 14 * 9, new Date(today + 'T12:00:00'));   // the 9th "home" block after a0
  const cancelled = plus(-91 + 14 * 9, new Date(today + 'T12:00:00'));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Kids'];
  const ev = (...p) => lines.push('BEGIN:VEVENT', ...p, 'END:VEVENT');
  ev('UID:HOME', `DTSTART;VALUE=DATE:${d(a0)}`, `DTEND;VALUE=DATE:${d(plus(9, new Date(a0 + 'T12:00:00')))}`, 'RRULE:FREQ=WEEKLY;INTERVAL=2', "SUMMARY:M&L @Alex's");
  ev('UID:AWAY', `DTSTART;VALUE=DATE:${d(b0)}`, `DTEND;VALUE=DATE:${d(plus(5, new Date(b0 + 'T12:00:00')))}`, 'RRULE:FREQ=WEEKLY;INTERVAL=2', `EXDATE;VALUE=DATE:${d(cancelled)}`, "SUMMARY:M&L @Rose's");
  ev('UID:HOME', `RECURRENCE-ID;VALUE=DATE:${d(moved)}`, `DTSTART;VALUE=DATE:${d(plus(2, new Date(moved + 'T12:00:00')))}`, `DTEND;VALUE=DATE:${d(plus(4, new Date(moved + 'T12:00:00')))}`, "SUMMARY:M&L @Alex's");
  const bday = '2023' + d(plus(30, new Date(today + 'T12:00:00'))).slice(4);   // same month and day, three years ago
  ev('UID:BDAY', `DTSTART;VALUE=DATE:${bday}`, 'RRULE:FREQ=YEARLY', "SUMMARY:Mia's birthday");
  ev('UID:ORTHO', `DTSTART;TZID=America/New_York:${d(plus(5, new Date(today + 'T12:00:00')))}T150000`, `DTEND;TZID=America/New_York:${d(plus(5, new Date(today + 'T12:00:00')))}T160000`, 'SUMMARY:Mia: orthodontist');
  ev('UID:NOSCHOOL', `DTSTART;VALUE=DATE:${d(plus(10, new Date(today + 'T12:00:00')))}`, `DTEND;VALUE=DATE:${d(plus(12, new Date(today + 'T12:00:00')))}`, 'SUMMARY:Mia/Leo No School');
  ev('UID:OLD', 'DTSTART;TZID=America/New_York:20230909T090000', 'RRULE:FREQ=WEEKLY;UNTIL=20231111T140000Z', 'SUMMARY:Leo: Soccer');
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n'), a0, b0, moved, cancelled };
}

const feed = {
  name: 'Co-parent', url: 'webcal://example/kids', mode: 'sync', default_for: ['Mia', 'Leo'],
  tag: [{ match: 'Mia', who: ['Mia'] }, { match: 'Leo', who: ['Leo'] }],
  custody: [{ match: "@Alex's", with_us: ['Mia', 'Leo'] }, { match: "@Rose's", with_us: [] }],
};

test('custody blocks cover every day exactly once, moved and cancelled occurrences respected', () => {
  const today = plus(0);
  const s = sampleIcs(today);
  const items = ics.parseIcs(s.text, TZ, today, 120);
  const custody = items.filter((i) => /@/.test(i.title));
  const days = new Map();
  for (const c of custody) days.set(c.date, [...(days.get(c.date) || []), c.title]);
  const windowDays = Array.from({ length: 135 }, (_, i) => plus(-14 + i));
  const moved = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => plus(k, new Date(s.moved + 'T12:00:00'))));
  const cancelled = new Set([0, 1, 2, 3, 4].map((k) => plus(k, new Date(s.cancelled + 'T12:00:00'))));
  for (const day of windowDays) {
    const t = days.get(day) || [];
    if (moved.has(day) || cancelled.has(day)) continue;          // the edited weeks are checked below
    assert.equal(t.length, 1, `${day} has ${t.length} custody entries`);
  }
  // the moved block now covers its two new days, not the original nine
  const movedNew = [2, 3].map((k) => plus(k, new Date(s.moved + 'T12:00:00')));
  for (const day of movedNew) assert.ok((days.get(day) || []).includes("M&L @Alex's"), `moved block on ${day}`);
  assert.ok(!(days.get(s.moved) || []).length, 'original start day of the moved block is empty');
  assert.ok(!(days.get(s.cancelled) || []).length, 'cancelled block is gone');
  assert.ok(items.some((i) => i.title === "Mia's birthday"), 'yearly birthday appears');
  assert.ok(!items.some((i) => i.title === 'Leo: Soccer'), 'series that ended years ago is left out');
  assert.equal(items.filter((i) => i.title === 'Mia/Leo No School').length, 2, 'two-day all-day event becomes two days');
  assert.equal(new Set(items.map((i) => i.uid)).size, items.length, 'every entry has its own id');
});

test('rows: tags, default people, custody sets with-us and no driving', () => {
  const today = plus(0);
  const items = ics.applyRules(ics.parseIcs(sampleIcs(today).text, TZ, today, 120), feed, members());
  const rows = fs.desiredRows(items, feed, members());
  const home = rows.find((r) => r.title === "M&L @Alex's"), away = rows.find((r) => r.title === "M&L @Rose's");
  assert.deepEqual([home.for_ids, home.with_us, home.driver], [['k1', 'k2'], ['k1', 'k2'], 'none']);
  assert.deepEqual([away.for_ids, away.with_us, away.driver], [['k1', 'k2'], [], 'none']);
  const ortho = rows.find((r) => r.title === 'Mia: orthodontist');
  assert.deepEqual([ortho.for_ids, ortho.driver, ortho.time], [['k1'], '', '15:00']);
  assert.deepEqual(rows.find((r) => r.title === 'Mia/Leo No School').for_ids.sort(), ['k1', 'k2']);
});

test('sync: first run adds, second does nothing, changes and removals carry over, app driver kept', async () => {
  const today = plus(0);
  const store = new MemoryStore();
  const run = async (text) => fs.syncFeed(store, feed, ics.applyRules(ics.parseIcs(text, TZ, today, 120), feed, store.m), store.m, today);
  const s = sampleIcs(today);
  const first = await run(s.text);
  assert.ok(first.added > 100); assert.equal(store.batches, 1, 'one insert request');
  assert.deepEqual(await run(s.text), { added: 0, updated: 0, removed: 0 });

  const ortho = store.events.find((e) => e.title === 'Mia: orthodontist');
  ortho.driver = 'm1';                                             // someone picks a driver in the app
  const changed = s.text.replace('T150000', 'T153000').replace('SUMMARY:Mia/Leo No School', 'SUMMARY:Mia/Leo No School (snow day)');
  const r2 = await run(changed);
  assert.equal(r2.updated, 3, 'time change plus the renamed two-day event');
  const o2 = store.events.find((e) => e.title === 'Mia: orthodontist');
  assert.deepEqual([o2.time, o2.driver], ['15:30', 'm1'], 'feed time updated, app driver kept');

  const removed = changed.replace(/BEGIN:VEVENT\r\nUID:ORTHO[\s\S]*?END:VEVENT\r\n/, '');
  const r3 = await run(removed);
  assert.equal(r3.removed, 1);
  assert.ok(!store.events.some((e) => e.title === 'Mia: orthodontist'));
});

test('sync: an empty calendar never wipes events, and old events are left alone', async () => {
  const today = plus(0);
  const store = new MemoryStore();
  store.events.push({ id: 'old', title: 'Long ago', date: plus(-60), time: '', for_ids: [], driver: '', with_us: [], place: '', note: '', source: 'sync:Co-parent', feed: 'Co-parent', feed_uid: 'X|1' });
  await fs.syncFeed(store, feed, ics.parseIcs(sampleIcs(today).text, TZ, today, 120), store.m, today);
  assert.ok(store.events.some((e) => e.id === 'old'), 'event older than two weeks untouched');
  const before = store.events.length;
  await assert.rejects(fs.syncFeed(store, feed, [], store.m, today), /came back empty/);
  assert.equal(store.events.length, before);
});

test('poll routes a sync feed straight to the calendar and an ordinary feed to the inbox', async () => {
  const today = plus(0);
  const school = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Picture day\nDTSTART;VALUE=DATE:${d(plus(6))}\nEND:VEVENT\nEND:VCALENDAR`;
  const store = new MemoryStore({ settings: { feeds: [feed, { name: 'School', url: 'https://school/x.ics' }] } });
  const report = await pollSources({
    store, claude: async () => { throw new Error('no Claude needed'); },
    fetchText: async (u) => (u.startsWith('webcal') ? sampleIcs(today).text : school),
    driveText: async () => '', driveBase64: async () => '',
  }, 'scheduled');
  assert.match(report[0], /^Co-parent: added \d+, updated 0, removed 0$/);
  assert.match(report[1], /School: found 1, queued 1/);
  assert.ok(store.events.some((e) => e.source === 'sync:Co-parent'));
  assert.equal(store.pending.length, 1);
});
