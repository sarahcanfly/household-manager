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
    'Around town this week (suggestions, not on the calendar):',
    '- Tue Oct 13: Library story time — Ashland Farm, Ashland (Free)', '  All ages', '  https://lib.example/story',
    '- Sat Oct 17 10am: Pumpkin festival — Ashland Farm, Ashland (Free)', '  All ages', '  https://example.org/pumpkins']);
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
  assert.match(mails[0], /Around town this week[\s\S]*Pumpkin festival[\s\S]*https:\/\/example.org\/pumpkins/);
  await runNotify({ ...base, around: async () => { throw new Error('web search is not enabled'); } }, 'weekly');
  assert.equal(mails.length, 2); assert.doesNotMatch(mails[1], /Around town/);
  assert.ok(store.logs.some((l) => l.action === 'local events error'));
});
