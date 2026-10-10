// Hourly: read the subscribed calendar feeds and shared Google Docs into the Inbox.
// Also runs when someone taps "Check feeds now".
import { handler, json } from '../_shared/http.ts';
import { requireCronOrUser } from '../_shared/auth.ts';
import { serviceDb } from '../_shared/db.ts';
import { RestStore } from '../_shared/store.ts';
import { callClaude } from '../_shared/claude.ts';
import { pollSources } from '../_shared/intake.ts';
import { driveBase64, driveText } from '../_shared/google.ts';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`feed returned ${res.status}`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new Error('feed is too large');
  return text;
}

Deno.serve(handler(async (req) => {
  const actor = await requireCronOrUser(req);
  const store = new RestStore(serviceDb());
  const report = await pollSources({ store, claude: callClaude, fetchText, driveText, driveBase64 }, actor);
  return json({ ok: true, report });
}));
