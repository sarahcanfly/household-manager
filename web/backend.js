// Talks to Supabase. Every read and write goes through the database's security
// rules, so this file never decides who may see what.

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const hm = (t) => (t ? String(t).slice(0, 5) : '');
const toEvent = (r) => ({ id: r.id, title: r.title, date: r.date, time: hm(r.time), for: r.for_ids || [], driver: r.driver || '', withUs: r.with_us || [], where: r.place || '', note: r.note || '', source: r.source || '' });
const toPending = (r) => ({ id: r.id, title: r.title, date: r.date, time: hm(r.time), for: r.for_ids || [], where: r.place || '', note: r.note || '', source: r.source, sourceRef: r.source_ref || '', confidence: r.confidence });
const toIdea = (r) => ({ id: r.id, title: r.title, date: r.date || '', time: hm(r.time), for: r.for_ids || [], cost: r.cost || '', link: r.link || '', note: r.note || '' });
const eventRow = (e) => ({ title: e.title, date: e.date, time: e.time || null, for_ids: e.for || [], driver: e.driver || null, with_us: e.withUs || [], place: e.where || '', note: e.note || '' });
const pendingPayload = (p) => ({ id: p.id, title: p.title, date: p.date, time: p.time || '', for_ids: p.for || [], driver: p.driver || '', with_us: p.withUs || [], place: p.where || '', note: p.note || '' });
const ideaJson = (i) => ({ id: i.id, title: i.title, date: i.date || '', time: i.time || '', for_ids: i.for || [], cost: i.cost || '', link: i.link || '', note: i.note || '' });
const eventJson = (e) => ({ id: e.id, ...eventRow(e), time: e.time || '', driver: e.driver || '', source: e.source || 'manual' });

export async function createLiveBackend(cfg) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  async function fn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) { /* keep the generic message */ }
      throw new Error(msg);
    }
    return data;
  }

  return {
    mode: 'live',
    async session() { const { data } = await sb.auth.getSession(); return data.session ? { email: data.session.user.email } : null; },
    async signIn(email, password) { ok(await sb.auth.signInWithPassword({ email, password })); },
    async signOut() { await sb.auth.signOut(); },
    async isAllowed() { return !!ok(await sb.rpc('am_i_household')); },

    async load() {
      const [m, e, p, i] = await Promise.all([
        sb.from('members').select('*').order('sort'),
        sb.from('events').select('*').order('date').order('time', { nullsFirst: true }),
        sb.from('pending').select('*').order('date'),
        sb.from('ideas').select('*').order('created_at'),
      ]);
      return { members: ok(m), events: ok(e).map(toEvent), pending: ok(p).map(toPending), ideas: ok(i).map(toIdea) };
    },
    async settings() {
      const rows = ok(await sb.from('settings').select('key,value'));
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async saveSettings(patch) {
      ok(await sb.from('settings').upsert(Object.entries(patch).map(([key, value]) => ({ key, value }))));
    },

    onChange(cb) {
      let t = null;
      const fire = () => { clearTimeout(t); t = setTimeout(cb, 400); };
      const ch = sb.channel('household');
      for (const table of ['events', 'pending', 'ideas', 'members']) ch.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
      ch.subscribe();
      return () => sb.removeChannel(ch);
    },

    async saveMembers(ms) { ok(await sb.rpc('save_members', { ms: ms.map((m) => ({ id: m.id || '', name: m.name, kind: m.kind })) })); },
    async addEvent(e) { ok(await sb.from('events').insert({ id: e.id, ...eventRow(e), source: e.source || 'manual' })); },
    async updateEvent(e) { ok(await sb.from('events').update(eventRow(e)).eq('id', e.id)); },
    async deleteEvent(id) { ok(await sb.from('events').delete().eq('id', id)); },
    async restoreEvent(e, removeIdea) { ok(await sb.rpc('restore_event', { ev: eventJson(e), remove_idea: removeIdea || null })); },
    async eventToIdea(id, ideaId) { ok(await sb.rpc('event_to_idea', { event_id: id, idea_id: ideaId })); },
    async ideaToEvent(ideaId, eventId, date, time) { ok(await sb.rpc('idea_to_event', { idea_id: ideaId, event_id: eventId, d: date, t: time || '' })); },
    async restoreIdea(idea, removeEvent) { ok(await sb.rpc('restore_idea', { it: ideaJson(idea), remove_event: removeEvent || null })); },
    async addIdea(it) { ok(await sb.from('ideas').insert({ id: it.id, title: it.title, date: it.date || null, time: it.time || null, for_ids: it.for || [], cost: it.cost || '', link: it.link || '', note: it.note || '' })); },
    async deleteIdea(id) { ok(await sb.from('ideas').delete().eq('id', id)); },
    async approve(p) { ok(await sb.rpc('approve_pending', { p: pendingPayload(p) })); },
    async approveMany(ps) { return ok(await sb.rpc('approve_many', { ps: ps.map(pendingPayload) })); },
    async shelve(p) { ok(await sb.rpc('shelve_pending', { p: pendingPayload(p) })); },
    async shelveMany(ps) { return ok(await sb.rpc('shelve_many', { ps: ps.map(pendingPayload) })); },
    async reject(id) { ok(await sb.from('pending').delete().eq('id', id)); },
    async rejectMany(ids) { const r = ok(await sb.from('pending').delete().in('id', ids).select('id')); return { done: r.length, failed: [] }; },
    async rejectAll() { ok(await sb.from('pending').delete().neq('id', '')); },

    ask: (message, history) => fn('agent', { action: 'ask', message, history }),
    confirm: (token) => fn('agent', { action: 'confirm', token }),
    extractText: (text) => fn('intake', { kind: 'text', text }),
    extractFile: (base64, mediaType) => fn('intake', { kind: 'file', base64, media_type: mediaType }),
    checkFeeds: () => fn('poll', {}),
    sendTest: (kind) => fn('notify', { send: kind }),
  };
}
