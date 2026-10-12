// Sample data so the app can be tried before Supabase is set up (open with ?demo).
// Nothing is saved; reloading starts over.

const pad = (n) => String(n).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const uid = () => Math.random().toString(36).slice(2, 9);

export function createDemoBackend() {
  const db = {
    members: [
      { id: 'a1', name: 'Alex', kind: 'adult', color: '#3F6B54', active: true },
      { id: 'a2', name: 'Jordan', kind: 'adult', color: '#8E4767', active: true },
      { id: 'k1', name: 'Mia', kind: 'kid', color: '#3B5A8A', active: true },
      { id: 'k2', name: 'Leo', kind: 'kid', color: '#A8752A', active: true },
      { id: 'k3', name: 'Ivy', kind: 'kid', color: '#2E6E75', active: true },
      { id: 'o1', name: 'Grandma Rose', kind: 'other', color: '#9A4B2E', active: true },
    ],
    tasks: [
      { id: uid(), title: 'Return field trip form', due: day(-1), for: ['k1'], note: 'Signed, with $12', done: false, source: 'email' },
      { id: uid(), title: 'Register for spring soccer', due: day(4), for: ['k2'], note: 'Opens at 9am', done: false, source: 'agent' },
      { id: uid(), title: 'Pay camp deposit', due: day(12), for: [], note: '', done: false, source: 'manual' },
    ],
    events: [
      { id: uid(), title: 'Soccer practice', date: day(0), time: '17:30', for: ['k2'], driver: 'a1', withUs: [], where: 'Riverside field', note: 'Bring water', source: 'feed' },
      { id: uid(), title: 'Book club', date: day(0), time: '18:00', for: ['a1'], driver: '', withUs: [], where: 'Maple St', note: '', source: 'manual' },
      { id: uid(), title: 'Orthodontist', date: day(1), time: '13:30', for: ['k1'], driver: '', withUs: [], where: 'Bright Smiles', note: '', source: 'email' },
      { id: uid(), title: 'No school', date: day(2), time: '', for: ['k1', 'k2', 'k3'], driver: 'none', withUs: ['k3'], where: '', note: '', source: 'feed' },
      { id: uid(), title: 'Swim lesson', date: day(2), time: '16:00', for: ['k3'], driver: 'o1', withUs: [], where: 'Y pool', note: '', source: 'manual' },
      { id: uid(), title: 'Dentist', date: day(3), time: '09:30', for: ['a2'], driver: '', withUs: [], where: '', note: '', source: 'manual' },
      ...[3, 4, 5].map((n) => ({ id: uid(), title: "Mia & Leo @Sam's", date: day(n), time: '', for: ['k1', 'k2'], driver: 'none', withUs: [], where: '', note: '', source: 'sync:Co-parent', custody: "Sam's" })),
      { id: uid(), title: 'Leo: soccer game', date: day(4), time: '10:00', for: ['k2'], driver: 'a1', withUs: [], where: 'Riverside field', note: '', source: 'manual' },
      { id: uid(), title: 'Piano recital', date: day(5), time: '15:00', for: ['k1', 'a1', 'a2'], driver: 'a2', withUs: [], where: 'Town hall', note: '', source: 'photo' },
    ],
    pending: [
      { id: uid(), title: 'Bake sale', date: day(6), time: '15:00', for: ['k2'], where: 'School gym', note: 'Bring two dozen', source: 'email', sourceRef: 'PTO news — pto@school.example', confidence: 'high' },
      { id: uid(), title: 'Picture day', date: day(8), time: '', for: [], where: '', note: '', source: 'doc', sourceRef: '', confidence: 'low' },
      { id: uid(), title: 'Order yearbook', date: day(9), time: '', for: ['k1'], where: '', note: 'Online, $35', source: 'email', sourceRef: 'Principal newsletter', confidence: 'high', kind: 'task' },
    ],
    ideas: [
      { id: uid(), title: 'Science museum night', date: day(12), time: '18:00', for: ['a1', 'a2', 'k1'], cost: '$25 each', link: '', note: '' },
      { id: uid(), title: 'Try the new ramen place', date: '', time: '', for: ['a1', 'a2'], cost: '', link: '', note: 'Jordan heard it is great' },
    ],
  };
  const settings = { morning: { enabled: true, hour: 7, email: false }, notify: ['alex@example.com'], weekly: { enabled: true, day: 'MONDAY', hour: 7 }, reminders: { enabled: true, hour: 18 }, digest: { enabled: true, hour: 19 }, timezone: 'America/New_York' };
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 120));
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const byId = (arr, id) => arr.findIndex((x) => x.id === id);
  const toEvent = (p, extra = {}) => ({ id: uid(), title: p.title, date: p.date, time: p.time || '', for: p.for || [], driver: p.driver || '', withUs: p.withUs || [], where: p.where || '', note: p.note || '', source: p.source || 'manual', ...extra });

  return {
    mode: 'demo',
    session: () => wait({ email: 'alex@example.com' }),
    signIn: () => wait(), signOut: () => wait(), isAllowed: () => wait(true),
    load: () => wait({ ...clone(db), tasks: clone(db.tasks.filter((t) => !t.done)), morning: settings.morning }),
    settings: () => wait(clone(settings)),
    saveSettings: (p) => { Object.assign(settings, p); return wait(); },
    onChange: () => () => {},
    saveMembers(ms) { db.members = ms.map((m, i) => ({ id: m.id || uid(), name: m.name, kind: m.kind, color: ['#3F6B54', '#8E4767', '#3B5A8A', '#A8752A', '#2E6E75', '#9A4B2E', '#4C5B3F', '#7A4E7E'][i % 8], active: true })); return wait(); },
    addEvent(e) { db.events.push(clone(e)); return wait(); },
    updateEvent(e) { db.events[byId(db.events, e.id)] = { ...db.events[byId(db.events, e.id)], ...clone(e) }; return wait(); },
    deleteEvent(id) { db.events.splice(byId(db.events, id), 1); return wait(); },
    restoreEvent(e, ideaId) { if (ideaId) db.ideas.splice(byId(db.ideas, ideaId), 1); db.events.push(clone(e)); return wait(); },
    eventToIdea(id, ideaId) { const [e] = db.events.splice(byId(db.events, id), 1); db.ideas.push({ id: ideaId, title: e.title, date: e.date, time: e.time, for: e.for, cost: '', link: '', note: e.note }); return wait(); },
    ideaToEvent(ideaId, eventId, date, time) { const [i] = db.ideas.splice(byId(db.ideas, ideaId), 1); db.events.push(toEvent({ ...i, date, time }, { id: eventId, source: 'shelf' })); return wait(); },
    restoreIdea(idea, eventId) { if (eventId) db.events.splice(byId(db.events, eventId), 1); db.ideas.push(clone(idea)); return wait(); },
    addIdea(it) { db.ideas.push(clone(it)); return wait(); },
    deleteIdea(id) { db.ideas.splice(byId(db.ideas, id), 1); return wait(); },
    addTask(t) { db.tasks.push({ ...clone(t), done: false, source: 'manual' }); return wait(); },
    updateTask(t) { Object.assign(db.tasks[byId(db.tasks, t.id)], clone(t)); return wait(); },
    setTaskDone(id, done) { db.tasks[byId(db.tasks, id)].done = done; return wait(); },
    rateEvent() { return wait(); },
    reminders: () => wait([{ id: 'r1', title: 'Trash & recycling', note: '', days: [5], hour: 7, every_weeks: 1, holiday: 'shift' }]),
    deleteReminder: () => wait(),
    deleteTask(id) { db.tasks.splice(byId(db.tasks, id), 1); return wait(); },
    restoreTask(t) { const i = byId(db.tasks, t.id); if (i > -1) db.tasks[i] = { ...clone(t), done: false }; else db.tasks.push({ ...clone(t), done: false }); return wait(); },
    approve(p) { if (p.kind === 'task') { db.tasks.push({ id: uid(), title: p.title, due: p.date, for: p.for || [], note: p.note || '', done: false, source: p.source || 'email' }); db.pending.splice(byId(db.pending, p.id), 1); return wait(); } db.events.push(toEvent(p)); db.pending.splice(byId(db.pending, p.id), 1); return wait(); },
    async approveMany(ps) { for (const p of ps) await this.approve(p); return { done: ps.length, failed: [] }; },
    shelve(p) { db.ideas.push({ id: uid(), title: p.title, date: p.date, time: p.time, for: p.for, cost: '', link: '', note: p.note }); db.pending.splice(byId(db.pending, p.id), 1); return wait(); },
    async shelveMany(ps) { for (const p of ps) await this.shelve(p); return { done: ps.length, failed: [] }; },
    reject(id) { db.pending.splice(byId(db.pending, id), 1); return wait(); },
    rejectMany(ids) { ids.forEach((id) => db.pending.splice(byId(db.pending, id), 1)); return wait({ done: ids.length, failed: [] }); },
    rejectAll() { db.pending = []; return wait(); },

    async ask(message) {
      const m = message.match(/add (?:an? )?(.+?) for (\w+)(?: on| tomorrow)?\s*(.*?)\s+at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i);
      if (m) {
        const who = db.members.find((x) => x.name.toLowerCase() === m[2].toLowerCase());
        let h = Number(m[4]); if (m[6] && m[6].toLowerCase() === 'pm' && h < 12) h += 12;
        const date = /tomorrow/i.test(message) ? day(1) : day(7);
        const e = toEvent({ title: m[1].replace(/^\w/, (c) => c.toUpperCase()), date, time: `${pad(h)}:${m[5] || '00'}`, for: who ? [who.id] : [] }, { source: 'agent' });
        db.events.push(e);
        const kid = who && who.kind === 'kid';
        const when = new Date(`${e.date}T${e.time}`).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return wait({ reply: `Added ${e.title} for ${who ? who.name : 'nobody yet'}, ${when}.${kid ? ` Who is taking ${who.name}?` : ''} (Demo: in the real app Claude understands any wording.)`, pending: null, changed: true });
      }
      if (/delete|remove|cancel/i.test(message)) {
        const e = db.events[0];
        return wait({ reply: `In the real app I would hold that until you tap Confirm. Here is what that looks like.`, pending: { token: 'demo', summary: `Delete ${e.title} (${e.date})?` }, changed: false });
      }
      return wait({ reply: 'This is demo mode, so I only understand "add … for … at …" and "delete …". Once Supabase is connected, Claude answers anything about your calendar.', pending: null, changed: false });
    },
    confirm: () => wait({ reply: 'Demo mode: nothing was deleted.', changed: false }),
    cancelConfirm: () => wait({ reply: 'Okay, cancelled. Nothing was changed.', changed: false }),
    hasSiriKey: () => wait(false),
    createSiriKey: () => wait('hh_' + 'demo'.repeat(16)),
    revokeSiriKey: () => wait(),
    myPendingConfirmations: () => wait([]),
    pushKey: () => wait({ publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' }),
    testPush: () => wait({ sent: 1, gone: 0, failed: 0 }),
    savePush: () => wait(), removePush: () => wait(),
    agentUrl: 'https://your-project.supabase.co/functions/v1/agent',
    extractText: () => { db.pending.push({ id: uid(), title: 'Field trip forms due', date: day(4), time: '', for: ['k1'], where: '', note: 'Demo result', source: 'text', sourceRef: '', confidence: 'low' }); return wait({ found: 1, added: 1, past: 0, dupe: 0, parsed: false }); },
    extractFile: () => wait({ found: 0, added: 0, past: 0, dupe: 0, parsed: false }),
    checkFeeds: () => wait({ report: ['Demo mode: no feeds to check.'] }),
    sendTest: () => wait({ sent: [] }),
    testSms: () => wait({ ok: true, results: [{ name: 'Alex', ok: true }], enabled: true }),
  };
}
