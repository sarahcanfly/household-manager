// Everything the functions read and write, behind one interface so the agent
// and the jobs can be tested against an in-memory copy.

import { normEvent, normIdea, normMember, normPending, normTask, addDays, type Ev, type Idea, type Task, type World } from './domain.ts';
import { eq, type Rest } from './db.ts';
import type { FeedRules } from './ics.ts';
import type { ExistingRow, FeedRow, SyncFeedConfig, SyncStore } from './feedsync.ts';
import { DEFAULT_LOCAL, type LocalSettings } from './localevents.ts';

export type Feed = SyncFeedConfig;
export interface DocSource { id: string; name: string; type?: 'doc' | 'pdf'; hint?: string }
export interface SmsRecipient { name: string; number: string; carrier?: string }   // carrier only matters without Twilio
export interface Settings {
  timezone: string;
  weekly: { enabled: boolean; day: string; hour: number };
  reminders: { enabled: boolean; hour: number };
  digest: { enabled: boolean; hour: number };
  morning: { enabled: boolean; hour: number; email: boolean };
  local_events: LocalSettings;
  notify: string[];
  sms: { enabled: boolean; weekly: boolean; reminders: boolean; digest: boolean; morning?: boolean; max_chars: number; recipients: SmsRecipient[] };
  push: { weekly: boolean; reminders: boolean; digest: boolean };
  feeds: Feed[];
  docs: DocSource[];
  ics_rules: FeedRules;
  max_recurrence_weeks: number;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: 'America/New_York',
  weekly: { enabled: true, day: 'MONDAY', hour: 7 },
  reminders: { enabled: true, hour: 18 },
  digest: { enabled: true, hour: 19 },
  morning: { enabled: true, hour: 7, email: false },
  local_events: DEFAULT_LOCAL,
  notify: [],
  sms: { enabled: false, weekly: true, reminders: true, digest: false, max_chars: 600, recipients: [] },
  push: { weekly: true, reminders: true, digest: true },
  feeds: [], docs: [], ics_rules: { rename: [], tag: [] }, max_recurrence_weeks: 4,
};

export interface EventRow {
  title: string; date: string; time: string; for_ids: string[]; driver: string;
  with_us: string[]; place: string; note: string; source: string; created_by?: string;
  end_time?: string; series?: string;
}

export interface StageRow {
  title: string; date: string; time: string; for_ids: string[]; place: string; note: string;
  confidence: 'high' | 'low'; source: string; source_ref: string; kind?: 'event' | 'task';
}
export interface TaskRow { title: string; due: string; for_ids: string[]; note: string; source: string; created_by?: string }
export type TaskPatch = Partial<Pick<Task, 'title' | 'due' | 'for_ids' | 'note' | 'done'>>;
export interface StageResult { added: number; past: number; dupe: number }

export interface Store extends SyncStore {
  world(): Promise<World>;
  settings(): Promise<Settings>;
  insertEvent(row: EventRow): Promise<Ev>;
  /** Many at once (one request, so the calendar sync runs once). */
  insertEvents(rows: EventRow[]): Promise<number>;
  deleteSeries(series: string, from: string): Promise<Ev[]>;
  updateEvent(id: string, patch: Partial<EventRow>): Promise<Ev | null>;
  deleteEvent(id: string): Promise<Ev | null>;
  insertIdea(row: Omit<Idea, 'id'>): Promise<Idea>;
  insertTask(row: TaskRow): Promise<Task>;
  updateTask(id: string, patch: TaskPatch): Promise<Task | null>;
  putToken(action: 'update' | 'delete', args: Record<string, unknown>, summary: string, by: string): Promise<string>;
  redeemToken(token: string): Promise<{ action: 'update' | 'delete'; args: Record<string, unknown> } | null>;
  stage(rows: StageRow[]): Promise<StageResult>;
  log(actor: string, action: string, detail: string): Promise<void>;
}

/** Database columns use null for "all day" and "driver undecided"; the app uses ''. */
function toDb(p: Partial<EventRow>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  if ('time' in p) out.time = p.time || null;
  if ('driver' in p) out.driver = p.driver || null;
  if ('end_time' in p) out.end_time = p.end_time || null;
  return out;
}

export class RestStore implements Store {
  constructor(private db: Rest) {}

  async world(): Promise<World> {
    // Open to-dos, plus ones due in the last two months so "did we send the form?" can be answered.
    const recent = addDays(new Date().toISOString().slice(0, 10), -60);
    const [m, e, p, i, t] = await Promise.all([
      this.db.select('members', 'select=*&order=sort.asc'),
      this.db.select('events', 'select=*&order=date.asc,time.asc.nullsfirst'),
      this.db.select('pending', 'select=*&order=date.asc'),
      this.db.select('ideas', 'select=*&order=created_at.asc'),
      this.db.select('tasks', `select=*&or=(done.is.false,due.gte.${recent})&order=due.asc`),
    ]);
    return { members: m.map(normMember), events: e.map(normEvent), pending: p.map(normPending), ideas: i.map(normIdea), tasks: t.map(normTask) };
  }

  async settings(): Promise<Settings> {
    const rows = await this.db.select<{ key: string; value: unknown }>('settings', 'select=key,value');
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = r.value;
    return s as unknown as Settings;
  }

  async insertEvent(row: EventRow) { return normEvent((await this.db.insert('events', toDb(row)))[0]); }
  async insertEvents(rows: EventRow[]) {
    if (!rows.length) return 0;
    await this.db.req('POST', 'events', rows.map(toDb), 'return=minimal');
    return rows.length;
  }
  async deleteSeries(series: string, from: string) {
    if (!series) return [];
    return (await this.db.remove('events', `series=${eq(series)}&date=gte.${from}`)).map(normEvent);
  }
  async updateEvent(id: string, patch: Partial<EventRow>) {
    const r = await this.db.update('events', `id=${eq(id)}`, toDb(patch));
    return r[0] ? normEvent(r[0]) : null;
  }
  async deleteEvent(id: string) {
    const r = await this.db.remove('events', `id=${eq(id)}`);
    return r[0] ? normEvent(r[0]) : null;
  }
  async insertIdea(row: Omit<Idea, 'id'>) {
    return normIdea((await this.db.insert('ideas', { ...row, date: row.date || null, time: row.time || null }))[0]);
  }
  async insertTask(row: TaskRow) { return normTask((await this.db.insert('tasks', row))[0]); }
  async updateTask(id: string, patch: TaskPatch) {
    const body: Record<string, unknown> = { ...patch };
    if ('done' in patch) body.done_at = patch.done ? new Date().toISOString() : null;
    const r = await this.db.update('tasks', `id=${eq(id)}`, body);
    return r[0] ? normTask(r[0]) : null;
  }
  async putToken(action: 'update' | 'delete', args: Record<string, unknown>, summary: string, by: string) {
    const r = await this.db.insert<{ token: string }>('agent_pending', { action, args, summary, created_by: by });
    return r[0].token;
  }
  async redeemToken(token: string) {
    if (!/^[0-9a-f-]{36}$/i.test(token)) return null;
    const r = await this.db.rpc<{ token: string | null; action: 'update' | 'delete'; args: Record<string, unknown> } | null>('redeem_agent_token', { t: token });
    return r && r.token ? { action: r.action, args: r.args } : null;
  }
  async stage(rows: StageRow[]) {
    if (!rows.length) return { added: 0, past: 0, dupe: 0 };
    return await this.db.rpc<StageResult>('stage_pending', { rows });
  }
  async feedEvents(feed: string): Promise<ExistingRow[]> {
    const rows = await this.db.select('events', `select=*&feed=${eq(feed)}`);
    return rows.map((r) => ({ ...normEvent(r), uid: String(r.feed_uid ?? '') }));
  }
  async insertFeedEvents(feed: string, rows: FeedRow[]) {
    // One request, so the calendar sync is triggered once rather than once per event.
    await this.db.req('POST', 'events', rows.map((r) => ({
      title: r.title, date: r.date, time: r.time || null, for_ids: r.for_ids, with_us: r.with_us,
      driver: r.driver || null, place: r.place, note: r.note, source: `sync:${feed}`, created_by: feed, custody: r.custody ?? '',
      feed, feed_uid: r.uid,
    })), 'return=minimal');
  }
  async patchFeedEvent(id: string, patch: Partial<FeedRow>) {
    const { uid: _uid, ...rest } = patch;
    await this.db.update('events', `id=${eq(id)}`, toDb(rest as Partial<EventRow>));
  }
  async deleteEvents(ids: string[]) {
    if (!ids.length) return;
    await this.db.req('DELETE', `events?id=in.(${ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',')})`, undefined, 'return=minimal');
  }
  async log(actor: string, action: string, detail: string) {
    try { await this.db.insert('log', { actor, action, detail: detail.slice(0, 2000) }); } catch (e) { console.error('log failed', e); }
  }
}
