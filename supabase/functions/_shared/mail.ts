// Outgoing email (and texts, via carrier email gateways). Uses Brevo's HTTP API,
// or Resend if that key is set instead.

import { env, must } from './env.ts';
import type { SmsRecipient } from './store.ts';

export type Mailer = (to: string[], subject: string, text: string) => Promise<void>;

export const sendMail: Mailer = async (to, subject, text) => {
  const list = [...new Set(to.map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return;
  const fromName = env('MAIL_FROM_NAME', 'Household Manager');
  if (env('BREVO_API_KEY')) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': must('BREVO_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: must('MAIL_FROM'), name: fromName }, to: list.map((email) => ({ email })), subject, textContent: text }),
    });
    if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (env('RESEND_API_KEY')) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${must('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${must('MAIL_FROM')}>`, to: list, subject, text }),
    });
    if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error('No email service set up. Add BREVO_API_KEY (or RESEND_API_KEY) and MAIL_FROM.');
};

export const smsAddress = (r: SmsRecipient) => `${r.number.replace(/\D/g, '')}@${(r.carrier ?? '').replace(/^@/, '')}`;
