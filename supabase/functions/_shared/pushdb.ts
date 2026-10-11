// Sends notifications to the phones saved in push_subscriptions, making the
// signing key on first use and forgetting phones that unsubscribed.

import { eq, type Rest } from './db.ts';
import { env } from './env.ts';
import { makeVapidKeys, sendPush, type PushMessage, type PushSub, type VapidKeys } from './webpush.ts';

export interface PushReport { sent: number; gone: number; failed: number }

export async function vapidKeys(db: Rest): Promise<VapidKeys> {
  const read = async () => (await db.select<{ public_key: string; private_jwk: JsonWebKey }>('push_keys', 'select=public_key,private_jwk&id=eq.1'))[0];
  let row = await read();
  if (!row) {
    const k = await makeVapidKeys();
    // If two requests race, the first insert wins and both use it.
    await db.req('POST', 'push_keys', { id: 1, public_key: k.publicKey, private_jwk: k.privateJwk }, 'resolution=ignore-duplicates,return=minimal');
    row = await read();
  }
  return { publicKey: row.public_key, privateJwk: row.private_jwk };
}

/** Push services want a contact; Apple insists on a mailto: or https: one. */
export function vapidSubject(): string {
  const from = env('MAIL_FROM'), app = env('APP_URL');
  return from ? `mailto:${from}` : app.startsWith('https://') ? app : 'mailto:household@example.com';
}

/** Send to every subscribed phone, or only to one person's phones. */
export async function pushToHousehold(db: Rest, m: PushMessage, onlyEmail?: string, fetcher?: typeof fetch): Promise<PushReport> {
  const filter = onlyEmail ? `&email=${eq(onlyEmail.toLowerCase())}` : '';
  const subs = await db.select<PushSub>('push_subscriptions', `select=endpoint,p256dh,auth,email${filter}`);
  const report: PushReport = { sent: 0, gone: 0, failed: 0 };
  if (!subs.length) return report;
  const keys = await vapidKeys(db), subject = vapidSubject();
  for (const s of subs) {
    let r: 'sent' | 'gone' | 'error';
    try { r = await sendPush(s, m, keys, subject, fetcher); } catch (e) { console.error('push', (e as Error).message); r = 'error'; }
    if (r === 'gone') await db.remove('push_subscriptions', `endpoint=${eq(s.endpoint)}`);
    report[r === 'sent' ? 'sent' : r === 'gone' ? 'gone' : 'failed']++;
  }
  return report;
}
