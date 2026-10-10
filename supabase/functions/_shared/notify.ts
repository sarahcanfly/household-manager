// Wording for the weekly summary, the evening-before reminder and the
// "things are waiting" digest. Pure: the caller sends them.

import { addDays, conflictLine, conflicts, namesOf, needsDriver, prettyDate, prettyTime, weekdayOf, type Ev, type World } from './domain.ts';

function eventLine(e: Ev, w: World): string {
  const who = namesOf(e.for_ids, w.members);
  const driver = e.driver === 'none' ? '' : e.driver
    ? ` — ${w.members.find((m) => m.id === e.driver)?.name ?? 'someone'} driving`
    : needsDriver(e, w.members) ? ' — NO DRIVER YET' : '';
  return `  ${prettyTime(e.time).padEnd(7)} ${e.title}${who.length ? ` (${who.join(' & ')})` : ''}${driver}${e.place ? ` @ ${e.place}` : ''}`;
}

const sortByTime = (a: Ev, b: Ev) => (a.time || '00:00').localeCompare(b.time || '00:00');

function attention(events: Ev[], w: World): string[] {
  const out: string[] = [];
  for (const c of conflicts(events, w.members)) out.push(`CONFLICT ${conflictLine(c)}`);
  for (const e of events.filter((x) => needsDriver(x, w.members))) out.push(`NO DRIVER ${prettyDate(e.date)} ${prettyTime(e.time)}: ${e.title}`);
  return out;
}

export function weeklyText(w: World, start: string, appUrl: string): { subject: string; body: string; sms: string } {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const inWeek = w.events.filter((e) => days.includes(e.date));
  const lines: string[] = [];
  const flags = attention(inWeek, w);
  if (flags.length) lines.push('Needs a decision:', ...flags.map((f) => `- ${f}`), '');
  if (w.pending.length) lines.push(`${w.pending.length} suggested event${w.pending.length === 1 ? ' is' : 's are'} waiting for approval.`, '');
  for (const d of days) {
    const evs = inWeek.filter((e) => e.date === d).sort(sortByTime);
    lines.push(`${weekdayOf(d)} ${prettyDate(d).slice(4)}`);
    lines.push(...(evs.length ? evs.map((e) => eventLine(e, w)) : ['  nothing scheduled']));
  }
  if (appUrl) lines.push('', `Open: ${appUrl}`);
  const sms = [`Week of ${prettyDate(start)}:`, ...days.flatMap((d) =>
    inWeek.filter((e) => e.date === d).sort(sortByTime).map((e) => `${weekdayOf(d).slice(0, 3)} ${prettyTime(e.time)} ${e.title}`)),
  ...(flags.length ? [`${flags.length} need a decision`] : [])].join('\n');
  return { subject: `Your week: ${prettyDate(start)}`, body: lines.join('\n'), sms };
}

/** Null when tomorrow is empty: a nightly "nothing tomorrow" is noise. */
export function tomorrowText(w: World, tomorrow: string, appUrl: string): { subject: string; body: string; sms: string } | null {
  const evs = w.events.filter((e) => e.date === tomorrow).sort(sortByTime);
  if (!evs.length) return null;
  const flags = attention(evs, w);
  const lines = [`Tomorrow, ${weekdayOf(tomorrow)} ${prettyDate(tomorrow).slice(4)}:`, ...evs.map((e) => eventLine(e, w))];
  if (flags.length) lines.push('', 'Needs a decision:', ...flags.map((f) => `- ${f}`));
  if (appUrl) lines.push('', `Open: ${appUrl}`);
  const sms = [`Tomorrow:`, ...evs.map((e) => `${prettyTime(e.time)} ${e.title}`), ...flags].join('\n');
  return { subject: `Tomorrow: ${evs.length} thing${evs.length === 1 ? '' : 's'}${flags.length ? ' (needs attention)' : ''}`, body: lines.join('\n'), sms };
}

export function digestText(w: World, appUrl: string): { subject: string; body: string; sms: string } | null {
  if (!w.pending.length) return null;
  const n = w.pending.length;
  const lines = [`${n} suggested event${n === 1 ? ' is' : 's are'} waiting in the Inbox:`, '',
    ...w.pending.slice(0, 15).map((p) => `- ${prettyDate(p.date)} ${prettyTime(p.time)} ${p.title}`),
    ...(n > 15 ? [`…and ${n - 15} more`] : [])];
  if (appUrl) lines.push('', `Review: ${appUrl}`);
  return { subject: `${n} waiting for approval`, body: lines.join('\n'), sms: `${n} events waiting for approval in the household app.` };
}

/** Texts go through carrier gateways; keep them short and say how much was cut. */
export function trimSms(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split('\n'), kept: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > max - 12) break;
    kept.push(l); len += l.length + 1;
  }
  return `${kept.join('\n')}\n+${lines.length - kept.length} more`;
}
