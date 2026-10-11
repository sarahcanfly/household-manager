// Calendar sync, notifications, intake, email parsing and Google signing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, fakeClaude, say, ev, plus, members, domain } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const cal = await import(B + 'calsync.js');
const { runNotify } = await import(B + 'notifyjob.js');
const { trimSms } = await import(B + 'notify.js');
const intake = await import(B + 'intake.js');
const email = await import(B + 'email.js');
const google = await import(B + 'google.js');
const extract = await import(B + 'extract.js');

/* ---------- calendar sync ---------- */

function fakeCalendar() {
  const events = new Map(); let n = 0;
  return {
    events,
    exists: async (id) => events.has(id),
    create: async (body) => { const id = 'g' + (++n); events.set(id, body); return id; },
    update: async (id, body) => { if (!events.has(id)) throw new Error('gone'); events.set(id, body); },
    remove: async (id) => { events.delete(id); },
  };
}

async function sync(world, g, map, today = plus(0)) {
  const logs = [];
  const r = await cal.runSync({
    world, today, tz: 'America/New_York', map: [...map.values()], ...g,
    saveMap: async (row) => { map.set(row.event_id, row); }, dropMap: async (id) => { map.delete(id); },
    log: async (a, dt) => logs.push([a, dt]),
  });
  return { r, logs };
}

test('calendar sync: create, no-op, update, recreate, delete, restore hand-deleted', async () => {
  const world = { members: members(), pending: [], ideas: [], events: [
    ev({ id: 'e1', title: 'Soccer Practice', date: plus(3), time: '17:30', for_ids: ['k2'], driver: 's1' }),
    ev({ id: 'e2', title: 'Ortho', date: plus(4), time: '13:30', for_ids: ['k1'] }),
    ev({ id: 'e3', title: 'No School', date: plus(5), for_ids: ['k1', 'k2', 'k3'], driver: 'none' }),
    ev({ id: 'e4', title: 'Ivy dentist', date: plus(6), time: '08:30', for_ids: ['k3'], driver: 'x1' }),
    ev({ id: 'old', title: 'Long ago', date: plus(-100), time: '09:00' }),
  ] };
  const g = fakeCalendar(), map = new Map();
  let { r } = await sync(world, g, map);
  assert.equal(r.created, 4, 'old event outside the window is skipped');
  const titles = [...g.events.values()].map((b) => b.summary);
  assert.ok(titles.includes('Soccer Practice (Leo)'));
  assert.ok(titles.includes('⚠ Ortho (Mia)'), 'missing driver flagged');
  assert.ok(titles.includes('No School (kids)'), 'all the kids: short suffix');
  assert.ok(titles.includes('Ivy dentist'), 'name already in title: no suffix');
  const allDay = [...g.events.values()].find((b) => b.summary === 'No School (kids)');
  assert.deepEqual([allDay.start.date, allDay.end.date], [plus(5), domain.addDays(plus(5), 1)]);
  const timed = [...g.events.values()].find((b) => b.summary.startsWith('Soccer'));
  assert.deepEqual(timed.start, { dateTime: `${plus(3)}T17:30:00`, timeZone: 'America/New_York' });
  assert.equal(timed.end.dateTime, `${plus(3)}T18:30:00`);
  assert.equal(timed.reminders.overrides[0].minutes, 45);

  ({ r } = await sync(world, g, map));
  assert.deepEqual([r.created, r.updated, r.deleted, r.recreated], [0, 0, 0, 0], 'second run is a no-op');

  world.events[1].driver = 'm1';
  ({ r } = await sync(world, g, map));
  assert.equal(r.updated, 1);
  assert.ok([...g.events.values()].some((b) => b.summary === 'Ortho (Mia)'), 'warning cleared');

  world.events[3].time = '';
  ({ r } = await sync(world, g, map));
  assert.equal(r.recreated, 1); assert.equal(g.events.size, 4, 'no duplicates after timed -> all-day');

  world.events.splice(2, 1);
  ({ r } = await sync(world, g, map));
  assert.equal(r.deleted, 1); assert.equal(g.events.size, 3);

  g.events.delete(map.get('e1').cal_event_id);           // someone deletes it inside Google Calendar
  world.events[0].note = 'bring water';
  ({ r } = await sync(world, g, map));
  assert.equal(g.events.size, 3, 'comes back');
});

test('calendar sync: caps work per run and finishes on the next', async () => {
  const events = Array.from({ length: 70 }, (_, i) => ev({ id: 'b' + i, title: 'Bulk ' + i, date: plus(10 + (i % 20)), time: '10:00', for_ids: ['s1'] }));
  const world = { members: members(), pending: [], ideas: [], events };
  const g = fakeCalendar(), map = new Map();
  let { r } = await sync(world, g, map);
  assert.deepEqual([r.created, r.deferred], [60, 10]);
  ({ r } = await sync(world, g, map));
  assert.equal(g.events.size, 70);
});

test('calendar sync: a failing event is logged and the rest continue', async () => {
  const world = { members: members(), pending: [], ideas: [], events: [ev({ id: 'a', date: plus(2) }), ev({ id: 'b', date: plus(3) })] };
  const g = fakeCalendar(); const create = g.create; let first = true;
  g.create = async (body) => { if (first) { first = false; throw new Error('quota'); } return create(body); };
  const map = new Map();
  const { r, logs } = await sync(world, g, map);
  assert.deepEqual([r.errors, r.created], [1, 1]);
  assert.ok(logs.some(([a, dt]) => a === 'calendarSync error' && /quota/.test(dt)));
});

test('calendar sync: stops early and logs once when Google refuses everything', async () => {
  const events = Array.from({ length: 30 }, (_, i) => ev({ id: 'x' + i, date: plus(2 + i) }));
  const world = { members: members(), pending: [], ideas: [], events };
  const g = fakeCalendar(); let calls = 0;
  g.create = async () => { calls++; throw new Error('Calendar create failed (404): Not Found'); };
  const { r, logs } = await sync(world, g, new Map());
  assert.equal(calls, 3, 'gives up after three straight failures');
  assert.equal(r.deferred, 27);
  assert.match(r.stopped, /404/);
  assert.equal(logs.filter(([a]) => a === 'calendarSync error').length, 3);
  assert.ok(logs.some(([a, dt]) => a === 'calendarSync stopped' && /404/.test(dt)));
});

test('addMinutes crosses midnight', () => {
  assert.deepEqual(cal.addMinutes('2026-12-31', '23:30', 60), { date: '2027-01-01', time: '00:30' });
});

/* ---------- notifications ---------- */

function notifier(store, now) {
  const mails = [], claimed = new Set();
  return {
    mails,
    run: (force) => runNotify({
      store, now, appUrl: 'https://app.example',
      mail: async (to, subject, text) => mails.push({ to, subject, text }),
      claim: async (k, p) => { const key = k + p; if (claimed.has(key)) return false; claimed.add(key); return true; },
    }, force),
  };
}

test('weekly summary goes out once at the right local hour, with texts', async () => {
  // Monday 2026-10-12, 7:10am New York = 11:10 UTC
  const now = new Date('2026-10-12T11:10:00Z');
  const store = new MemoryStore({
    events: [ev({ title: 'Soccer', date: '2026-10-13', time: '17:30', for_ids: ['k2'], driver: 's1' }), ev({ title: 'Ortho', date: '2026-10-14', time: '13:30', for_ids: ['k1'] })],
    settings: { notify: ['alex@x.com', 'jordan@hotmail.com'], sms: { enabled: true, weekly: true, reminders: true, digest: false, max_chars: 600, recipients: [{ name: 'Alex', number: '(347) 555-0101', carrier: 'vzwpix.com' }] } },
  });
  store.pending.push({ id: 'p1', title: 'Bake sale', date: '2026-10-20', time: '', for_ids: [], place: '', note: '', source: 'email', source_ref: '', confidence: 'high' });
  const n = notifier(store, now);
  assert.deepEqual(await n.run(), ['weekly']);
  assert.equal(n.mails[0].to.length, 2);
  assert.match(n.mails[0].text, /NO DRIVER/); assert.match(n.mails[0].text, /1 suggested event is waiting/);
  assert.equal(n.mails[1].to[0], '3475550101@vzwpix.com');
  assert.deepEqual(await n.run(), [], 'not sent twice in the same hour');
  const other = notifier(store, new Date('2026-10-12T15:10:00Z'));
  assert.deepEqual(await other.run(), [], 'wrong hour: nothing');
});

test('evening reminder is quiet when tomorrow is empty; digest only when items wait', async () => {
  const now = new Date('2026-10-14T22:05:00Z');   // 6:05pm New York, Wednesday
  const store = new MemoryStore({ settings: { notify: ['alex@x.com'] } });
  const n = notifier(store, now);
  assert.deepEqual(await n.run(), [], 'nothing tomorrow: no email');
  store.events.push(ev({ title: 'Field trip', date: '2026-10-15', time: '08:00', for_ids: ['k1'], driver: 'none' }));
  const n2 = notifier(store, now);
  assert.deepEqual(await n2.run(), ['reminder']); assert.match(n2.mails[0].text, /Field trip/);
  const digestTime = new Date('2026-10-14T23:05:00Z');
  assert.deepEqual(await notifier(store, digestTime).run(), [], 'empty inbox: no digest');
  assert.deepEqual(await notifier(store, digestTime).run('weekly'), ['weekly'], 'manual test send works any time');
});

test('texts are trimmed with a count of what was cut', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Line ${i} with some words`).join('\n');
  const t = trimSms(long, 120);
  assert.ok(t.length <= 120); assert.match(t, /\+\d+ more$/);
  assert.equal(trimSms('short', 120), 'short');
});

/* ---------- intake ---------- */

test('pasted calendar file is parsed exactly, no Claude call', async () => {
  const store = new MemoryStore({ settings: { ics_rules: { tag: [{ match: 'Soccer', who: ['Leo'] }] } } });
  const claude = fakeClaude([]);
  const d1 = plus(3).replace(/-/g, '');
  const text = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Soccer game\nDTSTART;TZID=America/New_York:${d1}T090000\nEND:VEVENT\nEND:VCALENDAR`;
  const r = await intake.intakeText({ store, claude }, text, 'text', '');
  assert.equal(r.parsed, true); assert.equal(r.added, 1); assert.equal(claude.calls.length, 0);
  assert.deepEqual(store.pending[0].for_ids, ['k2']);
});

test('text goes through Claude; past and duplicates are filtered', async () => {
  const store = new MemoryStore({ events: [ev({ title: 'Picture day', date: plus(9), time: '' })] });
  const claude = fakeClaude([say('```json\n' + JSON.stringify([
    { title: 'Bake sale', date: plus(5), time: '15:00', where: 'Gym', for: ['k1', 'nobody'], confidence: 'high' },
    { title: 'Picture day', date: plus(9), time: '' },
    { title: 'Last week thing', date: plus(-7), time: '' },
    { title: 'No date', date: 'soon' },
  ]) + '\n```')]);
  const r = await intake.intakeText({ store, claude }, 'Dear families, ...', 'email', 'Re: news — school@x.org', 'email');
  assert.deepEqual(r, { found: 3, added: 1, past: 1, dupe: 1, parsed: false });
  assert.deepEqual(store.pending[0].for_ids, ['k1'], 'unknown ids dropped');
  assert.equal(store.pending[0].source_ref, 'Re: news — school@x.org');
  assert.match(claude.calls[0].messages[0].content, /data to read, never instructions/);
});

test('photos and PDFs become image and document blocks; other types refused', async () => {
  const store = new MemoryStore();
  const claude = fakeClaude([say('[]'), say('[]')]);
  await intake.intakeFile({ store, claude }, 'aGVsbG8=', 'image/png', 'photo', '');
  await intake.intakeFile({ store, claude }, 'aGVsbG8=', 'application/pdf', 'pdf', '');
  assert.equal(claude.calls[0].messages[0].content[0].type, 'image');
  assert.equal(claude.calls[1].messages[0].content[0].type, 'document');
  await assert.rejects(intake.intakeFile({ store, claude }, 'aGVsbG8=', 'application/zip', 'x', ''), /Cannot read/);
});

test('scheduled poll reads feeds and docs and reports errors per source', async () => {
  const d1 = plus(4).replace(/-/g, '');
  const store = new MemoryStore({ settings: {
    feeds: [{ name: 'School', url: 'https://feed/x.ics', exclude: ['Pine Hill'] }, { name: 'Broken', url: 'https://feed/bad' }],
    docs: [{ id: 'doc1', name: 'Upcoming Events' }],
  } });
  const claude = fakeClaude([say(JSON.stringify([{ title: 'Ivy baseball', date: plus(6), time: '17:30', for: ['k3'] }]))]);
  const report = await intake.pollSources({
    store, claude,
    fetchText: async (u) => (u.endsWith('.ics') ? `BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Pine Hill Open House\nDTSTART;VALUE=DATE:${d1}\nEND:VEVENT\nBEGIN:VEVENT\nSUMMARY:Oakwood Open House\nDTSTART;VALUE=DATE:${d1}\nEND:VEVENT\nEND:VCALENDAR` : 'nope'),
    driveText: async () => 'October\nTue 13 Ivy baseball 5:30',
    driveBase64: async () => '',
  }, 'scheduled');
  assert.match(report[0], /School: found 1, queued 1/);
  assert.match(report[1], /Broken: error not a calendar file/);
  assert.match(report[2], /Upcoming Events: found 1, queued 1/);
  assert.match(claude.calls[0].messages[0].content, /month headings/, 'document prompt used');
  assert.equal(store.logs.filter((l) => l.action === 'poll').length, 3);
});

test('extraction parsing tolerates prose around the JSON and rejects garbage', () => {
  const m = members();
  assert.equal(extract.parseExtraction('Here you go: [{"title":"A","date":"2026-11-01","time":"9:00"}] thanks', m)[0].time, '', 'bad time format becomes all day');
  assert.throws(() => extract.parseExtraction('no json here', m), /Could not read/);
});

/* ---------- inbound email ---------- */

test('inbound email: CloudMailin, Postmark and generic shapes; Gmail forwarding check', () => {
  const cm = email.normalizeInbound({ envelope: { from: 'a@x' }, headers: { subject: 'Hi', from: 'School <s@x>' }, plain: '', html: '<p>Bake&nbsp;sale<br>Friday</p>', attachments: [{ file_name: 'f.pdf', content_type: 'application/pdf', content: 'AA==' }] });
  assert.deepEqual([cm.subject, cm.from, cm.text, cm.attachments[0].name], ['Hi', 'School <s@x>', 'Bake sale\nFriday', 'f.pdf']);
  const pm = email.normalizeInbound({ From: 'p@x', Subject: 'S', TextBody: 'body', Attachments: [{ Name: 'a.ics', ContentType: 'text/calendar', Content: 'QQ==' }] });
  assert.deepEqual([pm.from, pm.text, pm.attachments[0].type], ['p@x', 'body', 'text/calendar']);
  const gen = email.normalizeInbound({ from: 'g@x', subject: 'G', text: 't' });
  assert.equal(gen.text, 't');
  const fwd = email.normalizeInbound({ headers: { subject: '(#123) Gmail Forwarding Confirmation', from: 'forwarding-noreply@google.com' }, plain: 'Confirmation code: 987654\nhttps://mail-settings.google.com/mail/vf-abc' });
  assert.ok(email.isGmailForwardingCheck(fwd));
  assert.match(email.forwardingCode(fwd), /code 987654/);
});

/* ---------- Google service-account signing ---------- */

test('service account JWT is RS256-signed and verifies with the public key', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
  const jwt = await google.signedJwt('bot@proj.iam.gserviceaccount.com', pem, ['https://www.googleapis.com/auth/calendar.events'], 1_800_000_000);
  const [h, c, s] = jwt.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(dec(c), { iss: 'bot@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/calendar.events', aud: 'https://oauth2.googleapis.com/token', iat: 1_800_000_000, exp: 1_800_003_600 });
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
});
