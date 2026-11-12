import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, pdfLines, pdfString } from '../../web/printpdf.js';

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
