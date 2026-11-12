// A small text PDF so the phone can share a month the print dialog cannot open.
// Helvetica, one column, plain ASCII. No library: the phone app has no build step.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 54, FONT = 11, LEADING = 14, COLS = 86;

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

const GLYPH = {
  '\u2013': '-', '\u2014': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2022': '*', '\u00b7': '|', '\u2026': '...',
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
      else if (code >= 160 && code <= 255) out += '\\' + code.toString(8).padStart(3, '0');
      else if (code === 9) out += ' ';
      else out += '?';
    }
  }
  return out;
}

export function pdfLines(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  raw.split('\n').forEach((para) => { wrap(para, COLS).forEach((ln) => lines.push(ln)); });
  return lines.length ? lines : [''];
}

export function buildPdf(text) {
  const lines = pdfLines(text);
  const maxLines = Math.floor((PAGE_H - MARGIN * 2) / LEADING);
  const pages = [];
  for (let i = 0; i < lines.length; i += maxLines) pages.push(lines.slice(i, i + maxLines));
  if (!pages.length) pages.push(['']);

  const fontId = 3 + pages.length * 2;
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = [];
  let next = 3;
  const contentAt = {};
  pages.forEach((page) => {
    const pageId = next++;
    const contentId = next++;
    kids.push(pageId);
    let y = PAGE_H - MARGIN;
    const ops = ['BT', `/F1 ${FONT} Tf`];
    page.forEach((line) => {
      ops.push(`1 0 0 1 ${MARGIN} ${y} Tm (${pdfString(line)}) Tj`);
      y -= LEADING;
    });
    ops.push('ET');
    const stream = ops.join('\n');
    contentAt[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  });
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.map((id) => id + ' 0 R').join(' ')}] >>`;
  objects[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (const [id, body] of Object.entries(contentAt)) objects[id] = body;

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
