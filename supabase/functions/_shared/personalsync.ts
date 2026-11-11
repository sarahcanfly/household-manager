// Push the household week onto each connected personal Google Calendar.
// The caller holds the calendar lock so two runs cannot create duplicates.

import { eq, type Rest } from './db.ts';
import { env } from './env.ts';
import { runSync, type MapRow, type SyncResult } from './calsync.ts';
import type { World } from './domain.ts';
import { decryptToken, encryptToken, personalEvents, tokenSecret } from './personalcal.ts';
import { refreshAccessToken, userCalendar } from './googleuser.ts';

export interface Account {
  email: string;
  google_email: string;
  refresh_token: string;
  calendar_id: string;
  calendar_name: string;
  last_error: string;
}

export interface PersonalReport {
  email: string;
  result?: SyncResult;
  skipped?: string;
  error?: string;
}

export async function accessFor(db: Rest, row: Account): Promise<string> {
  if (!env('GOOGLE_OAUTH_CLIENT_ID') || !env('GOOGLE_OAUTH_CLIENT_SECRET')) {
    throw new Error('Google sign-in is not set up on the server yet.');
  }
  const secret = tokenSecret();
  const refresh = await decryptToken(row.refresh_token, secret);
  const tok = await refreshAccessToken(refresh);
  if (tok.refresh_token && tok.refresh_token !== refresh) {
    await db.update('google_accounts', `email=${eq(row.email)}`, {
      refresh_token: await encryptToken(tok.refresh_token, secret),
      updated_at: new Date().toISOString(),
    });
  }
  return tok.access_token;
}

export async function removePersonalCopies(db: Rest, row: Account): Promise<{ removed: number; failed: number }> {
  const map = await db.select<MapRow>('personal_cal_map', `select=event_id,cal_event_id,hash,all_day&email=${eq(row.email)}`);
  if (!map.length || !row.calendar_id) return { removed: 0, failed: 0 };
  const cal = userCalendar(await accessFor(db, row), row.calendar_id);
  let removed = 0, failed = 0;
  for (const m of map) {
    try { await cal.remove(m.cal_event_id); removed++; }
    catch { failed++; }
  }
  return { removed, failed };
}

async function syncOne(
  db: Rest, row: Account, world: World, tz: string, today: string,
  log: (action: string, detail: string) => Promise<void>,
): Promise<SyncResult> {
  const map = await db.select<MapRow>('personal_cal_map', `select=event_id,cal_event_id,hash,all_day&email=${eq(row.email)}`);
  const events = await personalEvents(world, today);
  const cal = userCalendar(await accessFor(db, row), row.calendar_id);
  const result = await runSync({
    world, today, tz, map, planned: events,
    exists: (id) => cal.exists(id),
    create: (body) => cal.create(body),
    update: (id, body) => cal.update(id, body),
    remove: (id) => cal.remove(id),
    saveMap: async (m) => {
      await db.upsert('personal_cal_map', { email: row.email, ...m, synced_at: new Date().toISOString() }, 'email,event_id');
    },
    dropMap: async (eventId) => { await db.remove('personal_cal_map', `email=${eq(row.email)}&event_id=${eq(eventId)}`); },
    log: (action, detail) => log(action, `${row.email}: ${detail}`),
  });
  const last = result.stopped
    ? result.stopped
    : result.errors ? 'Some events could not be updated. They will be tried again.' : '';
  await db.update('google_accounts', `email=${eq(row.email)}`, { last_error: last.slice(0, 300) });
  return result;
}

export async function syncPersonalCalendars(opts: {
  db: Rest;
  world: World;
  tz: string;
  today: string;
  log: (action: string, detail: string) => Promise<void>;
  onlyEmail?: string;
}): Promise<PersonalReport[]> {
  const { db, world, tz, today, log } = opts;
  let rows: Account[] = [];
  try {
    const q = opts.onlyEmail ? `select=*&email=${eq(opts.onlyEmail)}` : 'select=*';
    rows = await db.select<Account>('google_accounts', q);
  } catch (e) {
    await log('personalCalendar', `could not read connections: ${(e as Error).message}`);
    return [];
  }
  const out: PersonalReport[] = [];
  for (const row of rows) {
    if (!row.calendar_id) { out.push({ email: row.email, skipped: 'no calendar chosen' }); continue; }
    try {
      out.push({ email: row.email, result: await syncOne(db, row, world, tz, today, log) });
    } catch (e) {
      const msg = (e as Error).message || 'Google Calendar could not be updated.';
      out.push({ email: row.email, error: msg });
      try { await db.update('google_accounts', `email=${eq(row.email)}`, { last_error: msg.slice(0, 300) }); } catch { /* the report still says why */ }
      await log('personalCalendar error', `${row.email}: ${msg}`);
    }
  }
  return out;
}
