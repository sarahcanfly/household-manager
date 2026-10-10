// Who is calling. People: a valid Supabase sign-in whose email is on the
// allowed list. Scheduled jobs: the shared cron secret. Anyone else: refused.

import { env, must, safeEqual } from './env.ts';
import { HttpError } from './http.ts';
import { eq, serviceDb, serviceKey } from './db.ts';

export async function requireUser(req: Request): Promise<string> {
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
