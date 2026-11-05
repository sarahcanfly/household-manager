import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, fakeClaude, say, use, lastToolResults } from './helpers.mjs';
const { checkPublicUrl, readLink } = await import('../../.build/supabase/functions/_shared/webpage.js');
const { Agent } = await import('../../.build/supabase/functions/_shared/agent.js');

const page = (body, type = 'text/html; charset=utf-8', status = 200, headers = {}) =>
  async () => new Response(body, { status, headers: { 'content-type': type, ...headers } });

test('only plain public web addresses are allowed', () => {
  assert.equal(checkPublicUrl('https://www.baystatebam.com/upcoming-events/holiday-brain-break-open-play').hostname, 'www.baystatebam.com');
  for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x', 'http://10.0.0.5/x', 'http://printer.local/x', 'http://intranet/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'not a url']) {
    assert.throws(() => checkPublicUrl(bad), /./, bad);
  }
});

test('reads a page as text with its title and event data, dropping scripts', async () => {
  const html = `<html><head><title>Holiday Brain Break</title>
    <script type="application/ld+json">{"@type":"Event","name":"Holiday Brain Break","startDate":"2026-12-20T13:00"}</script>
    <script>alert(1)</script></head><body><h1>Open play</h1><p>Sunday Dec 20, 1 to 5pm</p></body></html>`;
  const r = await readLink('https://example.com/e', page(html));
  assert.equal(r.title, 'Holiday Brain Break');
  assert.match(r.text, /Sunday Dec 20, 1 to 5pm/); assert.doesNotMatch(r.text, /alert/);
  assert.match(r.structured_event_data[0], /2026-12-20T13:00/);
});

test('says why a page cannot be read', async () => {
  for (const [f, re] of [
    [page('x', 'text/html', 403), /login|blocks/],
    [page('x', 'text/html', 404), /not found/],
    [page('x', 'text/html', 500), /error \(500\)/],
    [page('%PDF', 'application/pdf'), /not a web page/],
    [page('<html><body><script>app()</script></body></html>'), /no readable text/],
    [async () => { throw new Error('boom'); }, /could not reach/],
  ]) await assert.rejects(readLink('https://example.com/x', f), re);
});

test('redirects are followed but re-checked, and capped', async () => {
  const seen = [];
  const hop = async (url) => { seen.push(url); return url.endsWith('/a')
    ? new Response(null, { status: 302, headers: { location: '/b' } }) : new Response('<p>Landed</p>', { headers: { 'content-type': 'text/html' } }); };
  assert.match((await readLink('https://example.com/a', hop)).text, /Landed/);
  assert.deepEqual(seen, ['https://example.com/a', 'https://example.com/b']);
  await assert.rejects(readLink('https://example.com/x', page('', 'text/html', 302, { location: 'http://169.254.169.254/' })), /IP address/);
  await assert.rejects(readLink('https://example.com/x', page('', 'text/html', 302, { location: '/x' })), /too many times/);
});

test('long pages are cut to a size the model can use', async () => {
  const r = await readLink('https://example.com/x', page('<p>' + 'word '.repeat(5000) + '</p>'));
  assert.equal(r.truncated, true); assert.ok(r.text.length <= 8000);
});

test('agent opens a pasted link, and a failed link comes back as an error the agent can explain', async () => {
  const store = new MemoryStore();
  const run = async (fetchPage, script) => {
    const claude = fakeClaude(script);
    const agent = new Agent({ store, claude, actor: 'alex@x.com', notify: async () => {}, fetchPage });
    await agent.ask('I registered for this https://example.com/e add it', []);
    return lastToolResults(claude)[0];
  };
  let tr = await run(page('<title>Brain Break</title><p>Dec 20, 1pm</p>'), [use('read_link', { url: 'https://example.com/e' }), say('Found it.')]);
  assert.match(JSON.parse(tr.content).text, /Dec 20, 1pm/); assert.ok(!tr.is_error);
  tr = await run(page('x', 'text/html', 403), [use('read_link', { url: 'https://example.com/e' }), say('Could not open it.')]);
  assert.equal(tr.is_error, true); assert.match(tr.content, /login|blocks/);
  tr = await run(page('x'), [use('read_link', { url: 'http://localhost/admin' }), say('No.')]);
  assert.equal(tr.is_error, true); assert.match(tr.content, /not a public website/);
});
