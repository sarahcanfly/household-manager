import test from 'node:test';
import assert from 'node:assert/strict';
const B = '../../.build/supabase/functions/_shared/';
const wp = await import(B + 'webpush.js');
const { runNotify, pushFrom } = await import(B + 'notifyjob.js');
const { MemoryStore, ev } = await import('./helpers.mjs');

const b64u = (u8) => Buffer.from(u8).toString('base64url');
async function ecdhPair(d, pub) {
  const raw = Buffer.from(pub, 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', d, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)), ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { privateKey, publicKey };
}

test('encryption matches the worked example in RFC 8291 section 5', async () => {
  const keys = await ecdhPair('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const sub = { endpoint: 'https://push.example.net/x',
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const out = await wp.encryptPayload(sub, new TextEncoder().encode('When I grow up, I want to be a watermelon'),
    { salt: wp.fromB64url('DGv6ra1nlYgDCS1FRnbzlw'), keys });
  assert.equal(b64u(out), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('VAPID header is an ES256 JWT for the push service origin, verifiable with the public key', async () => {
  const keys = await wp.makeVapidKeys();
  const h = await wp.vapidAuth('https://web.push.apple.com/QAbc', keys, 'mailto:a@b.com', Date.UTC(2026, 9, 11));
  const m = h.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.deepEqual([claims.aud, claims.sub, claims.exp], ['https://web.push.apple.com', 'mailto:a@b.com', Date.UTC(2026, 9, 11) / 1000 + 43200]);
  const pub = await crypto.subtle.importKey('raw', Buffer.from(keys.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(m[3], 'base64url'), new TextEncoder().encode(`${m[1]}.${m[2]}`)));
});

test('sendPush posts an encrypted body and reports gone phones', async () => {
  const keys = await wp.makeVapidKeys();
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) };
  const calls = [];
  const fetcher = (status) => async (url, init) => { calls.push({ url, init }); return new Response('', { status }); };
  assert.equal(await wp.sendPush(sub, { title: 'T', body: 'B' }, keys, 'mailto:x@y.z', fetcher(201)), 'sent');
  const { init } = calls[0];
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.match(init.headers.Authorization, /^vapid t=/);
  assert.equal(init.body[20], 65, 'header carries the 65-byte server key');
  assert.ok(init.body.length > 86 + 16);
  assert.equal(await wp.sendPush(sub, { title: 'T', body: 'B' }, keys, 'mailto:x@y.z', fetcher(410)), 'gone');
  assert.equal(await wp.sendPush(sub, { title: 'T', body: 'B' }, keys, 'mailto:x@y.z', fetcher(403)), 'error');
});

test('payloads stay small', () => {
  const j = JSON.parse(wp.pushJson({ title: 'x'.repeat(300), body: 'y'.repeat(5000) }));
  assert.equal(j.title.length, 120); assert.ok(j.body.length <= 1500);
});

test('evening reminder becomes a notification, and a push failure does not stop the email', async () => {
  const now = new Date('2026-10-12T22:10:00Z');   // 6:10pm New York
  const store = new MemoryStore({ events: [ev({ title: 'Ortho', date: '2026-10-13', time: '13:30', for_ids: ['k1'], driver: 's1' })], settings: { notify: ['a@x.com'] } });
  const pushes = [], mails = [];
  const base = { store, now, appUrl: 'https://app.example', claim: async () => true, mail: async (to, subject) => mails.push(subject) };
  await runNotify({ ...base, push: async (m) => pushes.push(m) });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, mails[0]);
  assert.match(pushes[0].body, /^1:30pm Ortho/);
  assert.equal(pushes[0].url, 'https://app.example');
  mails.length = 0;
  await runNotify({ ...base, push: async () => { throw new Error('boom'); } });
  assert.equal(mails.length, 1, 'email still sent');
  assert.ok(store.logs.some((l) => l.action === 'push error'));
});

test('push can be turned off per message', async () => {
  const now = new Date('2026-10-12T22:10:00Z');
  const store = new MemoryStore({ events: [ev({ title: 'Ortho', date: '2026-10-13', time: '13:30', for_ids: ['k1'] })], settings: { push: { weekly: true, reminders: false, digest: true } } });
  const pushes = [];
  await runNotify({ store, now, appUrl: '', claim: async () => true, mail: async () => {}, push: async (m) => pushes.push(m) });
  assert.equal(pushes.length, 0);
  assert.equal(pushFrom('digest', { subject: '2 waiting', sms: '2 events waiting.' }, '').body, '2 events waiting.');
});
