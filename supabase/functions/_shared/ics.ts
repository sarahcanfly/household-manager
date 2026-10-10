// Calendar files (.ics): parse, expand simple repeats, convert to household time,
// and apply the feed's rename / exclude / tag rules. Pure; no network.

import { addDays, wallToUtc, weekdayOf, zoned, type Member } from './domain.ts';

export interface IcsItem { title: string; date: string; time: string; place: string; note: string; for_ids: string[] }
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

/** Dates for a simple DAILY/WEEKLY rule, from the first occurrence up to `until`. Others: first only. */
function expand(first: string, rrule: string, until: string, exdates: Set<string>): string[] {
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const ruleUntil = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : '9999-12-31';
  const last = ruleUntil < until ? ruleUntil : until;
  const out: string[] = [];
  if (freq !== 'DAILY' && freq !== 'WEEKLY') return exdates.has(first) ? [] : [first];
  const byDay = freq === 'WEEKLY' && r.BYDAY
    ? r.BYDAY.split(',').map((c: string) => DAY_CODES.indexOf(c.slice(-2))).filter((i: number) => i >= 0)
    : null;
  const firstDow = DAY_CODES.indexOf(weekdayOf(first).slice(0, 2).toUpperCase());
  let n = 0;
  for (let i = 0; i < 400 && out.length < 120; i++) {
    const day = addDays(first, i);
    if (day > last || n >= count) break;
    const diffDays = i;
    let hit: boolean;
    if (freq === 'DAILY') hit = diffDays % interval === 0;
    else {
      const week = Math.floor((diffDays + firstDow) / 7);
      const dow = DAY_CODES.indexOf(weekdayOf(day).slice(0, 2).toUpperCase());
      hit = week % interval === 0 && (byDay ? byDay.includes(dow) : dow === firstDow);
    }
    if (!hit) continue;
    n++;
    if (!exdates.has(day)) out.push(day);
  }
  return out;
}

export function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text) && /BEGIN:VEVENT/i.test(text);
}

/** Every event in the file, in household time, expanded up to `horizonDays` ahead of today. */
export function parseIcs(text: string, tz: string, today: string, horizonDays = 28): IcsItem[] {
  const out: IcsItem[] = [];
  let cur: Prop[] | null = null;
  for (const raw of unfold(text)) {
    const line = raw.trimEnd();
    if (/^BEGIN:VEVENT$/i.test(line)) { cur = []; continue; }
    if (/^END:VEVENT$/i.test(line)) {
      if (cur) out.push(...eventFrom(cur, tz, today, horizonDays));
      cur = null; continue;
    }
    if (cur) { const p = parseLine(line); if (p) cur.push(p); }
  }
  return out;
}

function eventFrom(props: Prop[], tz: string, today: string, horizonDays: number): IcsItem[] {
  const get = (n: string) => props.find((p) => p.name === n);
  if ((get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return [];
  const start = get('DTSTART');
  const title = unescape(get('SUMMARY')?.value ?? '').trim();
  if (!start || !title) return [];
  const local = toLocal(start, tz);
  if (!local) return [];
  const place = unescape(get('LOCATION')?.value ?? '').trim().slice(0, 120);
  const note = unescape(get('DESCRIPTION')?.value ?? '').trim().slice(0, 500);
  const ex = new Set<string>();
  for (const p of props.filter((q) => q.name === 'EXDATE')) {
    for (const v of p.value.split(',')) { const l = toLocal({ ...p, value: v }, tz); if (l) ex.add(l.date); }
  }
  const rrule = get('RRULE')?.value;
  const dates = rrule ? expand(local.date, rrule, addDays(today, horizonDays), ex) : [local.date];
  return dates.map((date) => ({ title, date, time: local.time, place, note, for_ids: [] }));
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
    if ((rules.exclude ?? []).some((x) => lower(title).includes(lower(x)) || lower(it.title).includes(lower(x)))) continue;
    if (rules.include?.length && !rules.include.some((x) => lower(title).includes(lower(x)))) continue;
    const ids = new Set(it.for_ids);
    for (const t of rules.tag ?? []) if (lower(title).includes(lower(t.match))) for (const id of idsFor(t.who)) ids.add(id);
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
