// A small client for Supabase's REST API, used with the service key.
// No external packages: plain fetch.

import { env, must } from './env.ts';

export class Rest {
  constructor(private url: string, private key: string) {}

  private headers(prefer?: string): Record<string, string> {
    const h: Record<string, string> = { apikey: this.key, 'Content-Type': 'application/json' };
    // Legacy service keys are JWTs and go in Authorization too; new sb_secret_ keys go only in apikey.
    if (this.key.startsWith('eyJ')) h.Authorization = `Bearer ${this.key}`;
    if (prefer) h.Prefer = prefer;
    return h;
  }

  async req<T = unknown>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method, headers: this.headers(prefer), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Database ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  select<T = Record<string, unknown>>(table: string, query = 'select=*') { return this.req<T[]>('GET', `${table}?${query}`); }
  insert<T = Record<string, unknown>>(table: string, rows: unknown) { return this.req<T[]>('POST', table, rows, 'return=representation'); }
  update<T = Record<string, unknown>>(table: string, filter: string, patch: unknown) { return this.req<T[]>('PATCH', `${table}?${filter}`, patch, 'return=representation'); }
  remove<T = Record<string, unknown>>(table: string, filter: string) { return this.req<T[]>('DELETE', `${table}?${filter}`, undefined, 'return=representation'); }
  upsert(table: string, rows: unknown, onConflict: string) { return this.req('POST', `${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=minimal'); }
  rpc<T = unknown>(fn: string, args: Record<string, unknown>) { return this.req<T>('POST', `rpc/${fn}`, args); }
}

export const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

export function serviceKey(): string {
  return env('HM_SERVICE_KEY') || must('SUPABASE_SERVICE_ROLE_KEY');
}

export function serviceDb(): Rest {
  return new Rest(must('SUPABASE_URL'), serviceKey());
}
