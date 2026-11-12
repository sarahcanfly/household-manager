// PDFs the phone can share when the installed app cannot open the print dialog.
// Helvetica only, no library: the phone app has no build step.
// buildPdf is the plain-text fallback. buildMonthPdf draws the same calendar
// and two-column list the on-screen preview shows, because iOS Share > Print
// prints the shared file, not the styled web page.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 40;

const GLYPH = {
  '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2022': '*', '\u2026': '...',
};

/** A PDF literal string. Parentheses and anything outside WinAnsi are escaped or dropped. */
export function pdfString(s) {
  let out = '';
  for (const ch of String(s)) {
    const repl = GLYPH[ch] ?? ch;
    for (const c of repl) {
      const code = c.codePointAt(0);
      if (c === '\\' || c === '(' || c === ')') out += '\\' + c;
      else if (code >= 32 && code <= 126) out += c;
      else if (code === 183) out += '\\267';
      else if (code >= 160 && code <= 255) out += '\\' + code.toString(8).padStart(3, '0');
      else if (code === 9) out += ' ';
      else out += '?';
    }
  }
  return out;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  const pushWord = (w) => {
    if (!w) return;
    if (w.length > width) {
      if (line) { out.push(line); line = ''; }
      for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
      return;
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { out.push(line); line = w; }
  };
  String(text).split(/\s+/).forEach(pushWord);
  if (line) out.push(line);
  return out.length ? out : [''];
}

export function pdfLines(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  raw.split('\n').forEach((para) => { wrap(para, 86).forEach((ln) => lines.push(ln)); });
  return lines.length ? lines : [''];
}

function assemble(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < objects.length; i++) pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

function finish(pageBodies, fontCount) {
  const fontId = 3 + pageBodies.length * 2;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  let next = 3;
  const contentAt = {};
  const fonts = fontCount > 1
    ? `/F1 ${fontId} 0 R /F2 ${fontId + 1} 0 R`
    : `/F1 ${fontId} 0 R`;
  pageBodies.forEach((stream) => {
    const pageId = next++;
    const contentId = next++;
    kids.push(pageId);
    contentAt[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << ${fonts} >> >> >>`;
  });
  objects[2] = `<< /Type /Pages /Count ${pageBodies.length} /Kids [${kids.map((id) => id + ' 0 R').join(' ')}] >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  if (fontCount > 1) objects[fontId + 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
  for (const [id, body] of Object.entries(contentAt)) objects[id] = body;
  return assemble(objects);
}

export function buildPdf(text) {
  const lines = pdfLines(text);
  const leading = 14;
  const maxLines = Math.floor((PAGE_H - 54 * 2) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
  if (!pages.length) pages.push(['']);
  const bodies = pages.map((page) => {
    let y = PAGE_H - 54;
    const ops = ['BT', '/F1 11 Tf'];
    page.forEach((line) => {
      ops.push(`1 0 0 1 54 ${y} Tm (${pdfString(line)}) Tj`);
      y -= leading;
    });
    ops.push('ET');
    return ops.join('\n');
  });
  return finish(bodies, 1);
}

const NARROW = { ' ': 278, '.': 278, ',': 278, ':': 278, ';': 278, "'": 191, '|': 278, 'i': 278, 'l': 278, 'I': 278, 'j': 278, 'f': 333, 't': 333, 'r': 333, '-': 333 };
function textWidth(s, size) {
  let u = 0;
  for (const c of String(s)) {
    if (c === 'm' || c === 'w') u += 900;
    else if (c === 'M' || c === 'W') u += 940;
    else if (NARROW[c]) u += NARROW[c];
    else if (c >= '0' && c <= '9') u += 560;
    else if (c !== c.toLowerCase() && c === c.toUpperCase()) u += 740;
    else u += 560;
  }
  return u * size / 1000;
}
function wrapText(text, size, maxW) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > maxW) { lines.push(line); line = word; }
    else line = next;
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}
function circle(cx, cy, r) {
  const k = r * 0.55228475;
  return [
    `${n(cx + r)} ${n(cy)} m`,
    `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
    `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
    `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
    `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c`,
    'f',
  ].join('\n');
}
const n = (v) => Math.round(v * 100) / 100;
function rgbOf(hex) {
  let h = String(hex || '#333333').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((x) => Number.isNaN(x))) return '0.2 0.2 0.2';
  return `${n(r / 255)} ${n(g / 255)} ${n(b / 255)}`;
}
function fit(s, size, max) {
  if (textWidth(s, size) <= max) return s;
  let t = String(s);
  while (t.length > 1 && textWidth(`${t}...`, size) > max) t = t.slice(0, -1);
  return `${t}...`;
}

/** Title in bold, person in regular type, wrapped so spaces stay in the text. */
function entryLines(entry, maxW) {
  const title = wrapText(entry.title || '', 9, maxW);
  const who = entry.who ? ` · ${entry.who}` : '';
  if (!who) return title.map((line) => [{ t: line, bold: true }]);
  const last = title[title.length - 1];
  // Keep the person in the same text run as the title so the gap cannot collapse.
  if (textWidth(last + who, 9) <= maxW) {
    return title.slice(0, -1).map((line) => [{ t: line, bold: true }]).concat([[{ t: last + who, bold: true }]]);
  }
  return title.map((line) => [{ t: line, bold: true }]).concat(wrapText(who.trim(), 9, maxW).map((line) => [{ t: line, bold: false }]));
}

/**
 * A printable month: calendar grid on page 1, then events in two columns.
 * model: { house, label, startDow, daysIn, today, days: [{ n, where, colors }], groups: [{ label, entries: [{ time, title, who }] }] }
 */
export function buildMonthPdf(model) {
  const m = model || {};
  const daysIn = Math.max(1, Math.min(31, m.daysIn || 30));
  const startDow = Math.max(0, Math.min(6, m.startDow || 0));
  const byN = {};
  (m.days || []).forEach((d) => { byN[d.n] = d; });
  const weeks = Math.ceil((startDow + daysIn) / 7);
  const inner = PAGE_W - MARGIN * 2;
  const cellW = inner / 7;
  const headH = 16, cellH = 36;
  const gridH = headH + weeks * cellH;
  const colGap = 16;
  const colW = (inner - colGap) / 2;
  const titleW = colW - 58;

  const pages = [];
  let ops = [];
  const cmd = (s) => ops.push(s);
  const textAt = (s, x, y, size, bold, color) => {
    cmd(color ? `${color} rg` : '0 0 0 rg');
    cmd('BT');
    cmd(`/${bold ? 'F2' : 'F1'} ${size} Tf`);
    cmd(`1 0 0 1 ${n(x)} ${n(y)} Tm (${pdfString(s)}) Tj`);
    cmd('ET');
  };
  const house = m.house || 'Household';
  const label = m.label || '';
  textAt(house, MARGIN, PAGE_H - MARGIN - 14, 16, true);
  textAt(label, MARGIN, PAGE_H - MARGIN - 30, 12, true);
  const gridTop = PAGE_H - MARGIN - 42;
  const dows = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  dows.forEach((d, i) => {
    const x = MARGIN + i * cellW;
    const y = gridTop - headH;
    cmd('0.93 0.93 0.93 rg');
    cmd(`${n(x)} ${n(y)} ${n(cellW)} ${headH} re f`);
    cmd('0.75 0.75 0.75 RG');
    cmd('0.6 w');
    cmd(`${n(x)} ${n(y)} ${n(cellW)} ${headH} re S`);
    textAt(d, x + (cellW - textWidth(d, 7)) / 2, y + 5, 7, true);
  });
  for (let i = 0; i < weeks * 7; i++) {
    const col = i % 7, row = Math.floor(i / 7);
    const x = MARGIN + col * cellW;
    const y = gridTop - headH - (row + 1) * cellH;
    const dn = i - startDow + 1;
    const on = dn >= 1 && dn <= daysIn;
    cmd(on ? '1 1 1 rg' : '0.96 0.96 0.96 rg');
    cmd(`${n(x)} ${n(y)} ${n(cellW)} ${cellH} re f`);
    cmd('0.78 0.78 0.78 RG');
    cmd(`${n(x)} ${n(y)} ${n(cellW)} ${cellH} re S`);
    if (!on) continue;
    const info = byN[dn] || {};
    const today = m.today === dn;
    if (today) {
      cmd('0 0 0 rg');
      cmd(circle(x + 11, y + cellH - 12, 7));
      textAt(String(dn), x + (dn > 9 ? 5.5 : 8.5), y + cellH - 15, 8, true, '1 1 1');
    } else textAt(String(dn), x + 4, y + cellH - 12, 8, true);
    if (info.where) textAt(fit(info.where, 6, cellW - 8), x + 3, y + 13, 6, false, '0.35 0.35 0.35');
    (info.colors || []).slice(0, 6).forEach((hex, k) => {
      cmd(`${rgbOf(hex)} rg`);
      cmd(circle(x + 6 + k * 7, y + 6, 2.2));
    });
  }

  let col = 0;
  let yL = gridTop - gridH - 28;
  let yR = yL;
  textAt('EVENTS', MARGIN, yL + 10, 9, true);
  const yOf = () => (col === 0 ? yL : yR);
  const setY = (v) => { if (col === 0) yL = v; else yR = v; };
  const xOf = () => MARGIN + col * (colW + colGap);
  function advance() {
    if (col === 0) { col = 1; return; }
    pages.push(ops.join('\n'));
    ops = [];
    col = 0;
    textAt(label ? `${label}  continued` : 'continued', MARGIN, PAGE_H - MARGIN - 12, 10, true);
    yL = yR = PAGE_H - MARGIN - 28;
  }
  function roomFor(h) {
    if (yOf() - h >= MARGIN) return;
    advance();
    if (yOf() - h < MARGIN) advance();
  }

  const groups = m.groups || [];
  if (!groups.length) textAt('Nothing scheduled this month.', MARGIN, yOf() - 14, 10, false);
  groups.forEach((group) => {
    const entries = (group.entries || []).map((entry) => ({ entry, lines: entryLines(entry, titleW) }));
    const firstH = entries.length ? entries[0].lines.length * 11 + 3 : 0;
    roomFor(16 + firstH);
    const lx = xOf();
    const top = yOf();
    textAt(group.label || '', lx, top - 11, 10, true);
    cmd('0.8 0.8 0.8 RG');
    cmd('0.6 w');
    cmd(`${n(lx)} ${n(top - 14)} m`);
    cmd(`${n(lx + colW)} ${n(top - 14)} l`);
    cmd('S');
    setY(top - 16);
    entries.forEach(({ entry, lines }, idx) => {
      const h = lines.length * 11 + 3;
      const before = `${col}:${n(yOf())}`;
      roomFor(h);
      if (`${col}:${n(yOf())}` !== before && idx > 0) {
        textAt(group.label || '', xOf(), yOf() - 11, 10, true);
        setY(yOf() - 16);
        roomFor(h);
      }
      const ey = yOf();
      textAt(entry.time || '', xOf(), ey - 9, 8, false, '0.25 0.25 0.25');
      lines.forEach((words, i) => {
        let cursor = xOf() + 54;
        words.forEach((word) => {
          textAt(word.t, cursor, ey - 9 - i * 11, 9, word.bold);
          cursor += textWidth(word.t, 9);
        });
      });
      setY(ey - h);
    });
    setY(yOf() - 6);
  });
  pages.push(ops.join('\n'));
  return finish(pages.filter((body) => body.length), 2);
}
