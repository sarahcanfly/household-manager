// In-memory stand-ins for the database and Claude, shared by the unit tests.
const B = '../../.build/supabase/functions/_shared/';
export const domain = await import(B + 'domain.js');
export const { DEFAULT_SETTINGS } = await import(B + 'store.js');

export const plus = (n, from = new Date()) => {
  const d = new Date(from); d.setDate(d.getDate() + n);
  return domain.todayIn('America/New_York', d);
};

export function members() {
  return [
    { id: 's1', name: 'Alex', kind: 'adult', color: '#3F6B54', active: true, sort: 0 },
    { id: 'm1', name: 'Jordan', kind: 'adult', color: '#8E4767', active: true, sort: 1 },
    { id: 'k1', name: 'Mia', kind: 'kid', color: '#3B5A8A', active: true, sort: 2 },
    { id: 'k2', name: 'Leo', kind: 'kid', color: '#A8752A', active: true, sort: 3 },
    { id: 'k3', name: 'Ivy', kind: 'kid', color: '#2E6E75', active: true, sort: 4 },
    { id: 'x1', name: 'Rose', kind: 'other', color: '#9A4B2E', active: true, sort: 5 },
    { id: 'old', name: 'Oldie', kind: 'kid', color: '#000', active: false, sort: 6 },
  ];
}

export const task = (o) => ({ id: 't' + Math.random().toString(36).slice(2, 7), title: 'Form', due: plus(2), for_ids: [], note: '', done: false, source: 'manual', ...o });
export const ev = (o) => ({ id: 'e' + Math.random().toString(36).slice(2, 7), title: 'Thing', date: plus(3), time: '', for_ids: [], driver: '', with_us: [], place: '', note: '', source: 'manual', ...o });

export class MemoryStore {
  constructor({ events = [], pending = [], ideas = [], tasks = [], settings = {} } = {}) {
    this.m = members(); this.events = events; this.pending = pending; this.ideas = ideas; this.tasks = tasks;
    this.s = { ...DEFAULT_SETTINGS, ...settings }; this.tokens = new Map(); this.logs = []; this.n = 0;
  }
  async world() { return structuredClone({ members: this.m, events: this.events, pending: this.pending, ideas: this.ideas, tasks: this.tasks }); }
  async insertTaste(row) { (this.taste = this.taste || []).push(row); }
  async insertTask(row) { const t = { id: 't' + (++this.n), done: false, ...row }; delete t.created_by; this.tasks.push(t); return structuredClone(t); }
  async updateTask(id, patch) { const t = this.tasks.find((x) => x.id === id); if (!t) return null; Object.assign(t, patch); return structuredClone(t); }
  async settings() { return structuredClone(this.s); }
  async insertEvent(row) { const e = ev({ ...row, id: 'n' + (++this.n) }); delete e.created_by; this.events.push(e); return structuredClone(e); }
  async insertEvents(rows) { for (const r of rows) await this.insertEvent(r); return rows.length; }
  async deleteSeries(series, from) { const gone = this.events.filter((e) => e.series === series && e.date >= from); this.events = this.events.filter((e) => !gone.includes(e)); return gone; }
  async updateEvent(id, patch) { const e = this.events.find((x) => x.id === id); if (!e) return null; Object.assign(e, patch); return structuredClone(e); }
  async deleteEvent(id) { const i = this.events.findIndex((x) => x.id === id); if (i < 0) return null; return this.events.splice(i, 1)[0]; }
  async insertIdea(row) { const it = { id: 'i' + (++this.n), ...row }; this.ideas.push(it); return it; }
  async putToken(action, args, summary) { const t = crypto.randomUUID(); this.tokens.set(t, { action, args, summary }); return t; }
  async redeemToken(t) { const v = this.tokens.get(t); this.tokens.delete(t); return v ? { action: v.action, args: v.args } : null; }
  async stage(rows) {
    const today = domain.todayIn(this.s.timezone);
    let added = 0, past = 0, dupe = 0;
    for (const r of rows) {
      if (r.date < today) { past++; continue; }
      const key = (x) => `${x.title.toLowerCase()}|${x.date}|${x.time}`;
      if (this.events.some((e) => key(e) === key(r)) || this.pending.some((p) => key(p) === key(r))) { dupe++; continue; }
      this.pending.push({ id: 'p' + (++this.n), ...r }); added++;
    }
    return { added, past, dupe };
  }
  async feedEvents(feed) { return structuredClone(this.events.filter((e) => e.feed === feed).map((e) => ({ ...e, uid: e.feed_uid }))); }
  async insertFeedEvents(feed, rows) { for (const r of rows) { const { uid, ...rest } = r; this.events.push(ev({ ...rest, id: 'f' + (++this.n), feed, feed_uid: uid, source: `sync:${feed}` })); } this.batches = (this.batches || 0) + 1; }
  async patchFeedEvent(id, patch) { const e = this.events.find((x) => x.id === id); if (e) Object.assign(e, patch); }
  async deleteEvents(ids) { this.events = this.events.filter((e) => !ids.includes(e.id)); }
  async log(actor, action, detail) { this.logs.push({ actor, action, detail }); }
}

/** Claude stand-in: replays scripted replies and records every request. */
export function fakeClaude(script) {
  const calls = [];
  const fn = async (payload) => {
    calls.push(structuredClone(payload));
    const next = script.shift();
    if (!next) throw new Error('no scripted reply');
    return typeof next === 'function' ? next(payload) : next;
  };
  fn.calls = calls;
  return fn;
}
export const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
let tid = 0;
export const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + (++tid), name, input }] });
export const useMany = (...calls) => ({ stop_reason: 'tool_use', content: calls.map(([name, input]) => ({ type: 'tool_use', id: 't' + (++tid), name, input })) });
export const lastToolResults = (claude) => claude.calls.at(-1).messages.at(-1).content;
