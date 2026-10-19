// Holidays that move curbside collection (Framingham's list: a weekday holiday pushes that
// day's pickup, and every later pickup that week, back one day). Pure date arithmetic.

import { addDays, weekdayOf, WEEKDAYS } from './domain.ts';

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (date: string) => WEEKDAYS.indexOf(weekdayOf(date));

/** The nth (1-based) weekday `wd` (0 Sunday) of a month, or the last one when n = -1. */
function nth(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = ymd(y, m, 1);
    return addDays(first, ((wd - dow(first) + 7) % 7) + (n - 1) * 7);
  }
  const last = addDays(ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1), -1);
  return addDays(last, -((dow(last) - wd + 7) % 7));
}

export interface Holiday { date: string; name: string }
/** Which holidays move pickup: 'MA' adds Patriots' Day to the US list; 'NONE' means pickup never moves. */
export type HolidayRegion = 'MA' | 'US' | 'NONE';

export function collectionHolidays(year: number, region: HolidayRegion = 'MA'): Holiday[] {
  if (region === 'NONE') return [];
  return [
    { date: ymd(year, 1, 1), name: "New Year's Day" },
    { date: nth(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nth(year, 2, 1, 3), name: "Presidents' Day" },
    { date: nth(year, 4, 1, 3), name: "Patriots' Day" },
    { date: nth(year, 5, 1, -1), name: 'Memorial Day' },
    { date: ymd(year, 6, 19), name: 'Juneteenth' },
    { date: ymd(year, 7, 4), name: 'Independence Day' },
    { date: nth(year, 9, 1, 1), name: 'Labor Day' },
    { date: nth(year, 10, 1, 2), name: "Indigenous Peoples' Day" },
    { date: ymd(year, 11, 11), name: "Veterans' Day" },
    { date: nth(year, 11, 4, 4), name: 'Thanksgiving' },
    { date: ymd(year, 12, 25), name: 'Christmas' },
  ].filter((h) => (region === 'MA' || h.name !== "Patriots' Day") && dow(h.date) >= 1 && dow(h.date) <= 5);   // weekend holidays move nothing
}

/** A weekday holiday from Monday of `date`'s week up to `date` itself, if any. */
export function holidayBefore(date: string, region: HolidayRegion = 'MA'): Holiday | null {
  const monday = addDays(date, -((dow(date) + 6) % 7));
  return collectionHolidays(Number(date.slice(0, 4)), region).find((h) => h.date >= monday && h.date <= date) ?? null;
}

export interface Reminder {
  id: string; title: string; note: string; days: number[]; hour: number;
  every_weeks: number; start_date: string; holiday: 'none' | 'skip' | 'shift';
}

const onSchedule = (r: Reminder, date: string) => {
  if (!r.days.includes(dow(date)) || date < r.start_date) return false;
  const startMonday = addDays(r.start_date, -((dow(r.start_date) + 6) % 7));
  const weeks = Math.floor((Date.parse(date) - Date.parse(startMonday)) / (7 * 86400000));
  return weeks % Math.max(1, r.every_weeks) === 0;
};

/** Whether a reminder goes off on `date`, and a note when a holiday moved it. */
export function firesOn(r: Reminder, date: string, region: HolidayRegion = 'MA'): { fire: boolean; note?: string } {
  const h = holidayBefore(date, region);
  if (onSchedule(r, date)) {
    if (!h || r.holiday === 'none') return { fire: true };
    return { fire: false };   // skipped, or moved to tomorrow
  }
  if (r.holiday === 'shift') {
    const y = addDays(date, -1), hy = holidayBefore(y, region);
    if (onSchedule(r, y) && hy) return { fire: true, note: `A day late this week because of ${hy.name}.` };
  }
  return { fire: false };
}

export const DAY_NAMES = WEEKDAYS;
export function describeReminder(r: Reminder): string {
  const days = r.days.map((d) => WEEKDAYS[d]).join(', ');
  const h = r.hour % 12 || 12, ap = r.hour < 12 ? 'am' : 'pm';
  const every = r.every_weeks > 1 ? `every ${r.every_weeks} weeks on ` : 'every ';
  const hol = r.holiday === 'skip' ? ', skipped in holiday weeks' : r.holiday === 'shift' ? ', a day later in holiday weeks' : '';
  return `${r.title}: ${every}${days} at ${h}${ap}${hol}`;
}
