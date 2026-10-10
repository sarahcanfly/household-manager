// Google access through a service account: no browser sign-in, no tokens that
// expire after a week. The household calendar (and any Google Docs to read)
// are shared with the service account's email address.

import { must } from './env.ts';

const enc = new TextEncoder();

export function b64url(data: string | ArrayBuffer | Uint8Array): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function signedJwt(clientEmail: string, privateKeyPem: string, scopes: string[], nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: clientEmail, scope: scopes.join(' '), aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

const cache = new Map<string, { token: string; exp: number }>();

export async function googleToken(scopes: string[]): Promise<string> {
  const k = scopes.join(' ');
  const hit = cache.get(k);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  let sa: { client_email: string; private_key: string };
  try { sa = JSON.parse(must('GOOGLE_SERVICE_ACCOUNT_JSON')); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the whole key file.'); }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signedJwt(sa.client_email, sa.private_key, scopes) }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { access_token: string; expires_in: number };
  cache.set(k, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

/* ---------- Calendar ---------- */

const CAL_SCOPE = ['https://www.googleapis.com/auth/calendar.events'];
const calUrl = (path = '') => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(must('GOOGLE_CALENDAR_ID'))}/events${path}`;

async function calFetch(method: string, path: string, body?: unknown): Promise<Response> {
  return await fetch(calUrl(path), {
    method,
    headers: { Authorization: `Bearer ${await googleToken(CAL_SCOPE)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const gcal = {
  async exists(id: string): Promise<boolean> {
    const res = await calFetch('GET', `/${encodeURIComponent(id)}`);
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) throw new Error(`Calendar read failed (${res.status})`);
    return (await res.json() as { status?: string }).status !== 'cancelled';
  },
  async create(body: Record<string, unknown>): Promise<string> {
    const res = await calFetch('POST', '', body);
    if (!res.ok) throw new Error(`Calendar create failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return (await res.json() as { id: string }).id;
  },
  async update(id: string, body: Record<string, unknown>): Promise<void> {
    const res = await calFetch('PUT', `/${encodeURIComponent(id)}`, body);
    if (!res.ok) throw new Error(`Calendar update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  },
  async remove(id: string): Promise<void> {
    const res = await calFetch('DELETE', `/${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Calendar delete failed (${res.status})`);
  },
};

/* ---------- Drive (reading shared Google Docs and PDFs) ---------- */

const DRIVE_SCOPE = ['https://www.googleapis.com/auth/drive.readonly'];

export async function driveText(fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${await googleToken(DRIVE_SCOPE)}` },
  });
  if (res.status === 404) throw new Error('Not found. Share the document with the service account email.');
  if (!res.ok) throw new Error(`Could not read the document (${res.status})`);
  return await res.text();
}

export async function driveBase64(fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${await googleToken(DRIVE_SCOPE)}` },
  });
  if (res.status === 404) throw new Error('Not found. Share the file with the service account email.');
  if (!res.ok) throw new Error(`Could not download the file (${res.status})`);
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
}
