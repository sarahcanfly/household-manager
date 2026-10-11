// Web Push: notifications on phones that installed the app (iPhone 16.4+, Android).
// No packages: VAPID signing (RFC 8292) and payload encryption (RFC 8291,
// aes128gcm) are done with WebCrypto, so this runs the same in Deno and Node.

import { b64url } from './google.ts';

export interface PushSub { endpoint: string; p256dh: string; auth: string; email?: string }
export interface VapidKeys { publicKey: string; privateJwk: JsonWebKey }
export interface PushMessage { title: string; body: string; url?: string; tag?: string }
/** 'gone' means the phone unsubscribed or reinstalled: forget the subscription. */
export type PushResult = 'sent' | 'gone' | 'error';

const enc = new TextEncoder();

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** A new signing key pair. The public half goes to phones; the private half stays in the database. */
export async function makeVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

/** The Authorization header value for one push service (audience = its origin). */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));   // raw r||s, as JWS wants
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291 encryption of one message for one subscription. Returns the request body. */
/** `fixed` is only for checking against the RFC's worked example. */
export async function encryptPayload(sub: PushSub, plaintext: Uint8Array<ArrayBuffer>, fixed?: { salt: Uint8Array<ArrayBuffer>; keys: CryptoKeyPair }): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(sub.p256dh), authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const as = fixed?.keys ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));

  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([65]), asPublic, cipher);
}

/** Keep the payload well under the 4 KB push limit. */
export function pushJson(m: PushMessage): string {
  const body = m.body.length > 1500 ? m.body.slice(0, 1497) + '…' : m.body;
  return JSON.stringify({ title: m.title.slice(0, 120), body, url: m.url ?? '', tag: m.tag ?? '' });
}

export async function sendPush(sub: PushSub, m: PushMessage, keys: VapidKeys, subject: string, fetcher: typeof fetch = fetch): Promise<PushResult> {
  const payload = await encryptPayload(sub, enc.encode(pushJson(m)));
  const res = await fetcher(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(24 * 3600),
      Urgency: 'normal',
    },
    body: payload,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) { console.error('push failed', res.status, (await res.text()).slice(0, 200)); return 'error'; }
  return 'sent';
}
