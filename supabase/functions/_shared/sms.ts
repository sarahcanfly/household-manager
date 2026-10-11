// Real text messages through Twilio, replacing carrier email-to-text gateways
// (which Verizon and others are shutting down). Used when the Twilio secrets are set.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either TWILIO_FROM (the
// Twilio number, +15085550123) or TWILIO_MESSAGING_SERVICE_SID (MG…).

import { env } from './env.ts';

export type Texter = (to: string, body: string) => Promise<void>;

export const twilioReady = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && (env('TWILIO_FROM') || env('TWILIO_MESSAGING_SERVICE_SID')));

/** "(508) 555-0123", "508.555.0123", "15085550123" -> "+15085550123". US numbers assumed without a country code. */
export function e164(number: string): string {
  const raw = String(number ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error(`"${raw}" does not look like a phone number`);
}

/** Twilio's error codes that need a person to fix something, in plain words. */
export function twilioHint(code: number | undefined, message: string): string {
  switch (code) {
    case 21608: return 'Twilio trial accounts can only text numbers you have verified in the Twilio console (Phone Numbers → Verified Caller IDs).';
    case 21610: return 'That person replied STOP. They need to text START to the household number to get texts again.';
    case 30034: return 'Twilio blocked it because the number is not registered for texting yet (A2P 10DLC). Finish the registration in the Twilio console.';
    case 21211: case 21614: return 'Twilio says that is not a mobile number it can text.';
    case 20003: return 'Twilio rejected the account SID or auth token. Check the TWILIO_ secrets.';
    case 21606: case 21212: return 'TWILIO_FROM is not a Twilio number on this account that can send texts.';
    default: return message;
  }
}

export function twilioTexter(fetcher: typeof fetch = fetch): Texter {
  return async (to, body) => {
    const sid = env('TWILIO_ACCOUNT_SID'), token = env('TWILIO_AUTH_TOKEN');
    const form = new URLSearchParams({ To: e164(to), Body: body.slice(0, 1500) });
    const service = env('TWILIO_MESSAGING_SERVICE_SID');
    if (service) form.set('MessagingServiceSid', service); else form.set('From', e164(env('TWILIO_FROM')));
    const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (res.ok) return;
    let code: number | undefined, message = `Twilio ${res.status}`;
    try { const j = await res.json() as { code?: number; message?: string }; code = j.code; message = j.message || message; } catch { /* keep status */ }
    throw new Error(twilioHint(code, message));
  };
}
