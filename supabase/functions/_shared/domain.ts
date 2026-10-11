// Pure household logic: no network, no database. Shared by every function and
// unit-tested directly.

export type Kind = 'adult' | 'kid' | 'other';
export interface Member { id: string; name: string; kind: Kind; color: string; active: boolean; sort: number }
export interface Ev {
  id: string; title: string; date: string; time: string;          // time '' = all day, else 'HH:MM'
  for_ids: string[]; driver: string; with_us: string[];            // driver '' undecided, 'none', or member id
  place: string; note: string; source: string;
  end_time?: string;                                               // '' or 'HH:MM'
  series?: string;                                                 // shared by the events of one repeating series
  custody?: string;                                                // on custody days from the co-parent calendar: whose house, e.g. "Eli's"
}
export interface Pending {
  id: string; title: string; date: string; time: string; for_ids: string[];
  place: string; note: string; source: string; source_ref: string; confidence: 'high' | 'low';
  kind?: 'event' | 'task';
}
/** Something to do by a date (a form, a sign-up, a payment). Not on the calendar. */
export interface Task { id: string; title: string; due: string; for_ids: string[]; note: string; done: boolean; source: string }
export interface Idea { id: string; title: string; date: string; time: string; for_ids: string[]; cost: string; link: string; note: string }
export interface World { members: Member[]; events: Ev[]; pending: Pending[]; ideas: Idea[]; tasks?: Task[] }

export const DEFAULT_DURATION_MIN = 60;
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* ---------- normalising rows from the database ---------- */

export const hhmm = (t: unknown): string => {
  const m = String(t ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
};
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string => (v == null ? '' : String(v));

export function normEvent(r: Record<string, unknown>): Ev {
  return {
    id: str(r.id), title: str(r.title), date: str(r.date).slice(0, 10), time: hhmm(r.time),
    for_ids: arr(r.for_ids), driver: str(r.driver), with_us: arr(r.with_us),
    place: str(r.place), note: str(r.note), source: str(r.source), custody: str(r.custody),
    end_time: hhmm(r.end_time), series: str(r.series),
  };
}
export function normTask(r: Record<string, unknown>): Task {
  return {
    id: str(r.id), title: str(r.title), due: str(r.due).slice(0, 10), for_ids: arr(r.for_ids),
    note: str(r.note), done: r.done === true, source: str(r.source),
  };
}
export function normPending(r: Record<string, unknown>): Pending {
  return {
    id: str(r.id), title: str(r.title), date: str(r.date).slice(0, 10), time: hhmm(r.time),
    for_ids: arr(r.for_ids), place: str(r.place), note: str(r.note), source: str(r.source),
    source_ref: str(r.source_ref), confidence: r.confidence === 'low' ? 'low' : 'high',
    kind: r.kind === 'task' ? 'task' : 'event',
  };
}
export function normIdea(r: Record<string, unknown>): Idea {
  return {
    id: str(r.id), title: str(r.title), date: str(r.date).slice(0, 10), time: hhmm(r.time),
    for_ids: arr(r.for_ids), cost: str(r.cost), link: str(r.link), note: str(r.note),
  };
}
export function normMember(r: Record<string, unknown>): Member {
  const k = str(r.kind);
  return {
    id: str(r.id), name: str(r.name), kind: (k === 'adult' || k === 'kid' ? k : 'other') as Kind,
    color: str(r.color) || '#5C6763', active: r.active !== false, sort: Number(r.sort) || 0,
  };
}

/* ---------- dates in the household's timezone ---------- */

/** Y-M-D, H:M and weekday of an instant, as seen in a timezone. */
export function zoned(d: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour), weekday: String(parts.weekday),
  };
}

export const todayIn = (tz: string, now = new Date()) => zoned(now, tz).date;

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** The UTC instant at which a wall-clock time occurs in a timezone (handles DST). */
export function wallToUtc(ymd: string, time: string, tz: string): Date {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = (time || '00:00').split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(guess), tz);
    const seen = Date.UTC(+z.date.slice(0, 4), +z.date.slice(5, 7) - 1, +z.date.slice(8, 10), +z.time.slice(0, 2), +z.time.slice(3, 5));
    const want = Date.UTC(y, mo - 1, d, h, mi);
    if (seen === want) break;
    guess += want - seen;
  }
  return new Date(guess);
}

export function prettyTime(t: string): string {
  if (!t) return 'all day';
  const [hs, m] = t.split(':');
  let h = Number(hs);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + (m === '00' ? '' : ':' + m) + ap;
}

export function prettyDate(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${weekdayOf(ymd).slice(0, 3)} ${MONTHS[m - 1]} ${d}`;
}

/* ---------- people ---------- */

export const byId = (members: Member[]) => new Map(members.map((m) => [m.id, m]));

export function namesOf(ids: string[], members: Member[]): string[] {
  const map = byId(members);
  return [...ids].sort((a, b) => (map.get(a)?.sort ?? 99) - (map.get(b)?.sort ?? 99))
    .map((id) => map.get(id)?.name).filter((n): n is string => !!n);
}

export function hasKid(ids: string[], members: Member[]): boolean {
  const map = byId(members);
  return ids.some((id) => map.get(id)?.kind === 'kid');
}

/** "3pm", or "3–4:30pm" with an end time. */
export function timeRange(time: string, end?: string): string {
  if (!time || !end || end <= time) return prettyTime(time);
  const a = prettyTime(time), b = prettyTime(end);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

export function describe(e: Pick<Ev, 'title' | 'date' | 'time' | 'for_ids'> & { end_time?: string }, members: Member[]): string {
  const who = namesOf(e.for_ids, members);
  return `${e.title} (${prettyDate(e.date)}, ${timeRange(e.time, e.end_time)}${who.length ? ', ' + who.join(' & ') : ''})`;
}

/* ---------- conflicts and missing drivers ---------- */

const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const endOf = (e: Ev) => (e.end_time && e.end_time > e.time ? minutes(e.end_time) : minutes(e.time) + DEFAULT_DURATION_MIN);
const overlaps = (a: Ev, b: Ev) => minutes(a.time) < endOf(b) && minutes(b.time) < endOf(a);

export interface Conflict { date: string; a: Ev; b: Ev; why: string[] }

/** Same person in two places, same driver on two runs, or a driver who has their own appointment. */
export function conflicts(events: Ev[], members: Member[]): Conflict[] {
  const map = byId(members), name = (id: string) => map.get(id)?.name ?? id;
  const timed = events.filter((e) => e.time);
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i], b = timed[j];
      if (a.date !== b.date || !overlaps(a, b)) continue;
      const why: string[] = [];
      for (const id of a.for_ids) if (b.for_ids.includes(id)) why.push(`${name(id)} is in both`);
      const realDriver = (d: string) => d && d !== 'none';
      if (realDriver(a.driver) && a.driver === b.driver) why.push(`${name(a.driver)} is driving both`);
      if (realDriver(a.driver) && b.for_ids.includes(a.driver) && !a.for_ids.includes(a.driver)) why.push(`${name(a.driver)} is driving "${a.title}" but has "${b.title}"`);
      if (realDriver(b.driver) && a.for_ids.includes(b.driver) && !b.for_ids.includes(b.driver)) why.push(`${name(b.driver)} is driving "${b.title}" but has "${a.title}"`);
      if (why.length) out.push({ date: a.date, a, b, why });
    }
  }
  return out;
}

export const conflictLine = (c: Conflict) =>
  `${prettyDate(c.date)}: ${c.a.title} ${prettyTime(c.a.time)} vs ${c.b.title} ${prettyTime(c.b.time)} (${c.why.join('; ')})`;

/** A kid's timed event that nobody has been assigned to drive to. */
export const needsDriver = (e: Ev, members: Member[]) =>
  !!e.time && !e.driver && hasKid(e.for_ids, members);

/* ---------- custody days ---------- */

/** Kids at another house on one date. Several co-parent calendars can each add a group. */
export interface CustodyGroup { kids: string[]; where: string }
export interface CustodyDay { away: string[]; groups: CustodyGroup[] }

/** Which kids are at another house on each date, from the co-parent calendars' custody events. */
export function custodyDays(events: Ev[]): Map<string, CustodyDay> {
  const out = new Map<string, CustodyDay>();
  for (const e of events) {
    if (!e.custody) continue;
    const away = e.for_ids.filter((id) => !e.with_us.includes(id));
    if (!away.length) continue;
    const day = out.get(e.date) ?? { away: [], groups: [] };
    let g = day.groups.find((x) => x.where === e.custody);
    if (!g) { g = { kids: [], where: e.custody }; day.groups.push(g); }
    for (const id of away) {
      if (!g.kids.includes(id)) g.kids.push(id);
      if (!day.away.includes(id)) day.away.push(id);
    }
    out.set(e.date, day);
  }
  return out;
}

/** "Aaron & Ozzie at Eli's; Reid at Jenn's" for one day, or '' when everyone is home. */
export function custodyLabel(day: CustodyDay | undefined, members: Member[]): string {
  return day ? day.groups.map((g) => `${namesOf(g.kids, members).join(' & ')} at ${g.where}`).join('; ') : '';
}

/** Consecutive days with the same arrangement, from `from` for `days` days: "Mon Oct 12 – Wed Oct 14: A & O at Eli's". */
export function custodyRanges(events: Ev[], from: string, days: number, members: Member[]): string[] {
  const map = custodyDays(events), out: string[] = [];
  let start = '', prev = '', label = '';
  const flush = () => { if (label) out.push(`${prettyDate(start)}${prev !== start ? ` – ${prettyDate(prev)}` : ''}: ${label}`); };
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i), l = custodyLabel(map.get(d), members);
    if (l !== label) { flush(); start = d; label = l; }
    prev = d;
  }
  flush();
  return out;
}

export interface AwayClash { e: Ev; kids: string[]; where: string }

/**
 * Timed events of ours for a kid on a day that kid is at another house. Events
 * from synced calendars are the other parent's own, so they never count.
 */
export function awayClashes(events: Ev[], members: Member[]): AwayClash[] {
  const map = custodyDays(events), out: AwayClash[] = [];
  for (const e of events) {
    if (!e.time || e.custody || e.source.startsWith('sync:')) continue;
    const day = map.get(e.date);
    if (!day) continue;
    for (const g of day.groups) {
      const kids = e.for_ids.filter((id) => g.kids.includes(id));
      if (kids.length) out.push({ e, kids, where: g.where });
    }
  }
  return out;
}

/** Kids in this event who are at another house that day (their other parent has them). */
export function awayKids(e: Ev, events: Ev[]): string[] {
  const day = custodyDays(events.filter((x) => x.date === e.date)).get(e.date);
  return day ? e.for_ids.filter((id) => day.away.includes(id)) : [];
}

/** Needs one of us to drive: a kid event with no driver, unless every kid in it is with their other parent that day. */
export function needsOurDriver(e: Ev, events: Ev[], members: Member[]): boolean {
  if (!needsDriver(e, members)) return false;
  const kids = e.for_ids.filter((id) => members.find((m) => m.id === id)?.kind === 'kid');
  const away = awayKids(e, events);
  return !kids.every((id) => away.includes(id));
}

export const awayLine = (c: AwayClash, members: Member[]) =>
  `${prettyDate(c.e.date)} ${prettyTime(c.e.time)} ${c.e.title}: ${namesOf(c.kids, members).join(' & ')} ${c.kids.length > 1 ? 'are' : 'is'} at ${c.where} that day`;

/* ---------- to-dos ---------- */

/** "overdue", "today", "tomorrow", or "Wed Oct 14". */
export function dueLabel(due: string, today: string): string {
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  return prettyDate(due);
}

/** Open to-dos due by `until` (inclusive), overdue first. */
export function tasksDueBy(tasks: Task[] | undefined, until: string): Task[] {
  return (tasks ?? []).filter((t) => !t.done && t.due <= until).sort((a, b) => a.due.localeCompare(b.due));
}

/* ---------- validating what the agent asks for ---------- */

export class Invalid extends Error {}

export function resolveName(name: string, members: Member[]): Member {
  const active = members.filter((m) => m.active);
  const q = String(name ?? '').trim().toLowerCase();
  const exact = active.filter((m) => m.name.toLowerCase() === q);
  const hits = exact.length ? exact : q ? active.filter((m) => m.name.toLowerCase().startsWith(q)) : [];
  if (hits.length === 1) return hits[0];
  throw new Invalid(`${hits.length ? 'More than one person matches' : 'Nobody in the household is called'} "${name}". Members: ${active.map((m) => m.name).join(', ')}`);
}

function resolveNames(v: unknown, members: Member[]): Member[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const seen = new Set<string>(), out: Member[] = [];
  for (const n of list) {
    if (!String(n).trim()) continue;
    const m = resolveName(String(n), members);
    if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  }
  return out;
}

export function validDate(s: string, today: string, pastDays = 60, futureDays = 800): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Invalid(`date must be YYYY-MM-DD, got "${s}"`);
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Invalid(`${s} is not a real date`);
  if (s < addDays(today, -pastDays) || s > addDays(today, futureDays)) throw new Invalid(`${s} is outside the range I schedule in. Check the year with the person.`);
  return s;
}

export function validTime(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Invalid(`time must be HH:mm in 24-hour form, got "${s}"`);
  return m[1].padStart(2, '0') + ':' + m[2];
}

export interface Fields {
  title?: string; date?: string; time?: string; end_time?: string; for_ids?: string[]; driver?: string;
  with_us?: string[]; place?: string; note?: string;
}

/** Turns names into ids and checks every field. partial=true for edits (only fields given). */
export function cleanFields(input: Record<string, unknown>, members: Member[], today: string, partial: boolean): Fields {
  const has = (k: string) => input[k] !== undefined && input[k] !== null;
  const out: Fields = {};
  if (has('title')) {
    out.title = String(input.title).trim().slice(0, 200);
    if (!out.title) throw new Invalid('title cannot be empty');
  } else if (!partial) throw new Invalid('title is required');
  if (has('date')) out.date = validDate(String(input.date).trim(), today);
  else if (!partial) throw new Invalid('date is required');
  if (has('time')) out.time = validTime(input.time); else if (!partial) out.time = '';
  if (has('end_time')) out.end_time = validTime(input.end_time); else if (!partial) out.end_time = '';
  if (out.end_time && out.time !== undefined && (!out.time || out.end_time <= out.time)) throw new Invalid('end_time must be after the start time');
  if (has('for')) out.for_ids = resolveNames(input.for, members).map((m) => m.id);
  else if (!partial) out.for_ids = [];
  if (has('driver')) {
    const d = String(input.driver).trim();
    if (!d) out.driver = '';
    else if (d.toLowerCase() === 'none') out.driver = 'none';
    else {
      const m = resolveName(d, members);
      if (m.kind === 'kid') throw new Invalid(`${m.name} is a kid and cannot be the driver`);
      out.driver = m.id;
    }
  } else if (!partial) out.driver = '';
  if (has('with_us')) {
    out.with_us = resolveNames(input.with_us, members).map((m) => {
      if (m.kind !== 'kid') throw new Invalid(`"with us" is for kids; ${m.name} is not one`);
      return m.id;
    });
  } else if (!partial) out.with_us = [];
  if (has('where')) out.place = String(input.where).trim().slice(0, 300); else if (!partial) out.place = '';
  if (has('note')) out.note = String(input.note).trim().slice(0, 1000); else if (!partial) out.note = '';
  return out;
}

const FILL_ONLY: Record<string, keyof Ev> = { driver: 'driver', with_us: 'with_us', where: 'place', note: 'note' };

/** True when an edit only fills in blanks (driver, with us, place, note): safe to apply without asking. */
export function isFillOnly(cur: Ev, input: Record<string, unknown>): boolean {
  const keys = Object.keys(input).filter((k) => k !== 'id');
  if (!keys.length) return false;
  return keys.every((k) => {
    const col = FILL_ONLY[k];
    if (!col) return false;
    const now = cur[col];
    const wasBlank = Array.isArray(now) ? now.length === 0 : !now;
    const v = input[k];
    const givenBlank = Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
    return wasBlank && !givenBlank;
  });
}

/** Human-readable list of what an edit would change. Empty means nothing would. */
export function diff(cur: Ev, f: Fields, members: Member[]): string[] {
  const name = (id: string) => byId(members).get(id)?.name ?? id;
  const same = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',');
  const driverLabel = (d: string) => (d === 'none' ? 'no driving needed' : d ? name(d) : 'not set');
  const out: string[] = [];
  if (f.title !== undefined && f.title !== cur.title) out.push(`title: ${cur.title} -> ${f.title}`);
  if (f.date !== undefined && f.date !== cur.date) out.push(`date: ${prettyDate(cur.date)} -> ${prettyDate(f.date)}`);
  if (f.time !== undefined && f.time !== cur.time) out.push(`time: ${prettyTime(cur.time)} -> ${prettyTime(f.time)}`);
  if (f.end_time !== undefined && f.end_time !== (cur.end_time ?? '')) out.push(`ends: ${cur.end_time ? prettyTime(cur.end_time) : 'not set'} -> ${f.end_time ? prettyTime(f.end_time) : 'not set'}`);
  if (f.for_ids !== undefined && !same(f.for_ids, cur.for_ids)) out.push(`for: ${namesOf(cur.for_ids, members).join(', ') || 'nobody'} -> ${namesOf(f.for_ids, members).join(', ') || 'nobody'}`);
  if (f.driver !== undefined && f.driver !== cur.driver) out.push(`driver: ${driverLabel(cur.driver)} -> ${driverLabel(f.driver)}`);
  if (f.with_us !== undefined && !same(f.with_us, cur.with_us)) out.push(`with us: ${namesOf(cur.with_us, members).join(', ') || 'nobody'} -> ${namesOf(f.with_us, members).join(', ') || 'nobody'}`);
  if (f.place !== undefined && f.place !== cur.place) out.push(`where: ${cur.place || 'blank'} -> ${f.place || 'blank'}`);
  if (f.note !== undefined && f.note !== cur.note) out.push('note changed');
  return out;
}
