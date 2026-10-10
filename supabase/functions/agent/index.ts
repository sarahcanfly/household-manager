// POST { action: 'ask', message, history }  -> { reply, pending, changed }
// POST { action: 'confirm', token }         -> { reply, changed }
import { body, handler, HttpError, json } from '../_shared/http.ts';
import { requireUser } from '../_shared/auth.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { callClaude } from '../_shared/claude.ts';
import { sendMail } from '../_shared/mail.ts';
import { Agent } from '../_shared/agent.ts';

Deno.serve(handler(async (req) => {
  const actor = await requireUser(req);
  const b = await body(req);
  const store = new RestStore(serviceDb());
  const notify = async (subject: string, lines: string[], who: string) => {
    const s = await store.settings();
    const to = (s.notify ?? []).filter((e) => e.toLowerCase() !== who.toLowerCase());   // do not email people about their own change
    if (to.length) await sendMail(to, subject, lines.join('\n'));
  };
  const agent = new Agent({ store, claude: callClaude, actor, notify });
  if (b.action === 'confirm') return json(await agent.confirm(String(b.token ?? '')));
  if (b.action === 'ask') return json(await agent.ask(String(b.message ?? ''), b.history));
  throw new HttpError(400, 'Unknown request.');
}));
