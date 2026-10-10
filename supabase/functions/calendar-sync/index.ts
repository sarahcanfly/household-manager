// Mirror events onto the shared Google Calendar. Called right after any change
// to events (database trigger) and every few minutes as a backstop.
import { handler, json } from '../_shared/http.ts';
import { requireCronOrUser } from '../_shared/auth.ts';
import { env } from '../_shared/env.ts';
import { eq, serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { todayIn } from '../_shared/domain.ts';
import { runSync, type MapRow } from '../_shared/calsync.ts';
import { gcal } from '../_shared/google.ts';

Deno.serve(handler(async (req) => {
  await requireCronOrUser(req);
  if (!env('GOOGLE_CALENDAR_ID') || !env('GOOGLE_SERVICE_ACCOUNT_JSON')) return json({ ok: true, skipped: 'Google Calendar is not set up' });
  const db = serviceDb();
  if (!(await db.rpc<boolean>('take_lock', { lock_name: 'calendar', seconds: 120 }))) return json({ ok: true, skipped: 'another sync is running' });
  try {
    const store = new RestStore(db);
    const [world, settings, map] = await Promise.all([store.world(), store.settings(), db.select<MapRow>('cal_map', 'select=*')]);
    const result = await runSync({
      world, map, tz: settings.timezone, today: todayIn(settings.timezone),
      exists: gcal.exists, create: gcal.create, update: gcal.update, remove: gcal.remove,
      saveMap: async (row) => { await db.upsert('cal_map', { ...row, synced_at: new Date().toISOString() }, 'event_id'); },
      dropMap: async (id) => { await db.remove('cal_map', `event_id=${eq(id)}`); },
      log: (action, detail) => store.log('calendar', action, detail),
    });
    return json({ ok: true, ...result });
  } finally {
    await db.rpc('release_lock', { lock_name: 'calendar' });
  }
}));
