import test from 'node:test';
import assert from 'node:assert/strict';
import { members } from './helpers.mjs';
const ics = await import('../../.build/supabase/functions/_shared/ics.js');

const TZ = 'America/New_York';
const sample = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'SUMMARY:Oakwood Middle School Open', '  House', 'DTSTART;TZID=America/New_York:20261015T180000', 'LOCATION:Oakwood\\, Gym', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:No School', 'DTSTART;VALUE=DATE:20261012', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Board meeting', 'DTSTART:20261020T230000Z', 'END:VEVENT',          // 7pm New York
  'BEGIN:VEVENT', 'SUMMARY:Late flight', 'DTSTART:20261021T030000Z', 'END:VEVENT',            // 11pm on the 20th
  'BEGIN:VEVENT', 'SUMMARY:Cancelled thing', 'DTSTART:20261022T150000Z', 'STATUS:CANCELLED', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:B1/2 Lions Fall 2026 - Pratice', 'DTSTART;TZID=America/New_York:20261013T173000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;COUNT=6', 'EXDATE;TZID=America/New_York:20261015T173000', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:B1/2 Lions Fall 2026 vs B1/2 Hawks Fall 2026 - Away Game', 'DTSTART;TZID=America/New_York:20261017T090000', 'END:VEVENT',
  'BEGIN:VEVENT', 'SUMMARY:Pine Hill Open House', 'DTSTART;VALUE=DATE:20261016', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses times, all-day, UTC, folding, escapes, cancellations', () => {
  const items = ics.parseIcs(sample, TZ, '2026-10-10', 28);
  const by = (t) => items.filter((i) => i.title === t);
  assert.deepEqual(by('Oakwood Middle School Open House')[0], { title: 'Oakwood Middle School Open House', date: '2026-10-15', time: '18:00', place: 'Oakwood, Gym', note: '', for_ids: [] });
  assert.equal(by('No School')[0].time, '');
  assert.equal(by('Board meeting')[0].time, '19:00');
  assert.deepEqual([by('Late flight')[0].date, by('Late flight')[0].time], ['2026-10-20', '23:00']);
  assert.equal(by('Cancelled thing').length, 0);
  assert.ok(ics.looksLikeIcs(sample));
  assert.ok(!ics.looksLikeIcs('Dear parents, soccer is Tuesday'));
});

test('weekly repeats with BYDAY, COUNT and EXDATE', () => {
  const items = ics.parseIcs(sample, TZ, '2026-10-10', 28).filter((i) => i.title.includes('Pratice'));
  assert.deepEqual(items.map((i) => i.date), ['2026-10-13', '2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29'], 'six counted, the 15th excluded');
  const short = ics.parseIcs(sample, TZ, '2026-10-10', 7).filter((i) => i.title.includes('Pratice'));
  assert.deepEqual(short.map((i) => i.date), ['2026-10-13'], 'horizon cuts the series');
});

test('feed rules: rename, exclude, tag by school and sport', () => {
  const rules = ics.mergeRules({
    rename: [
      { from: '^B1/2 Lions[^v]*vs B1/2 (.+?) Fall \\d{4} - Home Game$', to: 'Soccer vs $1 (home)' },
      { from: '^B1/2 Lions[^v]*vs B1/2 (.+?) Fall \\d{4} - Away Game$', to: 'Soccer vs $1 (away)' },
      { from: '^B1/2 Lions Fall \\d{4} - Prac?tice$', to: 'Soccer practice' },
      { from: '(', to: 'bad regex is skipped' },
    ],
    tag: [{ match: 'Soccer', who: ['Leo'] }],
  }, { exclude: ['Pine Hill Open House'], tag: [{ match: 'Oakwood', who: ['Mia'] }] });
  const out = ics.applyRules(ics.parseIcs(sample, TZ, '2026-10-10', 28), rules, members());
  const titles = out.map((o) => o.title);
  assert.ok(titles.includes('Soccer vs Hawks (away)'));
  assert.ok(titles.includes('Soccer practice'));
  assert.ok(!titles.some((t) => t.includes('Pine Hill')));
  assert.deepEqual(out.find((o) => o.title === 'Soccer practice').for_ids, ['k2']);
  assert.deepEqual(out.find((o) => o.title.startsWith('Oakwood')).for_ids, ['k1']);
  const only = ics.applyRules(ics.parseIcs(sample, TZ, '2026-10-10', 28), { include: ['School'] }, members());
  assert.deepEqual(only.map((o) => o.title).sort(), ['No School', 'Oakwood Middle School Open House']);
});
