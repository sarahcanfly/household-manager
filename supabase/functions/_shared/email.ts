// Inbound email arrives as JSON from an email-to-webhook service. Different
// services name things differently; this turns any of them into one shape.

export interface Attachment { name: string; type: string; base64: string }
export interface InboundEmail { from: string; subject: string; text: string; attachments: Attachment[] }

const s = (v: unknown) => (v == null ? '' : String(v));

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeInbound(p: Record<string, any>): InboundEmail {
  // CloudMailin (JSON normalized format)
  if (p.envelope || p.plain !== undefined || p.headers?.subject !== undefined) {
    return {
      from: s(p.headers?.from ?? p.envelope?.from),
      subject: s(p.headers?.subject),
      text: s(p.plain) || htmlToText(s(p.html)),
      attachments: (p.attachments ?? []).map((a: any) => ({ name: s(a.file_name), type: s(a.content_type), base64: s(a.content) })),
    };
  }
  // Postmark
  if (p.TextBody !== undefined || p.HtmlBody !== undefined || p.From !== undefined) {
    return {
      from: s(p.From), subject: s(p.Subject),
      text: s(p.TextBody) || htmlToText(s(p.HtmlBody)),
      attachments: (p.Attachments ?? []).map((a: any) => ({ name: s(a.Name), type: s(a.ContentType), base64: s(a.Content) })),
    };
  }
  // Generic
  return {
    from: s(p.from), subject: s(p.subject),
    text: s(p.text) || htmlToText(s(p.html)),
    attachments: (p.attachments ?? []).map((a: any) => ({ name: s(a.name ?? a.filename), type: s(a.type ?? a.contentType), base64: s(a.base64 ?? a.content) })),
  };
}

/** Gmail sends a confirmation code to a new forwarding address before it forwards anything. */
export const isGmailForwardingCheck = (e: InboundEmail) =>
  /forwarding-noreply@google\.com/i.test(e.from) || /Gmail Forwarding Confirmation/i.test(e.subject);

export function forwardingCode(e: InboundEmail): string {
  const code = e.text.match(/Confirmation code:\s*(\d+)/i)?.[1];
  const link = e.text.match(/https:\/\/mail[^\s]*google\.com[^\s]*/i)?.[0];
  return [code ? `code ${code}` : '', link ? `link ${link}` : ''].filter(Boolean).join(' · ') || e.text.slice(0, 500);
}
