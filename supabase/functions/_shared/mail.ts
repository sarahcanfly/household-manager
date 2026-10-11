// Outgoing email (and texts, via carrier email gateways). Uses Brevo's HTTP API,
// or Resend if that key is set instead.

import { env, must } from './env.ts';
import type { SmsRecipient } from './store.ts';

export type Mailer = (to: string[], subject: string, text: string) => Promise<void>;

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const DAY_HEAD = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Today|Tomorrow)\b/;

/**
 * The plain-text email as simple HTML: section headings ("To do:") and day headings
 * ("Monday Oct 12") in bold, "Label: https://…" lines as links, everything else as written.
 */
export function textToHtml(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { out.push('<div style="height:10px"></div>'); continue; }
    const link = line.match(/^(\s*)([A-Za-z][A-Za-z ]{1,30}): (https?:\/\/\S+)$/);
    if (link) {
      out.push(`<div style="padding-left:${link[1].length ? 16 : 0}px;margin:2px 0"><a href="${escHtml(link[3])}" style="color:#2E5E8C">${escHtml(link[2])}</a></div>`);
      continue;
    }
    // A row of [label](url) links, e.g. "[Details](…) · [Add to calendar](…)".
    if (/\[[^\]]+\]\(https?:\/\/[^)\s]+\)/.test(line)) {
      const html = escHtml(line.trim()).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => `<a href="${url}" style="color:#2E5E8C;white-space:nowrap">${label}</a>`);
      out.push(`<div style="padding-left:${/^\s/.test(line) ? 16 : 0}px;margin:4px 0">${html}</div>`);
      continue;
    }
    if (/^https?:\/\/\S+$/.test(line.trim())) { out.push(`<div><a href="${escHtml(line.trim())}" style="color:#2E5E8C">${escHtml(line.trim())}</a></div>`); continue; }
    const heading = !/^[\s-]/.test(line) && (line.endsWith(':') || DAY_HEAD.test(line));
    if (heading) {
      const big = line.endsWith(':');
      out.push(`<div style="font-weight:700;font-size:${big ? 17 : 15}px;margin:${big ? 18 : 12}px 0 4px">${escHtml(line)}</div>`);
      continue;
    }
    const indent = (line.match(/^\s*/)?.[0].length ?? 0);
    out.push(`<div style="padding-left:${Math.min(indent, 4) * 4}px;margin:2px 0">${escHtml(line.trim())}</div>`);
  }
  return `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#1F2421;max-width:620px">${out.join('')}</div>`;
}

export const sendMail: Mailer = async (to, subject, text) => {
  const list = [...new Set(to.map((t) => t.trim()).filter(Boolean))];
  if (!list.length) return;
  const fromName = env('MAIL_FROM_NAME', 'Household Manager');
  if (env('BREVO_API_KEY')) {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': must('BREVO_API_KEY'), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: must('MAIL_FROM'), name: fromName }, to: list.map((email) => ({ email })), subject, textContent: text, htmlContent: textToHtml(text) }),
    });
    if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (env('RESEND_API_KEY')) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${must('RESEND_API_KEY')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${must('MAIL_FROM')}>`, to: list, subject, text, html: textToHtml(text) }),
    });
    if (!res.ok) throw new Error(`Email failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  throw new Error('No email service set up. Add BREVO_API_KEY (or RESEND_API_KEY) and MAIL_FROM.');
};

export const smsAddress = (r: SmsRecipient) => `${r.number.replace(/\D/g, '')}@${(r.carrier ?? '').replace(/^@/, '')}`;
