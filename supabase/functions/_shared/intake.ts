// Everything that turns outside content into waiting items in the Inbox.
// Calendar files are parsed exactly; anything else is read by Claude. Either way
// the result is queued for a person to approve, never put straight on the calendar.

import { todayIn, weekdayOf, type Member } from './domain.ts';
import { buildPrompt, parseExtraction, type ExtractKind, type Extracted } from './extract.ts';
import { applyRules, looksLikeIcs, mergeRules, parseIcs, type IcsItem } from './ics.ts';
import { textOf, type ClaudeFn } from './claude.ts';
import type { Feed, Settings, StageRow, Store, DocSource } from './store.ts';
import { syncFeed } from './feedsync.ts';

export interface IntakeDeps { store: Store; claude: ClaudeFn; now?: Date }
export interface IntakeResult { found: number; added: number; past: number; dupe: number; parsed: boolean }

const toStage = (rows: (Extracted | IcsItem)[], source: string, ref: string): StageRow[] =>
  rows.map((r) => ({
    title: r.title, date: r.date, time: r.time, for_ids: r.for_ids, place: r.place, note: r.note,
    confidence: 'confidence' in r ? r.confidence : 'high', source, source_ref: ref.slice(0, 500),
    kind: 'kind' in r ? r.kind : 'event',
  }));

async function context(d: IntakeDeps): Promise<{ s: Settings; members: Member[]; today: string }> {
  const [s, w] = await Promise.all([d.store.settings(), d.store.world()]);
  return { s, members: w.members, today: todayIn(s.timezone, d.now ?? new Date()) };
}

async function stage(d: IntakeDeps, rows: StageRow[], parsed: boolean): Promise<IntakeResult> {
  const r = await d.store.stage(rows);
  return { found: rows.length, ...r, parsed };
}

export async function intakeIcs(d: IntakeDeps, text: string, source: string, ref: string, extra: Partial<Feed> = {}): Promise<IntakeResult> {
  const { s, members, today } = await context(d);
  const items = applyRules(parseIcs(text, s.timezone, today, (s.max_recurrence_weeks || 4) * 7), mergeRules(s.ics_rules ?? {}, extra), members);
  return await stage(d, toStage(items, source, ref), true);
}

export async function intakeText(d: IntakeDeps, text: string, source: string, ref: string, kind: ExtractKind = 'text', hint?: string): Promise<IntakeResult> {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('Nothing to read.');
  if (looksLikeIcs(body)) return await intakeIcs(d, body, source, ref);
  const { s, members, today } = await context(d);
  const prompt = buildPrompt(kind, { today, weekday: weekdayOf(today), members, maxWeeks: s.max_recurrence_weeks || 4, hint });
  const r = await d.claude({ max_tokens: 4000, messages: [{ role: 'user', content: `${prompt}${kind === 'doc' ? 'DOCUMENT' : 'TEXT'}:\n${body.slice(0, 40000)}` }] });
  return await stage(d, toStage(parseExtraction(textOf(r.content), members), source, ref), false);
}

export async function intakeFile(d: IntakeDeps, base64: string, mediaType: string, source: string, ref: string, hint?: string): Promise<IntakeResult> {
  if (!base64) throw new Error('Nothing to read.');
  const isPdf = mediaType === 'application/pdf';
  if (!isPdf && !/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) throw new Error(`Cannot read ${mediaType} files.`);
  if (base64.length > 7_000_000) throw new Error('That file is too large. Try a smaller photo or a single page.');
  const { s, members, today } = await context(d);
  const prompt = buildPrompt(isPdf ? 'pdf' : 'photo', { today, weekday: weekdayOf(today), members, maxWeeks: s.max_recurrence_weeks || 4, hint });
  const block = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
  const r = await d.claude({ max_tokens: 4000, messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }] });
  return await stage(d, toStage(parseExtraction(textOf(r.content), members), source, ref), false);
}

/* ---------- scheduled: feeds and shared documents ---------- */

export interface PollDeps extends IntakeDeps {
  fetchText(url: string): Promise<string>;
  driveText(id: string): Promise<string>;
  driveBase64(id: string): Promise<string>;
}

async function fingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function pollSources(d: PollDeps, actor: string): Promise<string[]> {
  const s = await d.store.settings();
  const report: string[] = [];
  for (const f of s.feeds ?? []) {
    try {
      const text = await d.fetchText(f.url);
      if (!looksLikeIcs(text)) throw new Error('not a calendar file');
      if (f.mode === 'sync') {
        const [w, today] = [await d.store.world(), todayIn(s.timezone, d.now ?? new Date())];
        const items = applyRules(parseIcs(text, s.timezone, today, f.horizon_days ?? 120), mergeRules(s.ics_rules ?? {}, f), w.members);
        const r = await syncFeed(d.store, f, items, w.members, today);
        report.push(`${f.name}: added ${r.added}, updated ${r.updated}, removed ${r.removed}`);
      } else {
        const r = await intakeIcs(d, text, 'feed', f.url, f);
        report.push(`${f.name}: found ${r.found}, queued ${r.added}, ${r.past} past, ${r.dupe} already known`);
      }
    } catch (e) { report.push(`${f.name}: error ${(e as Error).message}`); }
  }
  // Reading a document costs a Claude call, so only do it when the document has changed since it was
  // last read. The fingerprint is saved only after a successful read, so a failure is retried next hour.
  const docs = (s.docs ?? []) as DocSource[];
  const seen: Record<string, string> = { ...(s.doc_hashes ?? {}) };
  let seenChanged = false;
  for (const doc of docs) {
    try {
      const ref = `https://drive.google.com/open?id=${doc.id}`;
      const pdf = doc.type === 'pdf';
      const content = pdf ? await d.driveBase64(doc.id) : await d.driveText(doc.id);
      const fp = await fingerprint(`${pdf ? 'pdf' : 'doc'}|${doc.hint ?? ''}|${content}`);
      if (seen[doc.id] === fp) { report.push(`${doc.name}: unchanged since last read, skipped`); continue; }
      const r = pdf
        ? await intakeFile(d, content, 'application/pdf', 'doc', ref, doc.hint)
        : await intakeText(d, content, 'doc', ref, 'doc', doc.hint);
      seen[doc.id] = fp; seenChanged = true;
      report.push(`${doc.name}: found ${r.found}, queued ${r.added}, ${r.past} past, ${r.dupe} already known`);
    } catch (e) { report.push(`${doc.name}: error ${(e as Error).message}`); }
  }
  const ids = new Set(docs.map((x) => x.id));
  for (const id of Object.keys(seen)) if (!ids.has(id)) { delete seen[id]; seenChanged = true; }   // forget removed documents
  if (seenChanged) {
    try { await d.store.setSetting('doc_hashes', seen); } catch { /* worst case the next run reads the document again */ }
  }
  for (const line of report) await d.store.log(actor, 'poll', line);
  return report;
}
