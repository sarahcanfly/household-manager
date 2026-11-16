import { env, must } from './env.ts';

export interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; [k: string]: unknown }
export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
export interface ClaudeReply { content: Block[]; stop_reason: string; usage?: ClaudeUsage; model?: string }
export type ClaudeFn = (payload: Record<string, unknown>) => Promise<ClaudeReply>;

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/** Extraction is a classification task. Haiku is priced for that; Sonnet stays the default for Ask. */
export const DEFAULT_FAST_MODEL = 'claude-haiku-5-5';

export const model = () => env('CLAUDE_MODEL', DEFAULT_MODEL);
export const fastModel = () => env('CLAUDE_MODEL_FAST', DEFAULT_FAST_MODEL);

/** One usage line, with no prompt text. Function logs are how spend gets checked. */
export function usageRecord(modelName: string, data: { stop_reason?: string; usage?: ClaudeUsage | null }): Record<string, string | number> {
  const u = data.usage ?? {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    msg: 'claude_usage',
    model: modelName,
    stop: data.stop_reason ?? '',
    input_tokens: n(u.input_tokens),
    output_tokens: n(u.output_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
  };
}

/**
 * Shared shape for reading text, photos and documents. Thinking is off so the
 * token budget is spent on the JSON, not on a reasoning trace that was cutting
 * the reply off. The fast model has to be one that accepts `thinking: disabled`
 * at low effort (Haiku 5.5 does).
 */
export function extractionPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: fastModel(),
    max_tokens: 3000,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    ...extra,
  };
}

/**
 * Drop `thinking` / `redacted_thinking` blocks from earlier assistant turns before they are sent back.
 * Their signatures are tied to the exact request that produced them, and the API answers 400
 * ("Invalid `signature` in `thinking` block") when they are replayed in a different shape.
 * Ask leaves thinking at the model default. Extraction turns it off. Assistant turns left empty are dropped.
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

const OPTIONAL_FIELDS = ['thinking', 'output_config', 'cache_control'] as const;

function requestBody(payload: Record<string, unknown>): Record<string, unknown> {
  const messages = 'messages' in payload ? stripThinking(payload.messages) : undefined;
  const requested = typeof payload.model === 'string' && payload.model ? payload.model : model();
  return { max_tokens: 1500, ...payload, ...(messages ? { messages } : {}), model: requested };
}

async function postClaude(payload: Record<string, unknown>, allowFallback: boolean): Promise<ClaudeReply> {
  const body = requestBody(payload);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': must('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('The Claude API key was rejected. Check ANTHROPIC_API_KEY.');
  if (res.status === 429) throw new Error('Too many requests to Claude right now. Wait a minute and try again.');
  if (res.status === 400 && allowFallback && OPTIONAL_FIELDS.some((k) => k in payload)) {
    const detail = (await res.text()).slice(0, 300);
    // An older API shape rejects the cost-control fields. Retry once without them
    // so a read still happens; the log line says the saving did not apply.
    if (/thinking|output_config|cache_control|effort/i.test(detail)) {
      console.log(JSON.stringify({ msg: 'claude_optional_fields_rejected', error: detail.slice(0, 180) }));
      const plain: Record<string, unknown> = { ...payload };
      for (const k of OPTIONAL_FIELDS) delete plain[k];
      return await postClaude(plain, false);
    }
    throw new Error(`Claude returned 400: ${detail.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`Claude returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json() as ClaudeReply;
  console.log(JSON.stringify(usageRecord(typeof data.model === 'string' && data.model ? data.model : String(body.model), data)));
  return data;
}

export const callClaude: ClaudeFn = (payload) => postClaude(payload, true);

export const textOf = (content: Block[]) =>
  content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
