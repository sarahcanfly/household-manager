// Phone notifications.
// POST { action: 'key' }  -> { publicKey }   (made on first use; the phone needs it to subscribe)
// POST { action: 'test' } -> { sent, gone, failed }   (a test notification to the caller's own phones)
import { body, handler, HttpError, json } from '../_shared/http.ts';
import { requireUser } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { serviceDb } from '../_shared/db.ts';
import { pushToHousehold, vapidKeys } from '../_shared/pushdb.ts';

Deno.serve(handler(async (req) => {
  const actor = await requireUser(req);
  const b = await body(req);
  const db = serviceDb();
  if (b.action === 'key') return json({ publicKey: (await vapidKeys(db)).publicKey });
  if (b.action === 'test') {
    const r = await pushToHousehold(db, { title: 'Notifications are on', body: 'Your morning note and reminders will show up here.', url: env('APP_URL'), tag: 'test' }, actor);
    return json(r);
  }
  throw new HttpError(400, 'Unknown request.');
}));
