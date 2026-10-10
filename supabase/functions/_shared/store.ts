// Everything the functions read and write, behind one interface so the agent
// and the jobs can be tested against an in-memory copy.

import { normEvent, normIdea, normMember, normPending, type Ev, type Idea, type World } from './domain.ts';
import { eq, type Rest } from './db.ts';
import type { FeedRules } from './ics.ts';

export interface Feed extends FeedRules { name: string; url: string }
export interface DocSource { id: string; name: string; type?: 'doc' | 'pdf'; hint?: string }
export interface SmsRecipient { name: string; number: string; carrier: string }
export interface Settings {
  timezone: string;
  weekly: { enabled: boolean; day: string; hour: number };
  reminders: { enabled: boolean; hour: number };
  digest: { enabled: boolean; hour: number };
  notify: string[];
  sms: { enabled: boolean; weekly: boolean; reminders: boolean; digest: boolean; max_chars: number; recipients: SmsRecipient[] };
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
  notify: [],
  sms: { enabled: false, weekly: true, reminders: true, digest: false, max_chars: 600, recipients: [] },
  feeds: [], docs: [], ics_rules: { rename: [], tag: [] }, max_recurrence_weeks: 4,
};

export interface EventRow {
  title: string; date: string; time: string; for_ids: string[]; driver: string;
  with_us: string[]; place: string; note: string; source: string; created_by?: string;
}

export interface StageRow {
  title: string; date: string; time: string; for_ids: string[]; place: string; note: string;
  confidence: 'high' | 'low'; source: string; source_ref: string;
}
export interface StageResult { added: number; past: number; dupe: number }

export interface Store {
  world(): Promise<World>;
  settings(): Promise<Settings>;
  insertEvent(row: EventRow): Promise<Ev>;
  updateEvent(id: string, patch: Partial<EventRow>): Promise<Ev | null>;
  deleteEvent(id: string): Promise<Ev | null>;
  insertIdea(row: Omit<Idea, 'id'>): Promise<Idea>;
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
  return out;
}

export class RestStore implements Store {
  constructor(private db: Rest) {}

  async world(): Promise<World> {
    const [m, e, p, i] = await Promise.all([
      this.db.select('members', 'select=*&order=sort.asc'),
      this.db.select('events', 'select=*&order=date.asc,time.asc.nullsfirst'),
      this.db.select('pending', 'select=*&order=date.asc'),
      this.db.select('ideas', 'select=*&order=created_at.asc'),
    ]);
    return { members: m.map(normMember), events: e.map(normEvent), pending: p.map(normPending), ideas: i.map(normIdea) };
  }

  async settings(): Promise<Settings> {
    const rows = await this.db.select<{ key: string; value: unknown }>('settings', 'select=key,value');
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = r.value;
    return s as unknown as Settings;
  }

  async insertEvent(row: EventRow) { return normEvent((await this.db.insert('events', toDb(row)))[0]); }
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
  async log(actor: string, action: string, detail: string) {
    try { await this.db.insert('log', { actor, action, detail: detail.slice(0, 2000) }); } catch (e) { console.error('log failed', e); }
  }
}
