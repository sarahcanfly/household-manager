// Secrets and settings come from the function environment (Supabase secrets).
// Works under Deno in production and Node in tests.

type EnvSource = { get(k: string): string | undefined };
const g = globalThis as unknown as { Deno?: { env: EnvSource }; process?: { env: Record<string, string | undefined> } };

/** Trimmed, because a stray space or line break pasted into a secret is easy to miss. */
export function env(key: string, fallback = ''): string {
  const v = (g.Deno?.env.get(key) ?? g.process?.env[key] ?? '').trim();
  return v || fallback;
}

export function must(key: string): string {
  const v = env(key);
  if (!v) throw new Error(`Missing secret ${key}. Add it in Supabase → Edge Functions → Secrets.`);
  return v;
}

/** Comparison that takes the same time whether or not the first characters match. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
