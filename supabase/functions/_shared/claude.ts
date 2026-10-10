import { env, must } from './env.ts';

export interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; [k: string]: unknown }
export interface ClaudeReply { content: Block[]; stop_reason: string }
export type ClaudeFn = (payload: Record<string, unknown>) => Promise<ClaudeReply>;

export const model = () => env('CLAUDE_MODEL', 'claude-sonnet-5-5');

export const callClaude: ClaudeFn = async (payload) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': must('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model(), max_tokens: 1500, ...payload }),
  });
  if (res.status === 401) throw new Error('The Claude API key was rejected. Check ANTHROPIC_API_KEY.');
  if (res.status === 429) throw new Error('Too many requests to Claude right now. Wait a minute and try again.');
  if (!res.ok) throw new Error(`Claude returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json() as ClaudeReply;
};

export const textOf = (content: Block[]) =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
