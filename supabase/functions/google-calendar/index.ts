// Connect a household member's own Google Calendar and keep it in step with the week.
// POST { action } from the app (signed in). GET is Google's return from sign-in.
import { body, handler, HttpError, json } from '../_shared/http.ts';
import { requireUser } from '../_shared/auth.ts';
import { env, must } from '../_shared/env.ts';
import { eq, serviceDb, type Rest } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { todayIn } from '../_shared/domain.ts';
import {
  appRedirect, encryptToken, googleAuthUrl, oauthRedirectUri, publicConnection,
  readOAuthState, signOAuthState, tokenSecret,
} from '../_shared/personalcal.ts';
import { exchangeCode, googleEmail, listWritableCalendars } from '../_shared/googleuser.ts';
import { accessFor, removePersonalCopies, syncPersonalCalendars, type Account } from '../_shared/personalsync.ts';

const REASONS = new Set(['denied', 'expired', 'exchange', 'notallowed', 'norefresh', 'noconfig']);

function configured(): boolean {
  return !!(env('GOOGLE_OAUTH_CLIENT_ID') && env('GOOGLE_OAUTH_CLIENT_SECRET'));
}

function redirectBack(query: string): Response {
  const dest = appRedirect(env('APP_URL'), query);
  if (!dest) {
    return new Response('Google Calendar sign-in finished. Open the app and go to Household.\n', {
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return Response.redirect(dest, 302);
}

function backError(reason: string): Response {
  return redirectBack(`gcal=error&reason=${REASONS.has(reason) ? reason : 'exchange'}`);
}

async function account(db: Rest, email: string): Promise<Account | null> {
  const rows = await db.select<Account>('google_accounts', `select=*&email=${eq(email)}`);
  return rows[0] ?? null;
}

async function oauthCallback(url: URL): Promise<Response> {
  if (url.searchParams.get('error') === 'access_denied') return backError('denied');
  if (url.searchParams.get('error')) return backError('exchange');
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  if (!code && !state) {
    return new Response('This address finishes Google sign-in. Start from the app: Household, then Sign in with Google.\n', {
      status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (!configured()) return backError('noconfig');
  let email = '';
  try { email = await readOAuthState(state, must('GOOGLE_OAUTH_CLIENT_SECRET')); }
  catch { return backError('expired'); }
  const db = serviceDb();
  if (!(await db.select('allowed_users', `select=email&email=${eq(email)}`)).length) return backError('notallowed');
  let tok: { access_token: string; refresh_token?: string };
  try { tok = await exchangeCode(code, oauthRedirectUri(must('SUPABASE_URL'))); }
  catch { return backError('exchange'); }
  if (!tok.refresh_token) return backError('norefresh');
  const google_email = await googleEmail(tok.access_token);
  await db.upsert('google_accounts', {
    email,
    google_email,
    refresh_token: await encryptToken(tok.refresh_token, tokenSecret()),
    last_error: '',
    updated_at: new Date().toISOString(),
  }, 'email');
  const row = await account(db, email);
  await new RestStore(db).log(email, 'googleCalendar', row?.calendar_id ? 'signed in again' : 'signed in');
  return redirectBack(row?.calendar_id ? 'gcal=connected' : 'gcal=choose');
}

/** One calendar sync at a time. The same lock the shared calendar uses. */
async function withLock<T>(db: Rest, fn: () => Promise<T>): Promise<T> {
  if (!(await db.rpc<boolean>('take_lock', { lock_name: 'calendar', seconds: 120 }))) {
    throw new HttpError(409, 'A sync is running. Try again in a minute.');
  }
  try { return await fn(); }
  finally { await db.rpc('release_lock', { lock_name: 'calendar' }); }
}

async function runFor(db: Rest, email: string) {
  const store = new RestStore(db);
  const [world, settings] = await Promise.all([store.world(), store.settings()]);
  const report = await syncPersonalCalendars({
    db, world, tz: settings.timezone, today: todayIn(settings.timezone),
    log: (action, detail) => store.log('calendar', action, detail),
    onlyEmail: email,
  });
  return report[0];
}

Deno.serve(handler(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') return await oauthCallback(url);
  const actor = await requireUser(req);
  const b = await body<{ action?: string; calendarId?: string }>(req);
  const db = serviceDb();

  if (b.action === 'status') {
    try { return json(publicConnection(await account(db, actor), configured())); }
    catch { return json(publicConnection(null, configured())); }
  }

  if (b.action === 'start') {
    if (!configured()) throw new HttpError(400, 'Google sign-in is not set up on the server yet.');
    const state = await signOAuthState(actor, must('GOOGLE_OAUTH_CLIENT_SECRET'));
    return json({
      url: googleAuthUrl({
        clientId: must('GOOGLE_OAUTH_CLIENT_ID'),
        redirectUri: oauthRedirectUri(must('SUPABASE_URL')),
        state,
      }),
    });
  }

  const row = await account(db, actor);
  if (!row) throw new HttpError(400, 'Sign in with Google first.');

  if (b.action === 'calendars') {
    const calendars = await withLock(db, async () => listWritableCalendars(await accessFor(db, row)));
    return json({ calendars });
  }

  if (b.action === 'choose') {
    const calendarId = String(b.calendarId || '').trim();
    if (!calendarId) throw new HttpError(400, 'Choose a calendar.');
    const saved = await withLock(db, async () => {
      const choices = await listWritableCalendars(await accessFor(db, row));
      const choice = choices.find((c) => c.id === calendarId);
      if (!choice) throw new HttpError(400, 'That calendar is not one you can edit.');
      if (row.calendar_id && row.calendar_id !== calendarId) {
        try { await removePersonalCopies(db, row); } catch { /* the old calendar may keep its copies */ }
        await db.remove('personal_cal_map', `email=${eq(actor)}`);
      }
      await db.update('google_accounts', `email=${eq(actor)}`, {
        calendar_id: choice.id, calendar_name: choice.name, last_error: '', updated_at: new Date().toISOString(),
      });
      const one = await runFor(db, actor);
      await new RestStore(db).log(actor, 'googleCalendar', `writing to ${choice.name}`);
      return { calendarName: choice.name, sync: one?.result || { skipped: one?.skipped, error: one?.error } };
    });
    return json({ ok: true, ...saved });
  }

  if (b.action === 'sync') {
    if (!row.calendar_id) throw new HttpError(400, 'Choose a calendar first.');
    const one = await withLock(db, () => runFor(db, actor));
    if (one?.error) return json({ error: one.error, lastError: one.error });
    if (one?.skipped) return json({ skipped: one.skipped });
    return json(one?.result || { skipped: 'no calendar chosen' });
  }

  if (b.action === 'disconnect') {
    const note = await withLock(db, async () => {
      let msg = 'Disconnected. Events already on Google Calendar were removed.';
      try {
        const r = await removePersonalCopies(db, row);
        if (r.failed) msg = 'Disconnected. Some events on Google Calendar could not be removed.';
      } catch {
        msg = 'Disconnected here. Events already on Google Calendar could not be removed, so you may need to delete those by hand.';
      }
      await db.remove('google_accounts', `email=${eq(actor)}`);
      await new RestStore(db).log(actor, 'googleCalendar', 'disconnected');
      return msg;
    });
    return json({ ok: true, note });
  }

  throw new HttpError(400, 'Unknown request.');
}));
