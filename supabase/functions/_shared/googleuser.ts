// Google Calendar calls made with a person's own sign-in, not the shared service account.

import { must } from './env.ts';
import { eventWriteBody, writableCalendars, type CalendarChoice, type ListedCalendar } from './personalcal.ts';

export async function exchangeCode(code: string, redirectUri: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: must('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: must('GOOGLE_OAUTH_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google did not finish sign-in (${res.status}).`);
  return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: must('GOOGLE_OAUTH_CLIENT_ID'),
      client_secret: must('GOOGLE_OAUTH_CLIENT_SECRET'),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (/invalid_grant/.test(text)) throw new Error('Google needs you to sign in again.');
    throw new Error(`Google sign-in failed (${res.status}).`);
  }
  return JSON.parse(text) as { access_token: string; expires_in: number; refresh_token?: string };
}

export async function googleEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return '';
  const j = await res.json() as { email?: string };
  return String(j.email || '').toLowerCase();
}

export async function listWritableCalendars(accessToken: string): Promise<CalendarChoice[]> {
  const items: ListedCalendar[] = [];
  let page = '';
  for (let i = 0; i < 6; i++) {
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    url.searchParams.set('maxResults', '250');
    if (page) url.searchParams.set('pageToken', page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Could not list calendars (${res.status}).`);
    const j = await res.json() as { items?: ListedCalendar[]; nextPageToken?: string };
    items.push(...(j.items || []));
    page = j.nextPageToken || '';
    if (!page) break;
  }
  return writableCalendars(items);
}

/** Events on one calendar the person chose. Create uses import so the iCalUID stays ours and a repeat does not add a second copy. */
export function userCalendar(accessToken: string, calendarId: string) {
  const root = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`;
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return await fetch(`${root}${path}`, {
      method,
      headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return {
    async exists(id: string): Promise<boolean> {
      const res = await call('GET', `/events/${encodeURIComponent(id)}`);
      if (res.status === 404 || res.status === 410) return false;
      if (!res.ok) throw new Error(`Calendar read failed (${res.status})`);
      return (await res.json() as { status?: string }).status !== 'cancelled';
    },
    async create(body: Record<string, unknown>): Promise<string> {
      const res = await call('POST', '/events/import', eventWriteBody(body, 'import'));
      if (!res.ok) throw new Error(`Calendar create failed (${res.status}): ${(await res.text()).slice(0, 180)}`);
      return (await res.json() as { id: string }).id;
    },
    async update(id: string, body: Record<string, unknown>): Promise<void> {
      const res = await call('PATCH', `/events/${encodeURIComponent(id)}`, eventWriteBody(body, 'update'));
      if (!res.ok) throw new Error(`Calendar update failed (${res.status}): ${(await res.text()).slice(0, 180)}`);
    },
    async remove(id: string): Promise<void> {
      const res = await call('DELETE', `/events/${encodeURIComponent(id)}`);
      if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Calendar delete failed (${res.status})`);
    },
  };
}
