// Calendars trusted enough to go straight onto the household calendar, such as a
// shared co-parenting calendar. Unlike ordinary feeds (which queue for approval),
// these are kept in step: new events are added, changed ones updated, removed ones
// deleted. Only events from the last two weeks onward are touched.
//
// Settings shape (in the "feeds" list):
// { "name": "Co-parent", "url": "webcal://…", "mode": "sync",
//   "default_for": ["Kid1", "Kid2"],                      // who an event is for when no tag matches
//   "tag": [{ "match": "Kid1", "who": ["Kid1"] }],
//   "custody": [{ "match": "@Home's", "with_us": ["Kid1", "Kid2"] },
//               { "match": "@Other's", "with_us": [] }],   // custody days: no driving needed
//   (match is plain text or a /pattern/; add "where": "Jenn's" when the title has no "@ Name")
//   "horizon_days": 120 }

import { addDays, type Member } from './domain.ts';
import { matches, type IcsItem, type FeedRules } from './ics.ts';

export interface CustodyRule { match: string; with_us: string[]; where?: string }
export interface SyncFeedConfig extends FeedRules {
  name: string; url: string; mode?: 'sync' | 'approve';
  default_for?: string[]; custody?: CustodyRule[]; horizon_days?: number;
}

export interface FeedRow {
  uid: string; title: string; date: string; time: string; for_ids: string[];
  with_us: string[]; place: string; note: string; driver: string;
  custody?: string;
}
export interface ExistingRow extends FeedRow { id: string }

const lower = (s: string) => s.toLowerCase();
const idsFor = (names: string[] = [], members: Member[]) => names
  .map((n) => members.find((m) => m.active && lower(m.name) === lower(n))?.id)
  .filter((x): x is string => !!x);

/** What the household calendar should hold for this feed. Items have already had rename/exclude/tag applied. */
export function desiredRows(items: IcsItem[], feed: SyncFeedConfig, members: Member[]): FeedRow[] {
  const fallback = idsFor(feed.default_for, members);
  const seen = new Set<string>();
  const out: FeedRow[] = [];
  for (const it of items) {
    if (seen.has(it.uid)) continue;
    seen.add(it.uid);
    const custody = (feed.custody ?? []).find((c) => matches(c.match, it.title));
    const for_ids = it.for_ids.length ? it.for_ids : fallback;
    out.push({
      uid: it.uid, title: it.title, date: it.date, time: it.time, for_ids,
      with_us: custody ? idsFor(custody.with_us, members) : [],
      place: it.place, note: it.note,
      driver: custody ? 'none' : '',
      custody: custody ? (custody.where?.trim().slice(0, 40) || custodyPlace(it.title)) : '',
    });
  }
  return out;
}

/** Whose house a custody event means: the text after "@" ("A&O @Eli's" -> "Eli's"), else the title. */
export function custodyPlace(title: string): string {
  const m = title.match(/@\s*(.+)$/);
  return (m ? m[1] : title).trim().slice(0, 40);
}

const sameSet = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',');

/**
 * Insert, update and delete needed to make the calendar match the feed from `from` on.
 * The feed owns title, date, time, place, note, who and custody; a driver picked in the
 * app is kept (except custody days, which never need one).
 */
export function planSync(desired: FeedRow[], existing: ExistingRow[], from: string) {
  const want = desired.filter((d) => d.date >= from);
  const have = new Map(existing.filter((e) => e.date >= from).map((e) => [e.uid, e]));
  const insert: FeedRow[] = [];
  const update: { id: string; patch: Partial<FeedRow> }[] = [];
  for (const d of want) {
    const e = have.get(d.uid);
    if (!e) { insert.push(d); continue; }
    have.delete(d.uid);
    const patch: Partial<FeedRow> = {};
    if (e.title !== d.title) patch.title = d.title;
    if (e.date !== d.date) patch.date = d.date;
    if (e.time !== d.time) patch.time = d.time;
    if (e.place !== d.place) patch.place = d.place;
    if (e.note !== d.note) patch.note = d.note;
    if (!sameSet(e.for_ids, d.for_ids)) patch.for_ids = d.for_ids;
    if (!sameSet(e.with_us, d.with_us)) patch.with_us = d.with_us;
    if (d.driver === 'none' && e.driver !== 'none') patch.driver = 'none';
    if ((e.custody ?? '') !== (d.custody ?? '')) patch.custody = d.custody ?? '';
    if (Object.keys(patch).length) update.push({ id: e.id, patch });
  }
  return { insert, update, remove: [...have.values()].map((e) => e.id) };
}

export interface SyncStore {
  feedEvents(feed: string): Promise<ExistingRow[]>;
  insertFeedEvents(feed: string, rows: FeedRow[]): Promise<void>;
  patchFeedEvent(id: string, patch: Partial<FeedRow>): Promise<void>;
  deleteEvents(ids: string[]): Promise<void>;
}

export async function syncFeed(store: SyncStore, feed: SyncFeedConfig, items: IcsItem[], members: Member[], today: string) {
  const desired = desiredRows(items, feed, members);
  const existing = await store.feedEvents(feed.name);
  // A calendar that suddenly reads as empty is far more likely a hiccup than a real wipe.
  if (!desired.length && existing.length) throw new Error('the calendar came back empty, so nothing was removed');
  const plan = planSync(desired, existing, addDays(today, -14));
  if (plan.insert.length) await store.insertFeedEvents(feed.name, plan.insert);
  for (const u of plan.update) await store.patchFeedEvent(u.id, u.patch);
  if (plan.remove.length) await store.deleteEvents(plan.remove);
  return { added: plan.insert.length, updated: plan.update.length, removed: plan.remove.length };
}
