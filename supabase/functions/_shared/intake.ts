// Everything that turns outside content into waiting items in the Inbox.
// Calendar files are parsed exactly; anything else is read by Claude. Either way
// the result is queued for a person to approve, never put straight on the calendar.

import { todayIn, weekdayOf, type Member } from './domain.ts';
import { buildPrompt, extractionClosed, parseExtraction, selectDocText, type ExtractKind, type Extracted } from './extract.ts';
import { applyRules, dropPushedCopies, looksLikeIcs, mergeRules, parseIcs, type IcsItem } from './ics.ts';
import { extractionPayload, textOf, type ClaudeFn, type ClaudeReply } from './claude.ts';
import type { DocRead, Feed, Settings, StageRow, Store, DocSource } from './store.ts';
import { syncFeed } from './feedsync.ts';

export interface IntakeDeps { store: Store; claude: ClaudeFn; now?: Date }
export interface IntakeResult {
  found: number; added: number; past: number; dupe: number; parsed: boolean;
  /** Set when a document had no upcoming dates, so Claude was not called. */
  skipped?: 'none';
  input_tokens?: number; output_tokens?: number;
}

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

async function pushedIds(store: Store): Promise<string[]> {
  try { return await store.googleEventIds(); }
  catch { return []; }
}

export async function intakeIcs(d: IntakeDeps, text: string, source: string, ref: string, extra: Partial<Feed> = {}): Promise<IntakeResult> {
  const { s, members, today } = await context(d);
  const items = dropPushedCopies(
    applyRules(parseIcs(text, s.timezone, today, (s.max_recurrence_weeks || 4) * 7), mergeRules(s.ics_rules ?? {}, extra), members),
    await pushedIds(d.store),
  );
  return await stage(d, toStage(items, source, ref), true);
}

export async function intakeText(d: IntakeDeps, text: string, source: string, ref: string, kind: ExtractKind = 'text', hint?: string): Promise<IntakeResult> {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Nothing to read.');
  if (looksLikeIcs(raw)) return await intakeIcs(d, raw, source, ref);
  const { s, members, today } = await context(d);
  const prompt = buildPrompt(kind, { today, weekday: weekdayOf(today), members, maxWeeks: s.max_recurrence_weeks || 4, hint });
  if (kind === 'doc') {
    const body = selectDocText(raw, today);
    if (!body.trim()) return { found: 0, added: 0, past: 0, dupe: 0, parsed: true, skipped: 'none' };
    const read = await readDocument(d, body, prompt, members, source, ref);
    return withUsage(await stage(d, read.rows, false), read.usage);
  }
  // Pasted text is one section a person chose. Cap it so a whole mailbox dump is not billed.
  const r = await d.claude(extractionPayload({ messages: [{ role: 'user', content: `${prompt}TEXT:\n${raw.slice(0, 20_000)}` }] }));
  return withUsage(await stage(d, toStage(eventsFrom(r, members), source, ref), false), usageOf(r));
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
  const r = await d.claude(extractionPayload({ max_tokens: 4000, messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }] }));
  return withUsage(await stage(d, toStage(eventsFrom(r, members), source, ref), false), usageOf(r));
}

/* ---------- scheduled: feeds and shared documents ---------- */

const DOC_READER_VERSION = 2;
const MAX_DOC_FAILS = 3;
/** One split is enough for a month that did not fit. Past that, keep whatever parsed. */
const MAX_DOC_CALLS = 5;

interface TokenUse { input_tokens: number; output_tokens: number }

function usageOf(r: ClaudeReply): TokenUse {
  return { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 };
}

function addUsage(sum: TokenUse, r: ClaudeReply): void {
  sum.input_tokens += r.usage?.input_tokens ?? 0;
  sum.output_tokens += r.usage?.output_tokens ?? 0;
}

function withUsage(result: IntakeResult, usage: TokenUse): IntakeResult {
  if (!usage.input_tokens && !usage.output_tokens) return result;
  return { ...result, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
}

function eventsFrom(r: ClaudeReply, members: Member[]): Extracted[] {
  return parseExtraction(textOf(r.content), members);
}

function splitNearMiddle(text: string): [string, string] | null {
  if (text.length < 1800) return null;
  const mid = Math.floor(text.length / 2);
  let at = text.lastIndexOf('\n', mid);
  if (at < 400) at = text.indexOf('\n', mid);
  if (at < 400 || at > text.length - 400) return null;
  const left = text.slice(0, at).trim();
  const right = text.slice(at).trim();
  if (!left || !right) return null;
  return [left, right];
}

/**
 * Read one document. If the reply is cut off, split the excerpt and read each half.
 * Thinking is disabled and past months are already gone, so this is the rare path.
 */
async function readDocument(d: IntakeDeps, body: string, prompt: string, members: Member[], source: string, ref: string): Promise<{ rows: StageRow[]; usage: TokenUse }> {
  const usage: TokenUse = { input_tokens: 0, output_tokens: 0 };
  let calls = 0;
  const readOne = async (chunk: string, depth: number): Promise<StageRow[]> => {
    if (calls >= MAX_DOC_CALLS) throw new Error('Could not read that. Try a shorter section — just the part with the dates.');
    calls += 1;
    const r = await d.claude(extractionPayload({ messages: [{ role: 'user', content: `${prompt}DOCUMENT:\n${chunk}` }] }));
    addUsage(usage, r);
    const text = textOf(r.content);
    // An unclosed array means the reply was cut off. Prose with no array is a real failure,
    // and splitting it would only spend more calls.
    const truncated = !extractionClosed(text) && (r.stop_reason === 'max_tokens' || text.includes('['));
    if (truncated && depth < 2) {
      const parts = splitNearMiddle(chunk);
      if (parts) return [...await readOne(parts[0], depth + 1), ...await readOne(parts[1], depth + 1)];
    }
    return toStage(eventsFrom(r, members), source, ref);
  };
  return { rows: await readOne(body, 0), usage };
}

export interface PollDeps extends IntakeDeps {
  fetchText(url: string): Promise<string>;
  driveText(id: string): Promise<string>;
  driveBase64(id: string): Promise<string>;
}

async function fingerprint(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function asRead(prev: unknown): DocRead | null {
  if (typeof prev === 'string' && prev) return { hash: prev, ok: true, fails: 0, reader: 1 };
  if (!prev || typeof prev !== 'object') return null;
  const p = prev as Partial<DocRead>;
  if (typeof p.hash !== 'string' || !p.hash) return null;
  return {
    hash: p.hash,
    ok: p.ok === true,
    fails: Number.isFinite(p.fails) ? Number(p.fails) : 0,
    retry_at: typeof p.retry_at === 'string' ? p.retry_at : undefined,
    reader: Number.isFinite(p.reader) ? Number(p.reader) : 0,
  };
}

/** null means "read it". A string is why this hourly run should not call Claude. */
function skipReason(prev: unknown, hash: string, now: Date): 'ok' | 'backoff' | 'given_up' | null {
  const p = asRead(prev);
  if (!p || p.hash !== hash) return null;
  if (p.ok) return 'ok';
  // A newer reader retries a document that this code could not parse before.
  if (p.reader !== DOC_READER_VERSION) return null;
  if (p.fails >= MAX_DOC_FAILS) return 'given_up';
  if (p.retry_at && p.retry_at > now.toISOString()) return 'backoff';
  return null;
}

function skipLine(name: string, reason: 'ok' | 'backoff' | 'given_up'): string {
  if (reason === 'ok') return `${name}: unchanged since last read, skipped`;
  if (reason === 'backoff') return `${name}: unchanged since the last attempt failed, retrying later`;
  return `${name}: unchanged, and reading it failed; waiting until the document changes`;
}

function retryAt(fails: number, now: Date): string | undefined {
  const hours = fails <= 1 ? 6 : fails === 2 ? 24 : 0;
  if (!hours) return undefined;
  return new Date(now.getTime() + hours * 3_600_000).toISOString();
}

export async function pollSources(d: PollDeps, actor: string): Promise<string[]> {
  const s = await d.store.settings();
  const report: string[] = [];
  const own = await pushedIds(d.store);
  for (const f of s.feeds ?? []) {
    try {
      const text = await d.fetchText(f.url);
      if (!looksLikeIcs(text)) throw new Error('not a calendar file');
      if (f.mode === 'sync') {
        const [w, today] = [await d.store.world(), todayIn(s.timezone, d.now ?? new Date())];
        const ruled = applyRules(parseIcs(text, s.timezone, today, f.horizon_days ?? 120), mergeRules(s.ics_rules ?? {}, f), w.members);
        const items = dropPushedCopies(ruled, own);
        // A feed that is only events we already wrote is not an empty calendar. Leave the week alone.
        if (!items.length && ruled.length) {
          report.push(`${f.name}: skipped ${ruled.length} already copied from this app`);
          continue;
        }
        const r = await syncFeed(d.store, f, items, w.members, today);
        report.push(`${f.name}: added ${r.added}, updated ${r.updated}, removed ${r.removed}`);
      } else {
        const r = await intakeIcs(d, text, 'feed', f.url, f);
        report.push(`${f.name}: found ${r.found}, queued ${r.added}, ${r.past} past, ${r.dupe} already known`);
      }
    } catch (e) { report.push(`${f.name}: error ${(e as Error).message}`); }
  }
  // Reading a document costs a Claude call. Skip it when the text is unchanged and the last
  // read succeeded. A failed read is remembered too, and retried at most a few times, so a
  // document that cannot be parsed is not sent again every hour until someone edits it.
  const docs = (s.docs ?? []) as DocSource[];
  const seen: Record<string, string | DocRead> = { ...(s.doc_hashes ?? {}) };
  const now = d.now ?? new Date();
  let seenChanged = false;
  for (const doc of docs) {
    try {
      const ref = `https://drive.google.com/open?id=${doc.id}`;
      const pdf = doc.type === 'pdf';
      const content = pdf ? await d.driveBase64(doc.id) : await d.driveText(doc.id);
      const fp = await fingerprint(`${pdf ? 'pdf' : 'doc'}|${doc.hint ?? ''}|${content}`);
      const reason = skipReason(seen[doc.id], fp, now);
      if (reason) { report.push(skipLine(doc.name, reason)); continue; }
      const prev = asRead(seen[doc.id]);
      try {
        const r = pdf
          ? await intakeFile(d, content, 'application/pdf', 'doc', ref, doc.hint)
          : await intakeText(d, content, 'doc', ref, 'doc', doc.hint);
        seen[doc.id] = { hash: fp, ok: true, fails: 0, reader: DOC_READER_VERSION };
        seenChanged = true;
        const tokens = r.input_tokens || r.output_tokens ? ` (tokens in ${r.input_tokens ?? 0} out ${r.output_tokens ?? 0})` : '';
        report.push(r.skipped
          ? `${doc.name}: no upcoming dates, skipped`
          : `${doc.name}: found ${r.found}, queued ${r.added}, ${r.past} past, ${r.dupe} already known${tokens}`);
      } catch (e) {
        const fails = (prev?.hash === fp ? prev.fails : 0) + 1;
        const retry_at = retryAt(fails, now);
        seen[doc.id] = { hash: fp, ok: false, fails, ...(retry_at ? { retry_at } : {}), reader: DOC_READER_VERSION };
        seenChanged = true;
        report.push(`${doc.name}: error ${(e as Error).message}`);
      }
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
