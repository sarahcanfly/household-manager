// The Inbox's "Find events" button.
// POST { kind: 'text', text }                    pasted email, newsletter, or a whole .ics file
// POST { kind: 'file', base64, media_type }      a photo or a PDF
import { body, handler, HttpError, json } from '../_shared/http.ts';
import { requireUser } from '../_shared/auth.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { callClaude } from '../_shared/claude.ts';
import { intakeFile, intakeText } from '../_shared/intake.ts';

Deno.serve(handler(async (req) => {
  const actor = await requireUser(req);
  const b = await body<{ kind?: string; text?: string; base64?: string; media_type?: string }>(req);
  const store = new RestStore(serviceDb());
  const d = { store, claude: callClaude };
  let r;
  if (b.kind === 'text') {
    if (!b.text?.trim()) throw new HttpError(400, 'Paste something first.');
    r = await intakeText(d, b.text, 'text', '');
  } else if (b.kind === 'file') {
    const type = String(b.media_type ?? 'image/jpeg');
    r = await intakeFile(d, String(b.base64 ?? ''), type, type === 'application/pdf' ? 'pdf' : 'photo', '');
  } else throw new HttpError(400, 'Unknown request.');
  await store.log(actor, 'intake', `${b.kind}: found ${r.found}, queued ${r.added}`);
  return json(r);
}));
