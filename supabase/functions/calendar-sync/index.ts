// Mirror events onto the shared Google Calendar, and onto any personal
// Google Calendar a household member has connected. Called right after any
// change to events (database trigger) and every few minutes as a backstop.
import { handler, json } from '../_shared/http.ts';
import { requireCronOrUser } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { eq, serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { todayIn } from '../_shared/domain.ts';
import { runSync, type MapRow } from '../_shared/calsync.ts';
import { gcal } from '../_shared/google.ts';
import { syncPersonalCalendars } from '../_shared/personalsync.ts';

Deno.serve(handler(async (req) => {
  await requireCronOrUser(req);
  const db = serviceDb();
  const sharedOn = !!(env('GOOGLE_CALENDAR_ID') && env('GOOGLE_SERVICE_ACCOUNT_JSON'));
  let personalOn = false;
  try {
    const accounts = await db.select<{ calendar_id: string }>('google_accounts', 'select=calendar_id');
    personalOn = accounts.some((a) => a.calendar_id);
  } catch { /* table not created yet: the shared calendar still syncs */ }
  if (!sharedOn && !personalOn) return json({ ok: true, skipped: 'no calendar connected' });
  if (!(await db.rpc<boolean>('take_lock', { lock_name: 'calendar', seconds: 120 }))) return json({ ok: true, skipped: 'another sync is running' });
  try {
    const store = new RestStore(db);
    const [world, settings] = await Promise.all([store.world(), store.settings()]);
    const today = todayIn(settings.timezone);
    let shared: unknown = { skipped: 'Google Calendar is not set up' };
    if (sharedOn) {
      const map = await db.select<MapRow>('cal_map', 'select=*');
      shared = await runSync({
        world, map, tz: settings.timezone, today,
        exists: gcal.exists, create: gcal.create, update: gcal.update, remove: gcal.remove,
        saveMap: async (row) => { await db.upsert('cal_map', { ...row, synced_at: new Date().toISOString() }, 'event_id'); },
        dropMap: async (id) => { await db.remove('cal_map', `event_id=${eq(id)}`); },
        log: (action, detail) => store.log('calendar', action, detail),
      });
    }
    const personal = personalOn
      ? await syncPersonalCalendars({ db, world, tz: settings.timezone, today, log: (action, detail) => store.log('calendar', action, detail) })
      : [];
    return json({ ok: true, shared, personal });
  } finally {
    await db.rpc('release_lock', { lock_name: 'calendar' });
  }
}));
