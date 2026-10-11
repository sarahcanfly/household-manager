// Wording for the weekly summary, the evening-before reminder, the morning
// "today" note and the "things are waiting" digest. Pure: the caller sends them.

import {
  addDays, awayClashes, awayLine, conflictLine, conflicts, custodyDays, custodyLabel, dueLabel, namesOf, needsDriver,
  prettyDate, prettyTime, tasksDueBy, weekdayOf, type Ev, type Task, type World,
} from './domain.ts';

export interface Message { subject: string; body: string; sms: string }

function eventLine(e: Ev, w: World): string {
  const who = namesOf(e.for_ids, w.members);
  const driver = e.driver === 'none' ? '' : e.driver
    ? ` — ${w.members.find((m) => m.id === e.driver)?.name ?? 'someone'} driving`
    : needsDriver(e, w.members) ? ' — NO DRIVER YET' : '';
  return `  ${prettyTime(e.time).padEnd(7)} ${e.title}${who.length ? ` (${who.join(' & ')})` : ''}${driver}${e.place ? ` @ ${e.place}` : ''}`;
}

const sortByTime = (a: Ev, b: Ev) => (a.time || '00:00').localeCompare(b.time || '00:00');
/** Custody days are shown as a line under the date, not as an event. */
const onDay = (w: World, d: string) => w.events.filter((e) => e.date === d && !e.custody).sort(sortByTime);

function taskLine(t: Task, w: World, today: string): string {
  const who = namesOf(t.for_ids, w.members);
  return `${t.title}${who.length ? ` (${who.join(' & ')})` : ''} — due ${dueLabel(t.due, today)}`;
}

function attention(events: Ev[], w: World): string[] {
  const out: string[] = [];
  for (const c of conflicts(events, w.members)) out.push(`CONFLICT ${conflictLine(c)}`);
  for (const e of events.filter((x) => needsDriver(x, w.members))) out.push(`NO DRIVER ${prettyDate(e.date)} ${prettyTime(e.time)}: ${e.title}`);
  for (const c of awayClashes(events, w.members)) out.push(`CUSTODY ${awayLine(c, w.members)}`);
  return out;
}

export function weeklyText(w: World, start: string, appUrl: string, around: string[] = []): Message {
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const inWeek = w.events.filter((e) => days.includes(e.date));
  const custody = custodyDays(w.events);
  const due = tasksDueBy(w.tasks, days[6]);
  const lines: string[] = [];
  const flags = attention(inWeek, w);
  if (flags.length) lines.push('Needs a decision:', ...flags.map((f) => `- ${f}`), '');
  if (due.length) lines.push('To do:', ...due.map((t) => `- ${taskLine(t, w, start)}`), '');
  if (w.pending.length) lines.push(`${w.pending.length} suggested item${w.pending.length === 1 ? ' is' : 's are'} waiting for approval.`, '');
  for (const d of days) {
    const evs = onDay(w, d), c = custodyLabel(custody.get(d), w.members);
    lines.push(`${weekdayOf(d)} ${prettyDate(d).slice(4)}${c ? ` — ${c}` : ''}`);
    lines.push(...(evs.length ? evs.map((e) => eventLine(e, w)) : ['  nothing scheduled']));
  }
  if (around.length) lines.push('', ...around);
  if (appUrl) lines.push('', `Open: ${appUrl}`);
  const sms = [`Week of ${prettyDate(start)}:`, ...days.flatMap((d) =>
    onDay(w, d).map((e) => `${weekdayOf(d).slice(0, 3)} ${prettyTime(e.time)} ${e.title}`)),
  ...due.map((t) => `Due ${dueLabel(t.due, start)}: ${t.title}`),
  ...(flags.length ? [`${flags.length} need a decision`] : [])].join('\n');
  return { subject: `Your week: ${prettyDate(start)}`, body: lines.join('\n'), sms };
}

/** Null when tomorrow has no events and nothing due: a nightly "nothing tomorrow" is noise. */
export function tomorrowText(w: World, tomorrow: string, appUrl: string): Message | null {
  const evs = onDay(w, tomorrow);
  const due = (w.tasks ?? []).filter((t) => !t.done && t.due === tomorrow);
  if (!evs.length && !due.length) return null;
  const flags = attention(w.events.filter((e) => e.date === tomorrow), w);
  const c = custodyLabel(custodyDays(w.events).get(tomorrow), w.members);
  const lines = [`Tomorrow, ${weekdayOf(tomorrow)} ${prettyDate(tomorrow).slice(4)}:`, ...(c ? [`  ${c}`] : []), ...evs.map((e) => eventLine(e, w))];
  if (due.length) lines.push('', 'Due tomorrow:', ...due.map((t) => `- ${taskLine(t, w, tomorrow)}`));
  if (flags.length) lines.push('', 'Needs a decision:', ...flags.map((f) => `- ${f}`));
  if (appUrl) lines.push('', `Open: ${appUrl}`);
  const sms = [`Tomorrow:`, ...evs.map((e) => `${prettyTime(e.time)} ${e.title}`), ...due.map((t) => `Due: ${t.title}`), ...flags].join('\n');
  const n = evs.length + due.length;
  return { subject: `Tomorrow: ${n} thing${n === 1 ? '' : 's'}${flags.length ? ' (needs attention)' : ''}`, body: lines.join('\n'), sms };
}

/**
 * The morning note: today's events with their notes, where the kids are, and
 * to-dos that are overdue or due in the next three days. Null on an empty day.
 */
export function morningText(w: World, today: string, appUrl: string): Message | null {
  const evs = onDay(w, today);
  const due = tasksDueBy(w.tasks, addDays(today, 3));
  if (!evs.length && !due.length) return null;
  const c = custodyLabel(custodyDays(w.events).get(today), w.members);
  const flags = attention(w.events.filter((e) => e.date === today), w);
  const short = (e: Ev) => {
    const who = namesOf(e.for_ids, w.members);
    const note = e.note ? ` — ${e.note.replace(/\s+/g, ' ').slice(0, 80)}` : '';
    return `${e.time ? prettyTime(e.time) : 'All day'} ${e.title}${who.length && who.length < 4 ? ` (${who.join(' & ')})` : ''}${note}`;
  };
  const sms = [
    ...(c ? [c] : []),
    ...evs.map(short),
    ...due.map((t) => `${t.due < today ? 'Overdue' : t.due === today ? 'Due today' : `Due ${dueLabel(t.due, today)}`}: ${t.title}`),
    ...flags.map((f) => f.replace(/^(CONFLICT|NO DRIVER|CUSTODY) /, '⚠ ')),
  ];
  const body = [`Today, ${weekdayOf(today)} ${prettyDate(today).slice(4)}`, '', ...sms, ...(appUrl ? ['', `Open: ${appUrl}`] : [])].join('\n');
  const parts = [evs.length ? `${evs.length} on` : '', due.length ? `${due.length} to do` : ''].filter(Boolean).join(', ');
  return { subject: `Today: ${parts}`, body, sms: sms.join('\n') };
}

export function digestText(w: World, appUrl: string): Message | null {
  if (!w.pending.length) return null;
  const n = w.pending.length;
  const lines = [`${n} suggested item${n === 1 ? ' is' : 's are'} waiting in the Inbox:`, '',
    ...w.pending.slice(0, 15).map((p) => `- ${prettyDate(p.date)} ${p.kind === 'task' ? 'to do' : prettyTime(p.time)} ${p.title}`),
    ...(n > 15 ? [`…and ${n - 15} more`] : [])];
  if (appUrl) lines.push('', `Review: ${appUrl}`);
  return { subject: `${n} waiting for approval`, body: lines.join('\n'), sms: `${n} item${n === 1 ? '' : 's'} waiting for approval in the household app.` };
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
