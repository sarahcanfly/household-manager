// The hourly notification job. It runs every hour and decides, in the
// household's timezone, whether this is the hour for the weekly summary,
// the evening-before reminder, or the "things are waiting" digest.

import { addDays, zoned } from './domain.ts';
import { digestText, morningText, tomorrowText, trimSms, weeklyText } from './notify.ts';
import { smsAddress, type Mailer } from './mail.ts';
import type { Store } from './store.ts';
import type { PushMessage } from './webpush.ts';

export interface NotifyDeps {
  store: Store;
  mail: Mailer;
  claim(kind: string, period: string): Promise<boolean>;   // true only the first time for that kind and period
  appUrl: string;
  /** Sends a notification to every phone that turned them on. */
  push?: (m: PushMessage) => Promise<unknown>;
  now?: Date;
}

/** The notification is the short text version, under the email's subject. */
export function pushFrom(kind: string, msg: { subject: string; sms: string }, appUrl: string): PushMessage {
  const lines = msg.sms.split('\n');
  if (lines.length > 1 && lines[0].endsWith(':')) lines.shift();
  return { title: msg.subject, body: lines.join('\n'), url: appUrl, tag: kind };
}

export type NotifyKind = 'weekly' | 'reminder' | 'digest' | 'morning';

export async function runNotify(d: NotifyDeps, force?: NotifyKind): Promise<string[]> {
  const s = await d.store.settings();
  const z = zoned(d.now ?? new Date(), s.timezone);
  const w = await d.store.world();
  const sent: string[] = [];
  const recipients = s.notify ?? [];

  const deliver = async (kind: NotifyKind, msg: { subject: string; body: string; sms: string } | null, smsOn: boolean, emailOn = true) => {
    if (!msg) return;
    const pushOn = { weekly: s.push?.weekly, reminder: s.push?.reminders, digest: s.push?.digest, morning: true }[kind] ?? true;
    if (d.push && pushOn !== false) {
      try { await d.push(pushFrom(kind, msg, d.appUrl)); }
      catch (e) { await d.store.log('scheduled', 'push error', (e as Error).message); }
    }
    if (emailOn && recipients.length) await d.mail(recipients, msg.subject, msg.body);
    if (s.sms?.enabled && smsOn) {
      for (const r of s.sms.recipients ?? []) {
        try { await d.mail([smsAddress(r)], 'Household', trimSms(msg.sms, s.sms.max_chars || 600)); }
        catch (e) { await d.store.log('scheduled', 'sms error', `${r.name}: ${(e as Error).message}`); }
      }
    }
    sent.push(kind);
    await d.store.log('scheduled', `notify ${kind}`, msg.subject);
  };

  const due = (kind: string, on: boolean, hour: number, extra = true) =>
    force === kind || (on && extra && z.hour === hour);

  if (due('weekly', s.weekly?.enabled, s.weekly?.hour, z.weekday.toUpperCase() === String(s.weekly?.day).toUpperCase())
      && (force === 'weekly' || await d.claim('weekly', z.date))) {
    await deliver('weekly', weeklyText(w, z.date, d.appUrl), !!s.sms?.weekly);
  }
  if (due('reminder', s.reminders?.enabled, s.reminders?.hour) && (force === 'reminder' || await d.claim('reminder', z.date))) {
    await deliver('reminder', tomorrowText(w, addDays(z.date, 1), d.appUrl), !!s.sms?.reminders);
  }
  // The morning note is a phone notification; it is emailed too only if morning.email is on.
  if (due('morning', s.morning?.enabled, s.morning?.hour) && (force === 'morning' || await d.claim('morning', z.date))) {
    await deliver('morning', morningText(w, z.date, d.appUrl), false, !!s.morning?.email);
  }
  if (due('digest', s.digest?.enabled, s.digest?.hour) && (force === 'digest' || await d.claim('digest', z.date))) {
    await deliver('digest', digestText(w, d.appUrl), !!s.sms?.digest);
  }
  return sent;
}
