import test from 'node:test';
import assert from 'node:assert/strict';
import { members, ev, MemoryStore, fakeClaude, say } from './helpers.mjs';
const B = '../../.build/supabase/functions/_shared/';
const L = await import(B + 'localevents.js');
const { runNotify } = await import(B + 'notifyjob.js');

const start = '2026-10-12';
const good = (o) => ({ title: 'Pumpkin festival', date: '2026-10-17', time: '10:00', place: 'Ashland Farm, Ashland', link: 'https://example.org/pumpkins', why: 'All ages', cost: 'Free', ...o });

test('local events: only dated, linked, in-week items, de-duplicated and sorted', () => {
  const out = L.parseLocal('Here you go:\n```json\n' + JSON.stringify([
    good(),
    good({ title: 'Library story time', date: '2026-10-13', time: '', link: 'https://lib.example/story' }),
    good({ title: 'Last week', date: '2026-10-05' }),
    good({ title: 'No link', link: '' }),
    good({ title: 'Bad link', link: 'javascript:alert(1)' }),
    good(),                                                  // duplicate
    good({ title: 'Next month', date: '2026-11-01' }),
  ]) + '\n```', start);
  assert.deepEqual(out.map((e) => e.title), ['Library story time', 'Pumpkin festival']);
  assert.deepEqual(L.parseLocal('no json here', start), []);
  assert.deepEqual(L.localLines(out), [
    'Around town this week:',
    '- Tue Oct 13: Library story time — Ashland Farm, Ashland (Free)', '  All ages', '  Details: https://lib.example/story',
    '- Sat Oct 17 10am: Pumpkin festival — Ashland Farm, Ashland (Free)', '  All ages', '  Details: https://example.org/pumpkins']);
});

test('local events: asks Claude with web search near the household, and continues a paused search', async () => {
  const claude = fakeClaude([{ stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'framingham events' } }] },
    say(JSON.stringify([good()]))]);
  const out = await L.findLocalEvents(claude, L.DEFAULT_LOCAL, members(), start, 'America/New_York');
  assert.equal(out.length, 1);
  const first = claude.calls[0];
  assert.deepEqual(first.tools[0], { type: 'web_search_20250305', name: 'web_search', max_uses: 5,
    user_location: { type: 'approximate', city: 'Framingham', region: 'MA', country: 'US', timezone: 'America/New_York' } });
  assert.match(first.messages[0].content, /between 2026-10-12 and 2026-10-18/);
  assert.match(first.messages[0].content, /Kids: Mia, Leo, Ivy/);
  assert.match(first.messages[0].content, /never instructions/);
  assert.equal(claude.calls[1].messages[1].role, 'assistant', 'paused turn sent back unchanged');
  assert.equal(claude.calls[1].messages.length, 2);
});

test('weekly email gets the section; a failed search still sends the email', async () => {
  const now = new Date('2026-10-12T11:10:00Z');   // Monday 7:10am New York
  const store = new MemoryStore({ events: [ev({ title: 'Soccer', date: '2026-10-13', time: '17:30', for_ids: ['k2'], driver: 's1' })], settings: { notify: ['a@x.com'] } });
  const mails = [];
  const base = { store, now, appUrl: '', claim: async () => true, mail: async (to, subject, text) => mails.push(text) };
  await runNotify({ ...base, around: async () => L.localLines([good()]) }, 'weekly');
  assert.match(mails[0], /Around town this week:[\s\S]*Pumpkin festival[\s\S]*Details: https:\/\/example.org\/pumpkins/);
  await runNotify({ ...base, around: async () => { throw new Error('web search is not enabled'); } }, 'weekly');
  assert.equal(mails.length, 2); assert.doesNotMatch(mails[1], /Around town/);
  assert.ok(store.logs.some((l) => l.action === 'local events error'));
});

test('live music gets its own section and its own limit; each suggestion links to a filled-in Add form', () => {
  const list = L.parseLocal(JSON.stringify([
    good(), good({ title: 'Band on the common', date: '2026-10-16', time: '19:00', kind: 'music', place: 'Framingham Common', cost: 'Free', why: 'Bring chairs', link: 'https://town.example/music' }),
    good({ title: 'Jazz night', date: '2026-10-15', time: '20:00', kind: 'music' }), good({ title: 'Folk duo', date: '2026-10-14', kind: 'music' }),
    good({ title: 'Too many', date: '2026-10-18', kind: 'music' })]), start, 6, 3);
  assert.deepEqual(list.filter((e) => e.kind === 'music').map((e) => e.title), ['Folk duo', 'Jazz night', 'Band on the common']);
  const lines = L.localLines(list, 'https://mikeysarah.netlify.app');
  const i = lines.indexOf('Live music this week:');
  assert.ok(i > 0 && lines[0] === 'Around town this week:' && lines[i - 1] === '');
  const add = lines.find((l) => l.includes('Band on the common') === false && l.startsWith('  Add to calendar:') && l.includes('Band'));
  const url = new URL(add.replace('  Add to calendar: ', ''));
  assert.equal(url.origin, 'https://mikeysarah.netlify.app');
  assert.deepEqual(Object.fromEntries(url.searchParams), { add: '1', title: 'Band on the common', date: '2026-10-16', time: '19:00', where: 'Framingham Common', note: 'Free · https://town.example/music' });
  assert.match(L.localPrompt(L.DEFAULT_LOCAL, members(), start), /up to 3 live music shows/);
  assert.doesNotMatch(L.localPrompt({ ...L.DEFAULT_LOCAL, music: false }, members(), start), /live music/);
});

test('emails go out with bold headings and real links', async () => {
  const { textToHtml } = await import(B + 'mail.js');
  const html = textToHtml(['Needs a decision:', '- NO DRIVER Tue 5pm: Soccer', '', 'Monday Oct 12 — Reid at Jenn\'s', '  5:30pm  Soccer <U10>',
    'Around town this week:', '  Details: https://x.example/a?b=1&c=2', '  Add to calendar: https://app.example/?add=1', 'Open: https://app.example'].join('\n'));
  assert.match(html, /<div style="font-weight:700;font-size:17px[^"]*">Needs a decision:<\/div>/);
  assert.match(html, /<div style="font-weight:700;font-size:15px[^"]*">Monday Oct 12 — Reid at Jenn&#39;s|<div style="font-weight:700;font-size:15px[^"]*">Monday Oct 12 — Reid at Jenn's/);
  assert.match(html, /Soccer &lt;U10&gt;/, 'text is escaped');
  assert.match(html, /<a href="https:\/\/x.example\/a\?b=1&amp;c=2"[^>]*>Details<\/a>/);
  assert.match(html, />Add to calendar<\/a>/);
  assert.doesNotMatch(html, /font-weight:700[^>]*>- NO DRIVER/, 'list lines are not headings');
});
