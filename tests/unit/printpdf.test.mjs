import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthPdf, buildPdf, pdfLines, pdfString } from '../../web/printpdf.js';

const text = (bytes) => new TextDecoder().decode(bytes);

test('pdf text escapes parentheses and keeps an en dash readable', () => {
  assert.equal(pdfString('Soccer (U10) 3–4pm'), 'Soccer \\(U10\\) 3-4pm');
  assert.equal(pdfString('a\\b'), 'a\\\\b');
});

test('long titles wrap instead of running off the page', () => {
  const line = 'Early drop-off and breakfast club with a very long name that must wrap onto the next line of the printed month';
  const lines = pdfLines(line);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((ln) => ln.length <= 86));
  assert.equal(lines.join(' '), line);
});

test('month pdf is a valid one-column document and grows extra pages', () => {
  const month = ['Alex & Jordan', 'November 2026', ''];
  for (let d = 1; d <= 30; d++) {
    month.push(`Day ${d}`);
    month.push('All day  Nothing scheduled');
    if (d === 18) {
      for (let i = 0; i < 8; i++) month.push(`${i}:00  Event ${i} (gym) · Mia · Alex driving · Bring water`);
    }
  }
  const bytes = buildPdf(month.join('\n'));
  const pdf = text(bytes);
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.ok(pdf.trimEnd().endsWith('%%EOF'));
  assert.equal(pdf.includes('undefined'), false);
  assert.match(pdf, /\/Count 2/);
  assert.match(pdf, /Event 7/);
  assert.match(pdf, /Bring water/);
  assert.match(pdf, /Soccer|Event 0/);
  assert.doesNotMatch(pdf, /\(Event 0 \(gym\)/);

  const startxref = Number(pdf.match(/startxref\n(\d+)/)[1]);
  const entries = pdf.slice(startxref).split('\n').filter((ln) => /^\d{10} 00000 n $/.test(ln));
  assert.equal(entries.length, 7);
  for (const ln of entries) assert.match(pdf.slice(Number(ln.slice(0, 10)), Number(ln.slice(0, 10)) + 12), /^\d+ 0 obj/);

  const streams = [...pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  for (const m of streams) assert.equal(m[2].length, Number(m[1]), 'stream length matches /Length');
});

test('shared month pdf draws the calendar grid and two event columns', () => {
  const days = [];
  const groups = [];
  for (let n = 1; n <= 30; n++) {
    days.push({ n, where: n % 5 === 0 ? "Eli's" : '', colors: n % 3 === 0 ? ['#3F6B54'] : [] });
    if (n % 2 === 0) {
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][(n - 1) % 7];
      groups.push({
        label: `${dow} ${n}`,
        entries: [
          { time: 'All day', title: n === 2 ? 'At Eli\'s' : 'Practice', who: 'Mia & Leo' },
          { time: '5:30p', title: 'Soccer (U10)', who: 'Leo' },
        ],
      });
    }
  }
  groups.push({
    label: 'Wed 18',
    entries: [{ time: '7:30a', title: 'Early drop-off and breakfast club with a very long name that must wrap onto the next line', who: 'Mia' }],
  });
  const pdf = text(buildMonthPdf({ house: 'Sarah & Mikey', label: 'November 2026', startDow: 0, daysIn: 30, today: 11, days, groups }));
  assert.ok(pdf.startsWith('%PDF-1.4\n'));
  assert.match(pdf, /\/BaseFont \/Helvetica-Bold/);
  assert.equal(pdf.includes('undefined'), false);
  assert.doesNotMatch(pdf, /NaN/);
  const streams = [...pdf.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  for (const m of streams) assert.equal(m[2].length, Number(m[1]));
  const page1 = streams[0][2];
  assert.match(page1, /November 2026/);
  assert.match(page1, /Sarah & Mikey/);
  assert.match(page1, /\(EVENTS\)/);
  assert.match(page1, /\(SUN\)/);
  assert.match(page1, /\(30\)/);
  assert.match(page1, / re f/);
  assert.match(page1, / c\n/);
  assert.match(page1, /Eli's/);
  const xs = [...page1.matchAll(/1 0 0 1 (\d+(?:\.\d+)?) /g)].map((m) => Number(m[1]));
  assert.ok(xs.some((x) => x < 80) && xs.some((x) => x > 280), 'events use both columns');
  const all = streams.map((s) => s[2]).join('\n');
  assert.match(all, /Early drop-off/);
  assert.match(all, /Soccer \\\(U10\\\)/);
  assert.match(all, /Mia/);
  assert.match(all, /\(Mon 2\)/);
  assert.doesNotMatch(all, /\(Day /);
});

test('a day that fits stays under one heading; a day taller than a column continues', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, where: '', colors: [] }));
  const filler = Array.from({ length: 20 }, (_, i) => ({ time: `${i}:00`, title: `Errand ${i}`, who: 'Mia' }));
  const huge = Array.from({ length: 55 }, (_, i) => ({ time: `${i}:00`, title: `Lesson ${i}`, who: 'Leo' }));
  const pdf = text(buildMonthPdf({
    house: 'Sarah & Mikey', label: 'November 2026', startDow: 0, daysIn: 30, today: 12, days,
    groups: [
      { label: 'Mon 2', entries: filler },
      { label: 'Wed 18', entries: huge },
    ],
  }));
  const opens = pdf.match(/\(Wed 18\)/g) || [];
  const conts = pdf.match(/Wed 18 \\\(cont\.\\\)/g) || [];
  assert.equal(opens.length, 1, 'the day starts once');
  assert.ok(conts.length >= 1, 'the overflow is marked as a continuation');
  assert.equal((pdf.match(/\(Mon 2\)/g) || []).length, 1, 'a day that fits is not split');
});
