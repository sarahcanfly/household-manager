import test from 'node:test';
import assert from 'node:assert/strict';
const { stripThinking } = await import('../../.build/supabase/functions/_shared/claude.js');

test('stripThinking removes thinking blocks from assistant turns and keeps everything else', () => {
  const messages = [
    { role: 'user', content: 'add a nail appointment' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hmm', signature: 'abc' },
      { type: 'redacted_thinking', data: 'xyz' },
      { type: 'text', text: 'Adding it.' },
      { type: 'tool_use', id: 't1', name: 'add_event', input: {} },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
  ];
  const out = stripThinking(messages);
  assert.deepEqual(out[1].content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(out.length, 3);
  assert.equal(messages[1].content.length, 4, 'does not mutate the input');
});

test('stripThinking drops assistant turns that were only thinking, and leaves string content alone', () => {
  const out = stripThinking([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'assistant', content: 'plain text' },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'plain text' }]);
});
