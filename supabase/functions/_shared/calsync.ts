// Mirror the events table onto a Google Calendar. One way: the database is the
// truth; edits made in Google Calendar are overwritten on the next change.

import { addDays, hasKid, namesOf, type Ev, type Member, type World } from './domain.ts';

// Google Calendar colour ids: 10 Basil, 3 Grape, 9 Blueberry, 6 Tangerine, 7 Peacock, 11 Tomato, 2 Sage, 5 Banana, 8 Graphite
const COLOR_IDS = ['10', '3', '9', '6', '7', '11', '2', '5'];
export const PAST_DAYS = 14, FUTURE_DAYS = 400, DURATION_MIN = 60, REMINDER_MIN = 45, MAX_OPS = 60;

export interface Desired {
  id: string; title: string; description: string; place: string;
  date: string; time: string; endTime?: string; allDay: boolean; colorId: string; hash: string;
}

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function calendarTitle(e: Ev, members: Member[], today: string): string {
  const names = namesOf(e.for_ids, members);
  const householdSize = members.filter((m) => m.active && m.kind !== 'other').length;
  const everyone = names.length > 2 && names.length >= householdSize;
  const low = e.title.toLowerCase();
  let title = e.title;
  const kids = members.filter((m) => m.active && m.kind === 'kid').map((m) => m.id);
  const allKids = kids.length >= 2 && kids.every((id) => e.for_ids.includes(id)) && e.for_ids.length === kids.length;
  const synced = (e.source || '').startsWith('sync:');   // titles from a shared calendar already say who
  if (names.length && !everyone && !synced && !names.some((n) => low.includes(n.toLowerCase()))) title += allKids ? ' (kids)' : ` (${names.join(' & ')})`;
  const missingDriver = !!e.time && !e.driver && hasKid(e.for_ids, members) && e.date >= today;
  return missingDriver ? `⚠ ${title}` : title;
}

export function calendarDescription(e: Ev, members: Member[]): string {
  const map = new Map(members.map((m) => [m.id, m]));
  const lines: string[] = [];
  const who = namesOf(e.for_ids, members);
  if (who.length) lines.push(`For: ${who.join(', ')}`);
  if (e.driver === 'none') lines.push('No driving needed');
  else if (e.driver) lines.push(`Driver: ${map.get(e.driver)?.name ?? 'someone'}`);
  else if (hasKid(e.for_ids, members)) lines.push('Driver: not assigned');
  const withUs = namesOf(e.with_us, members);
  if (withUs.length) lines.push(`With us: ${withUs.join(', ')}`);
  if (e.note) lines.push('', e.note);
  lines.push('', 'Synced from Household Manager. Edit it there; changes made in Calendar get overwritten.');
  return lines.join('\n');
}

export async function desiredEvents(world: World, today: string): Promise<Desired[]> {
  const from = addDays(today, -PAST_DAYS), to = addDays(today, FUTURE_DAYS);
  const index = new Map(world.members.map((m, i) => [m.id, i]));
  const out: Desired[] = [];
  for (const e of world.events) {
    if (e.date < from || e.date > to) continue;
    const title = calendarTitle(e, world.members, today);
    const description = calendarDescription(e, world.members);
    const colorId = e.for_ids.length === 1 && index.has(e.for_ids[0]) ? COLOR_IDS[index.get(e.for_ids[0])! % COLOR_IDS.length] : '8';
    out.push({
      id: e.id, title, description, place: e.place, date: e.date, time: e.time, endTime: e.end_time || '', allDay: !e.time, colorId,
      hash: await sha256(JSON.stringify([title, description, e.place, e.date, e.time, colorId, ...(e.end_time ? [e.end_time] : [])])),
    });
  }
  return out;
}

/** Wall-clock arithmetic: the date and time `mins` after a local date/time. */
export function addMinutes(date: string, time: string, mins: number): { date: string; time: string } {
  const total = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + mins;
  const dayShift = Math.floor(total / 1440), rem = ((total % 1440) + 1440) % 1440;
  return { date: addDays(date, dayShift), time: `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}` };
}

export function gcalBody(d: Desired, tz: string): Record<string, unknown> {
  const base = {
    summary: d.title, description: d.description, location: d.place || '', colorId: d.colorId,
    extendedProperties: { private: { hmId: d.id } },
  };
  if (d.allDay) {
    return { ...base, start: { date: d.date }, end: { date: addDays(d.date, 1) }, reminders: { useDefault: false, overrides: [] } };
  }
  const end = d.endTime && d.endTime > d.time ? { date: d.date, time: d.endTime } : addMinutes(d.date, d.time, DURATION_MIN);
  return {
    ...base,
    start: { dateTime: `${d.date}T${d.time}:00`, timeZone: tz },
    end: { dateTime: `${end.date}T${end.time}:00`, timeZone: tz },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: REMINDER_MIN }] },
  };
}

export interface MapRow { event_id: string; cal_event_id: string; hash: string; all_day: boolean }

export interface SyncDeps {
  world: World; today: string; tz: string;
  map: MapRow[];
  exists(calId: string): Promise<boolean>;
  create(body: Record<string, unknown>): Promise<string>;          // returns calendar event id
  update(calId: string, body: Record<string, unknown>): Promise<void>;
  remove(calId: string): Promise<void>;
  saveMap(row: MapRow): Promise<void>;
  dropMap(eventId: string): Promise<void>;
  log(action: string, detail: string): Promise<void>;
}

export interface SyncResult { created: number; updated: number; recreated: number; deleted: number; deferred: number; errors: number; stopped?: string }

export async function runSync(d: SyncDeps): Promise<SyncResult> {
  const desired = await desiredEvents(d.world, d.today);
  const map = new Map(d.map.map((r) => [r.event_id, r]));
  const known = new Set(d.world.events.map((e) => e.id));
  const r: SyncResult = { created: 0, updated: 0, recreated: 0, deleted: 0, deferred: 0, errors: 0 };
  let ops = 0, streak = 0, stopped = '';
  // When Google refuses everything (calendar not shared, API off, wrong id), stop after a
  // few tries and say why once, instead of failing and logging every single event.
  const failed = async (id: string, e: unknown) => {
    r.errors++; streak++;
    const msg = (e as Error).message;
    if (r.errors <= 3) await d.log('calendarSync error', `${id}: ${msg}`);
    if (streak >= 3 && !r.created && !r.updated && !r.deleted) stopped = msg;
  };

  for (const want of desired) {
    const m = map.get(want.id);
    if (m && m.hash === want.hash) continue;
    if (ops >= MAX_OPS || stopped) { r.deferred++; continue; }
    ops++;
    try {
      const body = gcalBody(want, d.tz);
      const alive = m ? await d.exists(m.cal_event_id) : false;
      if (m && alive && m.all_day === want.allDay) {
        await d.update(m.cal_event_id, body);
        await d.saveMap({ event_id: want.id, cal_event_id: m.cal_event_id, hash: want.hash, all_day: want.allDay });
        r.updated++; streak = 0;
        continue;
      }
      if (m && alive) { await d.remove(m.cal_event_id); r.recreated++; }       // all-day <-> timed: start fresh
      const calId = await d.create(body);
      await d.saveMap({ event_id: want.id, cal_event_id: calId, hash: want.hash, all_day: want.allDay });
      if (!(m && alive)) r.created++;
      streak = 0;
    } catch (e) {
      await failed(want.id, e);
    }
  }

  // Rows gone from the database. Events that merely aged out of the window stay on the calendar.
  for (const [eventId, m] of map) {
    if (known.has(eventId)) continue;
    if (ops >= MAX_OPS || stopped) { r.deferred++; continue; }
    ops++;
    try {
      if (await d.exists(m.cal_event_id)) await d.remove(m.cal_event_id);
      await d.dropMap(eventId);
      r.deleted++; streak = 0;
    } catch (e) {
      await failed(eventId, e);
    }
  }
  if (stopped) await d.log('calendarSync stopped', `Google refused every change, so this run stopped early. Reason: ${stopped}`);
  else if (r.created || r.updated || r.recreated || r.deleted || r.deferred || r.errors) await d.log('calendarSync', JSON.stringify(r));
  return { ...r, ...(stopped ? { stopped } : {}) };
}
