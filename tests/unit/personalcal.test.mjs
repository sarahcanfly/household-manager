// Personal Google Calendar: wording, sign-in values, and pushing through the same sync loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ev, members, plus } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const cal = await import(B + 'calsync.js');
const pc = await import(B + 'personalcal.js');

const m = members();

function world(events) {
  return { members: m, pending: [], ideas: [], events };
}

test('personal events name who it is for, who is taking them, and the place', async () => {
  const today = plus(0);
  const events = [
    ev({ id: 'e1', title: 'Soccer practice', date: plus(3), time: '17:30', for_ids: ['k2'], driver: 's1', place: 'Riverside field', note: 'Bring water' }),
    ev({ id: 'e2', title: 'Ortho', date: plus(1), time: '13:30', for_ids: ['k1'], place: 'Bright Smiles' }),
    ev({ id: 'e3', title: 'No school', date: plus(2), for_ids: ['k1', 'k2', 'k3'], driver: 'none' }),
    ev({ id: 'e4', title: 'Alex piano', date: plus(4), time: '15:00', for_ids: ['k1'], driver: 's1', place: 'Home' }),
  ];
  const got = await pc.personalEvents(world(events), today);
  const soccer = got.find((d) => d.id === 'e1');
  assert.equal(soccer.title, 'Soccer practice (Leo) · Alex');
  assert.match(soccer.description, /Who: Leo/);
  assert.match(soccer.description, /Taking: Alex/);
  assert.match(soccer.description, /Where: Riverside field/);
  assert.match(soccer.description, /Bring water/);
  assert.equal(soccer.place, 'Riverside field');
  assert.equal(soccer.icalUid, 'hm-e1@household.app');
  const body = cal.gcalBody(soccer, 'America/New_York');
  assert.equal(body.location, 'Riverside field');
  assert.equal(body.iCalUID, 'hm-e1@household.app');
  assert.equal(body.summary, soccer.title);
  assert.equal(pc.eventWriteBody(body, 'update').iCalUID, undefined);
  assert.equal(pc.eventWriteBody(body, 'import').iCalUID, 'hm-e1@household.app');

  const ortho = got.find((d) => d.id === 'e2');
  assert.match(ortho.title, /^⚠ Ortho \(Mia\)/);
  assert.match(ortho.description, /Taking: not assigned/);
  assert.match(got.find((d) => d.id === 'e3').description, /Taking: no driving needed/);
  assert.equal(got.find((d) => d.id === 'e4').title, 'Alex piano (Mia)', 'driver already in the title is not repeated');
});

test('personal sync creates, updates, and deletes one Google event per household event', async () => {
  const today = plus(0);
  const w = world([
    ev({ id: 'e1', title: 'Soccer practice', date: plus(3), time: '17:30', for_ids: ['k2'], driver: 's1', place: 'Riverside field' }),
  ]);
  const g = new Map();
  let n = 0;
  const api = {
    exists: async (id) => g.has(id),
    create: async (body) => { const id = 'g' + (++n); g.set(id, body); return id; },
    update: async (id, body) => { g.set(id, body); },
    remove: async (id) => { g.delete(id); },
  };
  const map = new Map();
  const run = async () => cal.runSync({
    world: w, today, tz: 'America/New_York', map: [...map.values()], planned: await pc.personalEvents(w, today), ...api,
    saveMap: async (row) => { map.set(row.event_id, row); },
    dropMap: async (id) => { map.delete(id); },
    log: async () => {},
  });
  let r = await run();
  assert.equal(r.created, 1);
  assert.equal(g.size, 1);
  assert.equal([...g.values()][0].summary, 'Soccer practice (Leo) · Alex');
  assert.equal([...g.values()][0].location, 'Riverside field');
  r = await run();
  assert.equal(r.updated, 0, 'second run does not write again');
  assert.equal(g.size, 1);
  w.events[0].place = 'Town hall';
  w.events[0].driver = 'm1';
  r = await run();
  assert.equal(r.updated, 1);
  assert.equal([...g.values()][0].summary, 'Soccer practice (Leo) · Jordan');
  assert.equal([...g.values()][0].location, 'Town hall');
  assert.equal(g.size, 1, 'edit keeps the same Google event');
  w.events = [];
  r = await run();
  assert.equal(r.deleted, 1);
  assert.equal(g.size, 0);
  assert.equal(map.size, 0);
});

test('sign-in state, token encryption, and the consent url', async () => {
  const secret = 'test-secret';
  const state = await pc.signOAuthState('Sarah@Example.com', secret, 1_000);
  assert.equal(await pc.readOAuthState(state, secret, 1_000), 'sarah@example.com');
  await assert.rejects(pc.readOAuthState(state, secret, 1_000 + 16 * 60 * 1000), /expired/);
  await assert.rejects(pc.readOAuthState(state.slice(0, -4) + 'abcd', secret, 1_000), /expired/);
  const stored = await pc.encryptToken('refresh-token-value', secret);
  assert.equal(stored.includes('refresh-token-value'), false);
  assert.equal(await pc.decryptToken(stored, secret), 'refresh-token-value');
  await assert.rejects(pc.decryptToken(stored, 'other-secret'), /Sign in again/);

  const url = new URL(pc.googleAuthUrl({ clientId: 'client', redirectUri: 'https://x.supabase.co/functions/v1/google-calendar', state: 'abc' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
  assert.match(url.searchParams.get('scope'), /calendar\.calendarlist\.readonly/);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x.supabase.co/functions/v1/google-calendar');
  assert.equal(pc.oauthRedirectUri('https://x.supabase.co/'), 'https://x.supabase.co/functions/v1/google-calendar');
  assert.equal(pc.appRedirect('https://mikeysarah.netlify.app/', 'gcal=choose'), 'https://mikeysarah.netlify.app/?gcal=choose');
  assert.equal(pc.appRedirect('https://evil.example/phish', 'gcal=choose'), null);
  assert.equal(pc.appRedirect('javascript:alert(1)', 'x'), null);
});

test('calendar list keeps only calendars she can edit, and the phone never sees the token', () => {
  const list = pc.writableCalendars([
    { id: 'holidays', summary: 'Holidays', accessRole: 'reader' },
    { id: 'family', summary: 'Family', accessRole: 'writer' },
    { id: 'primary', summary: 'Sarah', accessRole: 'owner', primary: true },
    { id: 'gone', summary: 'Old', accessRole: 'owner', deleted: true },
  ]);
  assert.deepEqual(list.map((c) => c.name), ['Sarah', 'Family']);
  assert.equal(list[0].primary, true);
  const pub = pc.publicConnection({
    refresh_token: 'secret-token', google_email: 'sarah@gmail.com', calendar_id: 'primary', calendar_name: 'Sarah', last_error: '',
  }, true);
  assert.equal(JSON.stringify(pub).includes('secret-token'), false);
  assert.equal(pub.connected, true);
  assert.equal(pub.calendarName, 'Sarah');
  assert.deepEqual(pc.publicConnection(null, false), {
    configured: false, connected: false, googleEmail: '', calendarId: '', calendarName: '', lastError: '',
  });
});
