import { env, must } from './env.ts';

export interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; [k: string]: unknown }
export interface ClaudeReply { content: Block[]; stop_reason: string }
export type ClaudeFn = (payload: Record<string, unknown>) => Promise<ClaudeReply>;

export const model = () => env('CLAUDE_MODEL', 'claude-sonnet-5-5');

/**
 * Drop `thinking` / `redacted_thinking` blocks from earlier assistant turns before they are sent back.
 * Their signatures are tied to the exact request that produced them, and the API answers 400
 * ("Invalid `signature` in `thinking` block") when they are replayed in a different shape. We never
 * turn extended thinking on ourselves, so nothing depends on them. Assistant turns left empty are dropped.
 */
export function stripThinking(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  const out: unknown[] = [];
  for (const m of messages as { role?: string; content?: unknown }[]) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      const content = (m.content as Block[]).filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
      if (!content.length) continue;
      out.push({ ...m, content });
    } else out.push(m);
  }
  return out;
}

export const callClaude: ClaudeFn = async (payload) => {
  const body = 'messages' in payload ? { ...payload, messages: stripThinking(payload.messages) } : payload;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': must('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model(), max_tokens: 1500, ...body }),
  });
  if (res.status === 401) throw new Error('The Claude API key was rejected. Check ANTHROPIC_API_KEY.');
  if (res.status === 429) throw new Error('Too many requests to Claude right now. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Claude returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json() as ClaudeReply;
};

export const textOf = (content: Block[]) =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
