// Emails forwarded to the household address arrive here from the email-to-webhook
// service, at  .../inbound-email?key=<INBOUND_SECRET>
// Everything found goes to the Inbox for approval.
import { handler, HttpError, json } from '../_shared/http.ts';
import { must, safeEqual } from '../_shared/env.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { callClaude } from '../_shared/claude.ts';
import { intakeFile, intakeIcs, intakeText, type IntakeResult } from '../_shared/intake.ts';
import { forwardingCode, isGmailForwardingCheck, normalizeInbound } from '../_shared/email.ts';

const MIN_IMAGE_B64 = 30_000;   // smaller images are logos and signatures, not flyers

Deno.serve(handler(async (req) => {
  const url = new URL(req.url);
  if (!safeEqual(url.searchParams.get('key') ?? '', must('INBOUND_SECRET'))) throw new HttpError(401, 'Not allowed.');
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { throw new HttpError(400, 'Send the email as JSON.'); }

  const mail = normalizeInbound(payload);
  const store = new RestStore(serviceDb());
  if (isGmailForwardingCheck(mail)) {
    await store.log('email', 'gmail forwarding confirmation', forwardingCode(mail));
    return json({ ok: true, note: 'forwarding confirmation logged' });
  }

  const d = { store, claude: callClaude };
  const ref = `${mail.subject || '(no subject)'} — ${mail.from}`.slice(0, 300);
  const results: string[] = [];
  const add = (label: string, r: IntakeResult) => results.push(`${label}: found ${r.found}, queued ${r.added}`);

  for (const a of mail.attachments) {
    try {
      const type = a.type.toLowerCase();
      if (type.includes('calendar') || a.name.toLowerCase().endsWith('.ics')) {
        const text = new TextDecoder().decode(Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0)));
        add(a.name, await intakeIcs(d, text, 'email', ref));
      }
      else if (type === 'application/pdf') add(a.name, await intakeFile(d, a.base64, type, 'email', ref));
      else if (/^image\/(jpeg|png|webp|gif)$/.test(type) && a.base64.length >= MIN_IMAGE_B64) add(a.name, await intakeFile(d, a.base64, type, 'email', ref));
    } catch (e) { results.push(`${a.name}: error ${(e as Error).message}`); }
  }
  if (mail.text.trim().length > 40) {
    try { add('body', await intakeText(d, `Subject: ${mail.subject}\nFrom: ${mail.from}\n\n${mail.text}`, 'email', ref, 'email')); }
    catch (e) { results.push(`body: error ${(e as Error).message}`); }
  }
  await store.log('email', 'inbound email', `${ref} | ${results.join('; ') || 'nothing to read'}`);
  return json({ ok: true, results });
}));
