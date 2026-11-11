// A person's own Google Calendar: what each household event should look like,
// and the sign-in values that never need the network (tokens, the consent URL).

import { hasKid, namesOf, type Ev, type Member, type World } from './domain.ts';
import { desiredEvents, sha256, type Desired } from './calsync.ts';
import { householdIcalUid } from './ics.ts';
import { env } from './env.ts';
import { b64url } from './google.ts';

const enc = new TextEncoder();

/** Title the shared calendar already built, plus who is taking them when someone is assigned. */
export function withTaker(title: string, e: Ev, members: Member[]): string {
  if (!e.driver || e.driver === 'none') return title;
  const name = members.find((m) => m.id === e.driver)?.name;
  if (!name) return title;
  if (title.toLowerCase().includes(name.toLowerCase())) return title;
  return `${title} · ${name}`;
}

/** Who it is for, who is taking them, and where. The place is also the calendar location. */
export function personalDescription(e: Ev, members: Member[]): string {
  const lines: string[] = [];
  const who = namesOf(e.for_ids, members);
  if (who.length) lines.push(`Who: ${who.join(', ')}`);
  if (e.driver === 'none') lines.push('Taking: no driving needed');
  else if (e.driver) {
    const name = members.find((m) => m.id === e.driver)?.name;
    lines.push(`Taking: ${name || 'someone'}`);
  } else if (hasKid(e.for_ids, members)) lines.push('Taking: not assigned');
  if (e.place) lines.push(`Where: ${e.place}`);
  const withUs = namesOf(e.with_us, members);
  if (withUs.length) lines.push(`With us: ${withUs.join(', ')}`);
  if (e.note) lines.push('', e.note);
  lines.push('', 'From Household. Change it in the app; this copy is updated from there.');
  return lines.join('\n');
}

/** Same events as the shared calendar, worded for a personal one and tagged with a stable iCalUID. */
export async function personalEvents(world: World, today: string): Promise<Desired[]> {
  const base = await desiredEvents(world, today);
  const byId = new Map(world.events.map((e) => [e.id, e]));
  const out: Desired[] = [];
  for (const d of base) {
    const e = byId.get(d.id);
    if (!e) continue;
    const title = withTaker(d.title, e, world.members);
    const description = personalDescription(e, world.members);
    out.push({
      ...d, title, description, icalUid: householdIcalUid(e.id),
      hash: await sha256(JSON.stringify(['personal', title, description, e.place, e.date, e.time, e.end_time || '', d.colorId])),
    });
  }
  return out;
}

export interface ListedCalendar { id?: string; summary?: string; primary?: boolean; accessRole?: string; deleted?: boolean }
export interface CalendarChoice { id: string; name: string; primary: boolean }

/** Calendars she can actually edit, main one first. */
export function writableCalendars(items: ListedCalendar[]): CalendarChoice[] {
  return items
    .filter((c) => !!c.id && !c.deleted && (c.accessRole === 'owner' || c.accessRole === 'writer'))
    .map((c) => ({ id: c.id!, name: (c.summary || c.id!).trim() || c.id!, primary: !!c.primary }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** What the phone is allowed to see. The refresh token is never copied out. */
export function publicConnection(
  row: { google_email?: string; calendar_id?: string; calendar_name?: string; last_error?: string } | null,
  configured: boolean,
) {
  if (!row) return { configured, connected: false, googleEmail: '', calendarId: '', calendarName: '', lastError: '' };
  return {
    configured,
    connected: true,
    googleEmail: row.google_email || '',
    calendarId: row.calendar_id || '',
    calendarName: row.calendar_name || '',
    lastError: row.last_error || '',
  };
}

/** import keeps the iCalUID. update must not send it: Google treats it as fixed, and a patch leaves it in place. */
export function eventWriteBody(body: Record<string, unknown>, method: 'import' | 'update'): Record<string, unknown> {
  if (method === 'import') return body;
  const copy = { ...body };
  delete copy.iCalUID;
  return copy;
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

export function googleAuthUrl(o: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', o.state);
  return u.toString();
}

export function oauthRedirectUri(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/google-calendar`;
}

/** Only the household's own app address. Anything else is refused, so the sign-in return cannot be pointed elsewhere. */
export function appRedirect(appUrl: string, query: string): string | null {
  const base = appUrl.trim().replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base) && !/^http:\/\/localhost(?::\d+)?$/i.test(base)) return null;
  return `${base}/?${query}`;
}

export function tokenSecret(): string {
  const k = env('GOOGLE_TOKEN_KEY') || env('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!k) throw new Error('Google sign-in is not set up on the server yet.');
  return k;
}

function b64urlDecode(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new ArrayBuffer(bin.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** The refresh token is stored encrypted. The key lives only in the function secrets, not in the database. */
export async function encryptToken(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(plain)));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptToken(stored: string, secret: string): Promise<string> {
  const [ver, ivs, cts] = String(stored).split('.');
  if (ver !== 'v1' || !ivs || !cts) throw new Error('Saved Google sign-in could not be read. Sign in again.');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlDecode(ivs) }, await aesKey(secret), b64urlDecode(cts));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Saved Google sign-in could not be read. Sign in again.');
  }
}

async function hmacHex(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STATE_MS = 15 * 60 * 1000;

/** Proves the sign-in was started by this server, for this person, a few minutes ago. */
export async function signOAuthState(email: string, secret: string, now = Date.now()): Promise<string> {
  const payload = b64url(JSON.stringify({ e: email.toLowerCase(), exp: now + STATE_MS }));
  return `${payload}.${await hmacHex(payload, secret)}`;
}

export async function readOAuthState(state: string, secret: string, now = Date.now()): Promise<string> {
  const dot = String(state).lastIndexOf('.');
  const payload = dot > 0 ? state.slice(0, dot) : '';
  const sig = dot > 0 ? state.slice(dot + 1) : '';
  if (!payload || !sig || !timingEqual(sig, await hmacHex(payload, secret))) throw new Error('expired');
  let data: { e?: string; exp?: number };
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))); }
  catch { throw new Error('expired'); }
  if (!data.e || !data.exp || data.exp < now) throw new Error('expired');
  return data.e.toLowerCase();
}
