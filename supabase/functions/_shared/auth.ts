// Who is calling. People: a valid Supabase sign-in whose email is on the
// allowed list. Scheduled jobs: the shared cron secret. Anyone else: refused.

import { env, must, safeEqual } from './env.ts';
import { HttpError } from './http.ts';
import { eq, serviceDb, serviceKey } from './db.ts';

export async function keyHash(key: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The "Ask Household" Shortcut sends a personal key instead of a sign-in. */
async function userFromKey(key: string): Promise<string> {
  if (!/^hh_[0-9a-f]{64}$/.test(key)) throw new HttpError(401, 'That Siri key is not valid. Make a new one in the app under Household.');
  const db = serviceDb();
  const rows = await db.select<{ email: string }>('shortcut_keys', `select=email&key_hash=${eq(await keyHash(key))}`);
  const email = rows[0]?.email;
  if (!email) throw new HttpError(401, 'That Siri key was turned off. Make a new one in the app under Household.');
  if (!(await db.select('allowed_users', `select=email&email=${eq(email)}`)).length) throw new HttpError(403, 'Not allowed.');
  return email;
}

export async function requireUser(req: Request): Promise<string> {
  const key = (req.headers.get('x-household-key') ?? '').trim();
  if (key) return await userFromKey(key);
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'Sign in first.');
  const res = await fetch(`${must('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: env('SUPABASE_ANON_KEY') || serviceKey(), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(401, 'Your sign-in has expired. Sign in again.');
  const user = await res.json() as { email?: string };
  const email = String(user.email ?? '').toLowerCase();
  if (!email) throw new HttpError(403, 'Not allowed.');
  const rows = await serviceDb().select('allowed_users', `select=email&email=${eq(email)}`);
  if (!rows.length) throw new HttpError(403, 'Not allowed.');
  return email;
}

export function isCron(req: Request): boolean {
  return safeEqual(req.headers.get('x-cron-secret') ?? '', must('CRON_SECRET'));
}

export function requireCron(req: Request): void {
  if (!isCron(req)) throw new HttpError(401, 'Not allowed.');
}

/** Scheduled run, or a person pressing "check now". Returns who, for the log. */
export async function requireCronOrUser(req: Request): Promise<string> {
  if (req.headers.get('x-cron-secret')) { requireCron(req); return 'scheduled'; }
  return await requireUser(req);
}
