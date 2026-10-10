// Hourly: weekly summary, evening-before reminder, and the "things are waiting"
// digest, each at the hour set in Settings. A signed-in person can also send a
// test: POST { send: 'weekly' | 'reminder' | 'digest' }.
import { body, handler, json } from '../_shared/http.ts';
import { requireCronOrUser } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { sendMail } from '../_shared/mail.ts';
import { runNotify } from '../_shared/notifyjob.ts';

Deno.serve(handler(async (req) => {
  const actor = await requireCronOrUser(req);
  const b = await body<{ send?: 'weekly' | 'reminder' | 'digest' }>(req);
  const force = actor !== 'scheduled' && ['weekly', 'reminder', 'digest'].includes(String(b.send)) ? b.send : undefined;
  const db = serviceDb();
  const store = new RestStore(db);
  const sent = await runNotify({
    store, mail: sendMail, appUrl: env('APP_URL'),
    claim: async (kind, period) => (await db.req<unknown[]>('POST', 'notify_sent', { kind, period }, 'resolution=ignore-duplicates,return=representation')).length > 0,
  }, force);
  return json({ ok: true, sent });
}));
