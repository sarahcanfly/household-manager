// Hourly: weekly summary, evening-before reminder, and the "things are waiting"
// digest, each at the hour set in Settings. A signed-in person can also send a
// test: POST { send: 'weekly' | 'reminder' | 'digest' | 'morning' }.
import { body, handler, json } from '../_shared/http.ts';
import { requireCronOrUser } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { sendMail } from '../_shared/mail.ts';
import { runNotify, type NotifyKind } from '../_shared/notifyjob.ts';
import { pushToHousehold } from '../_shared/pushdb.ts';
import { twilioReady, twilioTexter } from '../_shared/sms.ts';
import { DEFAULT_LOCAL, findLocalEvents, localLines } from '../_shared/localevents.ts';
import { callClaude } from '../_shared/claude.ts';

Deno.serve(handler(async (req) => {
  const actor = await requireCronOrUser(req);
  const b = await body<{ send?: NotifyKind | 'sms-test' }>(req);
  if (b.send === 'sms-test' && actor !== 'scheduled') {
    // A test text to everyone on the text list, with what went wrong for each if anything did.
    const s = await new RestStore(serviceDb()).settings();
    const list = s.sms?.recipients ?? [];
    if (!twilioReady()) return json({ ok: false, results: [], error: 'Twilio is not set up yet: add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.' });
    if (!list.length) return json({ ok: false, results: [], error: 'Nobody is on the text list yet (sms → recipients in settings).' });
    const text = twilioTexter();
    const results = [];
    for (const r of list) {
      try { await text(r.number, 'Household: texts are working. You will get reminders here.'); results.push({ name: r.name, ok: true }); }
      catch (e) { results.push({ name: r.name, ok: false, error: (e as Error).message }); }
    }
    return json({ ok: results.every((r) => r.ok), results, enabled: !!s.sms?.enabled });
  }
  const force = actor !== 'scheduled' && ['weekly', 'reminder', 'digest', 'morning'].includes(String(b.send)) ? b.send as NotifyKind : undefined;
  const db = serviceDb();
  const store = new RestStore(db);
  const sent = await runNotify({
    store, mail: sendMail, appUrl: env('APP_URL'),
    // A test from the app goes only to the person who asked for it.
    push: (m) => pushToHousehold(db, m, force ? actor : undefined),
    text: twilioReady() ? twilioTexter() : undefined,
    around: async (start) => {
      const s = await store.settings();
      if (!s.local_events?.enabled || !env('ANTHROPIC_API_KEY')) return [];
      const w = await store.world();
      return localLines(await findLocalEvents(callClaude, { ...DEFAULT_LOCAL, ...s.local_events, area: s.local_events.area || 'Framingham, MA' }, w.members, start, s.timezone), env('APP_URL'));
    },
    claim: async (kind, period) => (await db.req<unknown[]>('POST', 'notify_sent', { kind, period }, 'resolution=ignore-duplicates,return=representation')).length > 0,
  }, force);
  return json({ ok: true, sent });
}));
