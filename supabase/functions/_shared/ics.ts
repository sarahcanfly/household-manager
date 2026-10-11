// Calendar files (.ics): parse, expand simple repeats, convert to household time,
// and apply the feed's rename / exclude / tag rules. Pure; no network.

import { addDays, wallToUtc, weekdayOf, zoned, type Member } from './domain.ts';

// uid identifies one day of one event in the source calendar, so a synced copy can be updated or removed later.
export interface IcsItem { title: string; date: string; time: string; place: string; note: string; for_ids: string[]; uid: string }
export interface FeedRules {
  exclude?: string[]; include?: string[];
  rename?: { from: string; to: string }[];
  tag?: { match: string; who: string[] }[];
}

const unescape = (v: string) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

interface Prop { name: string; params: Record<string, string>; value: string }
function parseLine(line: string): Prop | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...rest] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rest) { const [k, v] = p.split('='); if (k) params[k.toUpperCase()] = (v ?? '').replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** A DTSTART-style value as household-local date and time ('' time = all day). */
function toLocal(p: Prop, tz: string): { date: string; time: string } | null {
  const v = p.value.trim();
  const d = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (d || p.params.VALUE === 'DATE') {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, time: '' } : null;
  }
  const t = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!t) return null;
  const ymd = `${t[1]}-${t[2]}-${t[3]}`, hm = `${t[4]}:${t[5]}`;
  let instant: Date;
  if (t[7]) instant = new Date(`${ymd}T${hm}:00Z`);
  else if (p.params.TZID) {
    try { instant = wallToUtc(ymd, hm, p.params.TZID); } catch { instant = wallToUtc(ymd, hm, tz); }
  } else return { date: ymd, time: hm };            // floating time: already local
  const z = zoned(instant, tz);
  return { date: z.date, time: z.time };
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Dates for a simple DAILY/WEEKLY rule between `from` and `until`. Other rules: first occurrence only. */
function expand(first: string, rrule: string, from: string, until: string, exdates: Set<string>): string[] {
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const ruleUntil = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : '9999-12-31';
  const last = ruleUntil < until ? ruleUntil : until;
  const out: string[] = [];
  if (freq === 'YEARLY' || freq === 'MONTHLY') {
    // Same day of the year (birthdays) or of the month, every INTERVAL years/months.
    const [fy, fm, fd] = first.split('-').map(Number);
    for (let k = 0, n = 0; k < 600 && n < count; k += interval) {
      const y = freq === 'YEARLY' ? fy + k : fy + Math.floor((fm - 1 + k) / 12);
      const m = freq === 'YEARLY' ? fm : ((fm - 1 + k) % 12) + 1;
      const dt = new Date(Date.UTC(y, m - 1, fd));
      if (dt.getUTCMonth() !== m - 1) continue;                       // no Feb 30th
      const day = dt.toISOString().slice(0, 10);
      if (day > last) break;
      n++;
      if (day >= from && !exdates.has(day)) out.push(day);
    }
    return out;
  }
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return exdates.has(first) || first < from ? [] : [first];
  const byDay = freq === 'WEEKLY' && r.BYDAY
    ? r.BYDAY.split(',').map((c: string) => DAY_CODES.indexOf(c.slice(-2))).filter((i: number) => i >= 0)
    : null;
  const firstDow = DAY_CODES.indexOf(weekdayOf(first).slice(0, 2).toUpperCase());
  let n = 0;
  // Walk every day from the first occurrence (COUNT and INTERVAL are counted from there),
  // keeping only the days inside the window. Ten years of days is still cheap.
  for (let i = 0; i < 3700 && out.length < 400; i++) {
    const day = addDays(first, i);
    if (day > last || n >= count) break;
    let hit: boolean;
    if (freq === 'DAILY') hit = i % interval === 0;
    else {
      const week = Math.floor((i + firstDow) / 7);
      const dow = DAY_CODES.indexOf(weekdayOf(day).slice(0, 2).toUpperCase());
      hit = week % interval === 0 && (byDay ? byDay.includes(dow) : dow === firstDow);
    }
    if (!hit) continue;
    n++;
    if (day >= from && !exdates.has(day)) out.push(day);
  }
  return out;
}

const daysBetween = (a: string, b: string) => {
  const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
};

export function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text) && /BEGIN:VEVENT/i.test(text);
}

/**
 * Every event in the file, in household time, from two weeks back to `horizonDays` ahead.
 * Repeats are expanded, moved or cancelled single occurrences are respected, and an
 * all-day event spanning several days becomes one entry per day.
 */
export function parseIcs(text: string, tz: string, today: string, horizonDays = 28): IcsItem[] {
  const raw: Prop[][] = [];
  let cur: Prop[] | null = null, nested = 0;
  for (const line0 of unfold(text)) {
    const line = line0.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = []; nested = 0; continue; }
    if (/^END:VEVENT$/i.test(line)) { if (cur) raw.push(cur); cur = null; continue; }
    if (!cur) continue;
    // Alarms and other blocks inside an event carry their own UID/DESCRIPTION lines: skip them.
    if (/^BEGIN:/i.test(line)) { nested++; continue; }
    if (/^END:/i.test(line)) { nested = Math.max(0, nested - 1); continue; }
    if (nested) continue;
    const p = parseLine(line); if (p) cur.push(p);
  }
  // A changed single occurrence arrives as its own event with a RECURRENCE-ID; the series must skip that date.
  const moved = new Map<string, Set<string>>();
  for (const props of raw) {
    const uid = props.find((p) => p.name === 'UID')?.value, rid = props.find((p) => p.name === 'RECURRENCE-ID');
    if (!uid || !rid) continue;
    const l = toLocal(rid, tz);
    if (l) { if (!moved.has(uid)) moved.set(uid, new Set()); moved.get(uid)!.add(l.date); }
  }
  return raw.flatMap((props) => eventFrom(props, tz, today, horizonDays, moved));
}

function eventFrom(props: Prop[], tz: string, today: string, horizonDays: number, moved: Map<string, Set<string>>): IcsItem[] {
  const get = (n: string) => props.find((p) => p.name === n);
  if ((get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return [];
  const start = get('DTSTART');
  const title = unescape(get('SUMMARY')?.value ?? '').trim();
  if (!start || !title) return [];
  const local = toLocal(start, tz);
  if (!local) return [];
  const uid = (get('UID')?.value ?? '').trim() || `${title}|${local.date}`;
  const place = unescape(get('LOCATION')?.value ?? '').trim().slice(0, 120);
  const note = unescape(get('DESCRIPTION')?.value ?? '').trim().slice(0, 500);

  let span = 1;
  const end = get('DTEND');
  const e = end ? toLocal(end, tz) : null;
  if (!local.time && e) span = Math.min(31, Math.max(1, daysBetween(local.date, e.date)));
  else if (local.time && e && e.date > local.date) {
    // A timed stay of a day or more ("Fri 10am – Mon 11am") becomes all-day entries, like a
    // multi-day all-day event: each day it covers, counting the last day only if it ends after noon.
    const days = daysBetween(local.date, e.date) + (e.time >= '12:00' ? 1 : 0);
    const hours = daysBetween(local.date, e.date) * 24 + (Number(e.time.slice(0, 2)) - Number(local.time.slice(0, 2)));
    if (hours >= 24 && days >= 1) { span = Math.min(31, days); local.time = ''; }
  }

  const ex = new Set<string>(get('RECURRENCE-ID') ? [] : (moved.get(uid) ?? []));
  for (const p of props.filter((q) => q.name === 'EXDATE')) {
    for (const v of p.value.split(',')) { const l = toLocal({ ...p, value: v }, tz); if (l) ex.add(l.date); }
  }
  const from = addDays(today, -14), until = addDays(today, horizonDays);
  const rrule = get('RRULE')?.value;
  const starts = rrule && !get('RECURRENCE-ID') ? expand(local.date, rrule, addDays(from, -(span - 1)), until, ex) : [local.date];
  const out: IcsItem[] = [];
  for (const s0 of starts) {
    for (let k = 0; k < span; k++) {
      const date = addDays(s0, k);
      if (date > until) break;
      out.push({ title, date, time: local.time, place, note, for_ids: [], uid: `${uid}|${date}` });
    }
  }
  return out;
}

/** A rule matches as plain text (any case), or as a pattern when written like /pattern/. */
export function matches(rule: string, title: string): boolean {
  const m = rule.match(/^\/(.+)\/$/);
  if (m) { try { return new RegExp(m[1], 'i').test(title); } catch { return false; } }
  return title.toLowerCase().includes(rule.toLowerCase());
}

/** Rename, drop, and assign people. Names in rules, not ids, so rules survive a roster rebuild. */
export function applyRules(items: IcsItem[], rules: FeedRules, members: Member[]): IcsItem[] {
  const lower = (s: string) => s.toLowerCase();
  const idsFor = (names: string[]) => names
    .map((n) => members.find((m) => m.active && lower(m.name) === lower(n))?.id)
    .filter((x): x is string => !!x);
  const out: IcsItem[] = [];
  for (const it of items) {
    let title = it.title;
    for (const r of rules.rename ?? []) {
      let re: RegExp;
      try { re = new RegExp(r.from); } catch { continue; }
      if (re.test(title)) { title = title.replace(re, r.to); break; }
    }
    if ((rules.exclude ?? []).some((x) => matches(x, title) || matches(x, it.title))) continue;
    if (rules.include?.length && !rules.include.some((x) => matches(x, title) || matches(x, it.title))) continue;
    const ids = new Set(it.for_ids);
    for (const t of rules.tag ?? []) if (matches(t.match, title)) for (const id of idsFor(t.who)) ids.add(id);
    out.push({ ...it, title: title.slice(0, 120), for_ids: [...ids] });
  }
  return out;
}

export function mergeRules(a: FeedRules, b: FeedRules): FeedRules {
  return {
    exclude: [...(a.exclude ?? []), ...(b.exclude ?? [])],
    include: [...(a.include ?? []), ...(b.include ?? [])],
    rename: [...(a.rename ?? []), ...(b.rename ?? [])],
    tag: [...(a.tag ?? []), ...(b.tag ?? [])],
  };
}
