// Household Manager — the phone app. Plain JavaScript, no build step.
// Screens: Week, Month, Shelf, Inbox, Ask, plus the Household sheet.

import { createDemoBackend } from './demo.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULLMONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FALLBACK = '#5C6763';
const PALETTE = ['#3F6B54', '#8E4767', '#3B5A8A', '#A8752A', '#2E6E75', '#9A4B2E', '#4C5B3F', '#7A4E7E'];
const THEMES = [
  { id: 'morning', name: 'Morning paper', hint: 'Newspaper, but friendly', bg: '#FDFDFB' },
  { id: 'paper', name: 'Paper', hint: 'Sage and oat', bg: '#EDEFE8' },
  { id: 'linen', name: 'Linen', hint: 'Warm cream', bg: '#F2ECE1' },
  { id: 'night', name: 'Night', hint: 'Dark', bg: '#141917' },
  { id: 'ink', name: 'Ink', hint: 'Cool, no serif', bg: '#EDF0F4' },
];

const root = document.getElementById('root');
let api = null, me = null;
let state = null, view = 'week', weekOffset = 0, monthOffset = 0, filterId = '';
let sheet = null, addKind = 'event', schedulingId = null, flashId = null;
let undo = null, busy = false, errMsg = '', info = '', settings = null;
let tasksOpen = false;
let draft = null, memberDraft = null, setupDraft = null, settingsDraft = null;
let intakeMode = 'text', intakeText = '', fileData = '', fileType = '', filePreview = '', fileName = '';
let parsing = false, parseNote = '', edits = {}, picked = {};
let askText = '', askLog = [], askBusy = false, waiting = [], listening = false, recognizer = null;
let siri = null;   // { has: bool, key?: string } while the Household sheet is open
let pushState = '';   // '', 'unsupported', 'install', 'blocked', 'off', 'on' (this phone)
let gate = null, gateErr = '', offline = !navigator.onLine;
let theme = readTheme();

/* ---------- small helpers ---------- */

function readTheme() { try { return localStorage.getItem('hm:theme') || 'morning'; } catch (_) { return 'morning'; } }
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', (THEMES.find((x) => x.id === t) || THEMES[0]).bg);
  try { localStorage.setItem('hm:theme', t); } catch (_) { /* private mode */ }
}
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
const todayStr = () => ymd(new Date());
function pretty(t, short) {
  if (!t) return '';
  const p = t.split(':'); let h = +p[0];
  const ap = h >= 12 ? (short ? 'p' : 'pm') : (short ? 'a' : 'am');
  h = h % 12 || 12;
  return h + (p[1] === '00' ? '' : ':' + p[1]) + ap;
}
/** "3pm", or "3–4:30pm" when there is an end time. */
function span(e, short) {
  if (!e.time) return '';
  if (!e.end || e.end <= e.time) return pretty(e.time, short);
  const a = pretty(e.time, short), b = pretty(e.end, short), n = short ? 1 : 2;
  return a.slice(-n) === b.slice(-n) ? `${a.slice(0, -n)}–${b}` : `${a}–${b}`;
}
const longDate = (key) => { const d = parseYmd(key); return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

const member = (id) => state.members.find((m) => m.id === id) || null;
const roster = () => state.members.filter((m) => m.active);
const colorOf = (id) => { const m = member(id); return m ? (m.color || FALLBACK) : FALLBACK; };
const adults = () => roster().filter((m) => m.kind === 'adult');
const household = () => roster().filter((m) => m.kind !== 'other');
const kids = () => roster().filter((m) => m.kind === 'kid');
const drivers = () => roster().filter((m) => m.kind !== 'kid');
const hasKid = (ids) => ids.some((id) => { const m = member(id); return m && m.kind === 'kid'; });
function names(ids) {
  const order = {}; state.members.forEach((m, i) => { order[m.id] = i; });
  const ns = ids.slice().sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99)).map((id) => member(id)?.name).filter(Boolean);
  if (!ns.length) return 'Unassigned';
  if (ns.length === household().length && ns.length > 2) return 'Everyone';
  const k = kids();
  if (k.length > 1 && ns.length === k.length && k.every((m) => ids.includes(m.id))) return 'The kids';
  return ns.join(' & ');
}
function barStyle(ids) {
  const cs = ids.map(colorOf);
  if (!cs.length) return `background:${FALLBACK}`;
  if (cs.length === 1) return `background:${cs[0]}`;
  const n = cs.length;
  return `background:linear-gradient(${cs.map((c, i) => `${c} ${(i * 100) / n}% ${((i + 1) * 100) / n}%`).join(',')})`;
}
const eventById = (id) => state.events.find((e) => e.id === id) || null;
function weekStartOf(date, off) { const d = new Date(date); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay() + (off || 0) * 7); return d; }
const weekOffsetFor = (s) => Math.round((weekStartOf(parseYmd(s)) - weekStartOf(new Date())) / 604800000);
const sortedIdeas = () => state.ideas.slice().sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : 0));
const needsDriver = (e) => {
  if (!e.time || e.driver || !hasKid(e.for || []) || e.date < todayStr()) return false;
  const aw = awayKids(e);   // kids with their other parent that day don't need one of us to drive
  const ks = (e.for || []).filter((id) => member(id)?.kind === 'kid');
  return !aw || !ks.every((id) => aw.kids.includes(id));
};

/* custody days (set by the co-parent calendar sync) and to-dos */
function custodyOn(date) {
  const groups = [], away = [];
  state.events.forEach((e) => {
    if (e.date !== date || !e.custody) return;
    const gone = (e.for || []).filter((id) => !(e.withUs || []).includes(id));
    if (!gone.length) return;
    let g = groups.find((x) => x.where === e.custody);
    if (!g) { g = { kids: [], where: e.custody, ev: e }; groups.push(g); }
    gone.forEach((id) => { if (!g.kids.includes(id)) g.kids.push(id); if (!away.includes(id)) away.push(id); });
  });
  return groups.length ? { away, groups } : null;
}
/** Kids of ours booked on a day they are at the other house (their own synced events don't count). */
function awayKids(e) {
  if (!e.time || e.custody || /^sync:/.test(e.source || '')) return null;
  const c = custodyOn(e.date);
  if (!c) return null;
  for (const g of c.groups) {
    const kidsAway = (e.for || []).filter((id) => g.kids.includes(id));
    if (kidsAway.length) return { kids: kidsAway, where: g.where };
  }
  return null;
}
const openTasks = () => (state.tasks || []).filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due));
function dueText(due) {
  const today = todayStr();
  if (due < today) return 'Overdue';
  if (due === today) return 'Due today';
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  if (due === ymd(tm)) return 'Due tomorrow';
  const d = parseYmd(due);
  return `Due ${DAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/* ---------- data ---------- */

async function reload() {
  state = await api.load();
  errMsg = '';
  await refreshWaiting();
}

async function load() {
  try { await reload(); } catch (err) { errMsg = err.message; }
  render();
}

/** Every write: do it, then re-read everything. Two phones editing at once is normal. */
async function mutate(fn, after) {
  if (busy) return;
  busy = true; errMsg = ''; render();
  try {
    await fn();
    await reload();
    if (after) after();
  } catch (err) {
    errMsg = err.message;
    try { await reload(); } catch (_) { /* keep the old copy */ }
  }
  busy = false; render();
}

function showUndo(msg, fn) {
  undo = { msg, fn };
  const mine = undo;
  setTimeout(() => { if (undo === mine) { undo = null; render(); } }, 6000);
}

/* ---------- render ---------- */

function render() {
  if (gate) { renderGate(); return; }
  if (!state) { root.innerHTML = '<p class="note" style="padding-top:30vh;text-align:center">Loading…</p>'; return; }
  if (!roster().length) { renderSetup(); return; }

  const title = adults().map((m) => m.name).join(' & ') || 'Our household';
  const tab = (v, label) => `<button class="tab" role="tab" aria-selected="${view === v}" data-act="view" data-v="${v}">${label}</button>`;
  const pickedCount = Object.keys(picked).filter((k) => picked[k]).length;

  root.innerHTML = ''
    + `<div class="top"><h1 class="house">${esc(title)}</h1>`
    + `<div class="dateline"><span>${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>`
    + `<span>${state.events.filter((e) => e.date === todayStr() && !e.custody).length || 'Nothing'} on today${state.pending.length ? `, ${state.pending.length} waiting` : ''}</span></div><div class="topbtns">`
    + `<button class="linkish" data-act="household">Household</button>`
    + `<button class="linkish" data-act="refresh">${busy ? 'Saving…' : 'Refresh'}</button></div></div>`
    + (api.mode === 'demo' ? '<div class="banner">Demo with sample data. Nothing is saved.</div>' : '')
    + (offline ? '<div class="banner">You are offline. Changes will fail until you reconnect.</div>' : '')
    + '<div class="tabs" role="tablist">'
    + tab('week', 'Week') + tab('month', 'Month')
    + tab('shelf', `Shelf<span class="count">${state.ideas.length}</span>`)
    + tab('inbox', `Inbox${state.pending.length ? `<span class="count">${state.pending.length}</span>` : ''}`)
    + tab('ask', `Ask${waiting.length ? `<span class="count">${waiting.length}</span>` : ''}`)
    + '</div>'
    + (view === 'week' ? weekHtml() : view === 'month' ? monthHtml() : view === 'shelf' ? shelfHtml() : view === 'ask' ? askHtml() : inboxHtml())
    + bulkBarHtml()
    + ((view === 'inbox' && pickedCount) || view === 'ask' ? '' : '<button class="fab" data-act="open-add">+ Add</button>')
    + (sheet ? sheetHtml() : '')
    + (errMsg ? `<div class="toast" role="alert"><span>${esc(errMsg)}</span><button data-act="dismiss">Dismiss</button></div>`
      : undo ? `<div class="toast" role="status"><span>${esc(undo.msg)}</span><button data-act="undo">Undo</button></div>`
      : info ? `<div class="toast" role="status"><span>${esc(info)}</span><button data-act="dismiss">OK</button></div>` : '');

  if (flashId) { const f = root.querySelector(`[data-flash="${flashId}"]`); if (f) { f.classList.add('flash'); f.scrollIntoView({ block: 'center' }); } flashId = null; }
  const auto = root.querySelector('[data-autofocus]');
  if (auto) auto.focus();
  if (view === 'ask') { const log = root.querySelector('.asklog'); if (log) log.scrollIntoView({ block: 'end' }); }
}

function renderGate() {
  if (gate === 'signin') {
    root.innerHTML = '<div class="gate"><h1>Household</h1>'
      + '<p class="note">Sign in with the email and password set up for you in Supabase.</p>'
      + '<form data-form="signin">'
      + '<div class="field"><label for="g-email">Email</label><input type="email" id="g-email" autocomplete="username" required data-autofocus></div>'
      + '<div class="field"><label for="g-pass">Password</label><input type="password" id="g-pass" autocomplete="current-password" required></div>'
      + `<button class="primary" type="submit"${busy ? ' disabled' : ''}>${busy ? 'Signing in…' : 'Sign in'}</button>`
      + (gateErr ? `<p class="err">${esc(gateErr)}</p>` : '')
      + '</form></div>';
  } else if (gate === 'denied') {
    root.innerHTML = `<div class="gate"><h1>Not on the list</h1><p class="note">${esc(me?.email || 'This account')} is signed in but is not one of the household's allowed emails. Ask whoever set this up to add it.</p>`
      + '<button class="primary" data-act="signout">Sign out</button></div>';
  } else if (gate === 'setup') {
    root.innerHTML = '<div class="gate"><h1>Almost there</h1><p class="note">This copy of the app is not connected to a database yet. Put your Supabase address and publishable key in <strong>config.js</strong>, or open the app with <a href="?demo">?demo</a> to try it with sample data.</p></div>';
  } else {
    root.innerHTML = `<div class="gate"><h1>Cannot reach the database</h1><p class="note">${esc(gateErr)}</p><button class="primary" data-act="retry">Try again</button></div>`;
  }
  const auto = root.querySelector('[data-autofocus]');
  if (auto) auto.focus();
}

function renderSetup() {
  if (!setupDraft) setupDraft = { adults: ['', ''], kids: [''], others: [] };
  const row = (n, i, k, offset) => `<div class="mrow" style="grid-template-columns:12px 1fr"><span class="dot" style="background:${PALETTE[(offset + i) % 8]}"></span>`
    + `<input type="text" data-s${k}="${i}" value="${esc(n)}" placeholder="Name"${k === 'a' && i === 0 ? ' data-autofocus' : ''}></div>`;
  let h = '<div class="gate" style="padding-top:8vh"><h1>Who lives here?</h1>'
    + '<p class="note">Everyone who turns up on the calendar. Kids included: their appointments need a name attached and someone to drive them.</p>'
    + '<div class="subhead">Adults</div>' + setupDraft.adults.map((n, i) => row(n, i, 'a', 0)).join('')
    + '<button class="btn" data-act="setup-add" data-t="adult">Add an adult</button>'
    + '<div class="subhead">Kids</div>' + setupDraft.kids.map((n, i) => row(n, i, 'k', setupDraft.adults.length)).join('')
    + '<button class="btn" data-act="setup-add" data-t="kid">Add a kid</button>'
    + '<div class="subhead">Anyone else who drives</div><p class="note">Optional. A co-parent, a grandparent, a sitter. Their names stay off the header.</p>'
    + setupDraft.others.map((n, i) => row(n, i, 'o', setupDraft.adults.length + setupDraft.kids.length)).join('')
    + '<button class="btn" data-act="setup-add" data-t="other">Add someone</button>'
    + `<button class="primary" style="margin-top:24px" data-act="setup-done"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Set up our week'}</button>`
    + (errMsg ? `<p class="err">${esc(errMsg)}</p>` : '') + '</div>';
  root.innerHTML = h;
  const auto = root.querySelector('[data-autofocus]');
  if (auto) auto.focus();
}

function captureSetup() {
  if (!setupDraft) return;
  root.querySelectorAll('[data-sa]').forEach((el) => { setupDraft.adults[+el.dataset.sa] = el.value.trim(); });
  root.querySelectorAll('[data-sk]').forEach((el) => { setupDraft.kids[+el.dataset.sk] = el.value.trim(); });
  root.querySelectorAll('[data-so]').forEach((el) => { setupDraft.others[+el.dataset.so] = el.value.trim(); });
}

function filterHtml() {
  let h = `<div class="filters"><button class="fchip" data-act="filter" data-id="" aria-pressed="${filterId === ''}">Everyone</button>`;
  roster().forEach((m) => {
    h += `<button class="fchip" data-act="filter" data-id="${m.id}" aria-pressed="${filterId === m.id}"><span class="dot" style="background:${colorOf(m.id)}"></span>${esc(m.name)}</button>`;
  });
  return h + '</div>';
}

const visible = (e) => !filterId || (e.for || []).includes(filterId) || e.driver === filterId;

function metaPieces(e) {
  const out = [`<span>${esc(names(e.for || []))}</span>`];
  if (e.driver && e.driver !== 'none') { const dm = member(e.driver); if (dm) out.push(`<span class="drive">${esc(dm.name)} driving</span>`); }
  else if (needsDriver(e)) out.push('<span class="drive missing">No driver yet</span>');
  if ((e.withUs || []).length) out.push(`<span class="drive">${esc(names(e.withUs))} with us</span>`);
  const aw = awayKids(e);
  if (aw) out.push(`<span>${esc(names(aw.kids))} at ${esc(aw.where)}</span>`);
  if (e.where) out.push(`<span>${esc(e.where)}</span>`);
  return out.join('');
}

function weekHtml() {
  const start = weekStartOf(new Date(), weekOffset);
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const range = `${MONTHS[start.getMonth()]} ${start.getDate()} – ${start.getMonth() === end.getMonth() ? '' : MONTHS[end.getMonth()] + ' '}${end.getDate()}`;
  const today = todayStr();
  let body = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const key = ymd(d);
    const evs = state.events.filter((e) => e.date === key && !e.custody && visible(e)).sort((x, y) => (x.time || '00:00').localeCompare(y.time || '00:00'));
    const cust = custodyOn(key);
    const custGroups = cust ? cust.groups.filter((g) => !filterId || g.kids.includes(filterId)) : [];
    const showCust = custGroups.length > 0;
    body += `<section class="day${key === today ? ' is-today' : ''}${key < today ? ' is-past' : ''}${evs.length || showCust ? '' : ' empty'}" aria-label="${DAYS[d.getDay()]} ${d.getDate()}">`
      + `<div class="dayhead"><span class="dnum">${d.getDate()}</span><span class="dname">${key === today ? 'Today' : DAYS[d.getDay()].slice(0, 3)}</span></div><div class="dayevents">`;
    custGroups.forEach((g) => { body += `<button class="away" data-act="event" data-id="${g.ev.id}">${esc(names(g.kids))} at ${esc(g.where)}</button>`; });
    if (!evs.length && !showCust) body += '<div class="none">Nothing yet</div>';
    evs.forEach((e) => {
      body += `<button class="ev" data-act="event" data-id="${e.id}" data-flash="${e.id}"><span class="bar" style="${barStyle(e.for || [])}"></span>`
        + `<span class="evbody"><span class="evtop"><span class="evtime">${e.time ? span(e) : 'All day'}</span><span class="evtitle">${esc(e.title)}</span></span>`
        + `<span class="evmeta">${metaPieces(e)}</span></span></button>`;
    });
    body += '</div></section>';
  }
  return filterHtml() + tasksHtml()
    + `<div class="weekbar"><span class="range">${range}</span><span class="nav">`
    + '<button data-act="week" data-d="-1" aria-label="Previous week">‹</button>'
    + '<button data-act="week" data-d="0">Today</button>'
    + '<button data-act="week" data-d="1" aria-label="Next week">›</button></span></div>' + body;
}

function tasksHtml() {
  const all = openTasks().filter((t) => !filterId || (t.for || []).includes(filterId));
  if (!all.length) return '';
  const soon = new Date(); soon.setDate(soon.getDate() + 14);
  const cutoff = ymd(soon);
  const shown = tasksOpen ? all : all.filter((t) => t.due <= cutoff).slice(0, 5);
  const hidden = all.length - shown.length;
  return '<div class="todo"><div class="todohead">To do</div>'
    + shown.map((t) => {
      const late = t.due < todayStr();
      return `<div class="trow"><button class="tick" data-act="task-done" data-id="${t.id}" aria-label="Done: ${esc(t.title)}"${busy ? ' disabled' : ''}></button>`
        + `<button class="tbody" data-act="task" data-id="${t.id}"><span class="ttitle">${esc(t.title)}</span>`
        + `<span class="tmeta"><span class="${late ? 'drive missing' : ''}">${esc(dueText(t.due))}</span>${(t.for || []).length ? `<span>${esc(names(t.for))}</span>` : ''}</span></button></div>`;
    }).join('')
    + (hidden > 0 ? `<button class="linkish" data-act="tasks-more">${hidden} more</button>` : tasksOpen && all.length > 5 ? '<button class="linkish" data-act="tasks-more">Show fewer</button>' : '')
    + '</div>';
}

function monthHtml() {
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + monthOffset);
  const y = base.getFullYear(), m = base.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const daysIn = new Date(y, m + 1, 0).getDate(), startDow = new Date(y, m, 1).getDay(), today = todayStr();
  const label = `${FULLMONTHS[m]} ${y}`;
  const byDay = {};
  state.events.forEach((e) => { if (String(e.date).slice(0, 7) === prefix && !e.custody && visible(e)) (byDay[e.date] = byDay[e.date] || []).push(e); });
  Object.values(byDay).forEach((l) => l.sort((a, b) => (a.time || '00:00').localeCompare(b.time || '00:00')));

  let grid = '<div class="mgrid">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="mdow">${d}</div>`).join('');
  const total = Math.ceil((startDow + daysIn) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const dn = i - startDow + 1;
    if (dn < 1 || dn > daysIn) { grid += '<div class="mcell off"></div>'; continue; }
    const key = `${prefix}-${String(dn).padStart(2, '0')}`, evs = byDay[key] || [];
    const mc = custodyOn(key);
    grid += `<div class="mcell${key === today ? ' now' : ''}${mc ? ' isaway' : ''}"><div class="mnum">${dn}</div>`
      + (mc ? mc.groups.map((g) => `<div class="mcust">${esc(g.where)}</div>`).join('') : '')
      + evs.slice(0, 3).map((e) => `<div class="mev"><span class="dot" style="${barStyle(e.for || [])}"></span><span>${e.time ? span(e, true) + ' ' : ''}${esc(e.title)}</span></div>`).join('')
      + (evs.length > 3 ? `<div class="mmore">+${evs.length - 3} more</div>` : '') + '</div>';
  }
  grid += '</div>';

  const keys = Object.keys(byDay).sort();
  let list = '<div class="plist">';
  if (!keys.length) list += '<p class="none">Nothing scheduled this month.</p>';
  keys.forEach((k) => {
    const d = parseYmd(k);
    list += `<div class="pday"><div class="pdate">${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()}</div><div>`
      + byDay[k].map((e) => {
        const dm = e.driver && e.driver !== 'none' ? member(e.driver) : null;
        const tail = [names(e.for || []), dm ? `${dm.name} driving` : '', e.where].filter(Boolean).join(', ');
        return `<div class="pev"><span class="dot" style="${barStyle(e.for || [])}"></span><span><span class="ptime">${e.time ? span(e, true) : 'all day'}</span> ${esc(e.title)} <span class="pwho">${esc(tail)}</span></span></div>`;
      }).join('') + '</div></div>';
  });
  list += '</div>';

  const maybes = sortedIdeas().filter((it) => it.date && it.date.slice(0, 7) === prefix && (!filterId || (it.for || []).includes(filterId)));
  const maybeBlock = maybes.length ? '<div class="slist"><div class="shead">Maybe, on the shelf</div>'
    + maybes.map((it) => `<div class="pev"><span class="dot" style="${barStyle(it.for || [])}"></span><span><span class="ptime">${esc(longDate(it.date))}${it.time ? ' ' + pretty(it.time, true) : ''}</span> ${esc(it.title)} <span class="pwho">${esc([names(it.for || []), it.cost].filter(Boolean).join(', '))}</span></span></div>`).join('')
    + '</div>' : '';

  return filterHtml()
    + `<div class="printonly"><strong>${esc(label)}</strong>${filterId ? ' — ' + esc(names([filterId])) : ''}</div>`
    + `<div class="mhead"><span class="mtitle">${label}</span><span class="nav">`
    + '<button data-act="month" data-d="-1" aria-label="Previous month">‹</button>'
    + '<button data-act="month" data-d="0">Today</button>'
    + '<button data-act="month" data-d="1" aria-label="Next month">›</button>'
    + '<button data-act="print">Print</button></span></div>' + grid + list + maybeBlock;
}

function shelfHtml() {
  if (!state.ideas.length) return '<p class="note" style="margin-top:16px">The shelf is empty. Park things here as you hear about them: a show, a camp, a restaurant someone recommended. Nothing needs a date yet.</p>';
  return '<p class="note" style="margin-top:12px">Things you might do. A date here means "maybe that day". It stays off the calendar until you schedule it.</p>'
    + sortedIdeas().map((it) => `<div class="card"><div class="cardtitle">${esc(it.title)}</div>`
      + (it.date ? `<div class="cardwhen">${esc(longDate(it.date))}${it.time ? ', ' + pretty(it.time) : ''}</div>` : '')
      + `<div class="cardmeta"><span>${esc(names(it.for || []))}</span>${it.cost ? `<span>${esc(it.cost)}</span>` : ''}${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">Link</a>` : ''}</div>`
      + (it.note ? `<div class="cardmeta">${esc(it.note)}</div>` : '')
      + (schedulingId === it.id
        ? `<div class="stagerow"><input type="date" id="sd" value="${esc(it.date || todayStr())}" data-autofocus aria-label="Date"><input type="time" id="st" value="${esc(it.time || '')}" aria-label="Time"></div>`
          + `<div class="row"><button class="btn go" data-act="confirm-sched" data-id="${it.id}">Add to the week</button><button class="btn" data-act="sched-cancel">Cancel</button></div>`
        : `<div class="row"><button class="btn go" data-act="sched" data-id="${it.id}">Schedule it</button><button class="btn del" data-act="drop-idea" data-id="${it.id}">Remove</button></div>`)
      + '</div>').join('');
}

/* ---------- inbox ---------- */

function inboxHtml() {
  let h = '<div class="seg">'
    + `<button data-act="mode" data-m="text" aria-pressed="${intakeMode === 'text'}">Paste text</button>`
    + `<button data-act="mode" data-m="file" aria-pressed="${intakeMode === 'file'}">Photo or PDF</button></div>`;
  if (intakeMode === 'text') {
    h += '<p class="note">An email, a newsletter, a confirmation, or a whole calendar file. Nothing is added until one of you approves it.</p>'
      + `<textarea id="etext" placeholder="Paste it here" aria-label="Text to read">${esc(intakeText)}</textarea>`;
  } else {
    h += '<p class="note">A flyer, a printed schedule, a form from a backpack. Shoot it flat and in good light; angled photos lose digits.</p>'
      + (filePreview ? `<img class="thumb" src="${filePreview}" alt="Photo to read">` : fileName ? `<p>${esc(fileName)}</p>` : '')
      + `<label class="filelabel" for="photo">${fileData ? 'Choose a different file' : 'Take a photo or choose a file'}</label>`
      + '<input type="file" id="photo" accept="image/*,application/pdf" style="display:none">';
  }
  h += `<button class="primary" data-act="parse"${parsing || busy ? ' disabled' : ''}>${parsing ? 'Reading…' : 'Find events'}</button>`;
  if (parsing) h += '<p class="thinking">Pulling out dates, times and names…</p>';
  if (parseNote) h += `<p class="note">${esc(parseNote)}</p>`;

  h += `<div class="subhead">Waiting for approval${state.pending.length ? ` (${state.pending.length})` : ''}</div>`;
  if (!state.pending.length) return h + '<p class="note">Nothing waiting. Things land here from a paste, a photo, a forwarded email, or the school calendar.</p>';

  const pickedIds = Object.keys(picked).filter((k) => picked[k]);
  h += '<p class="note">Check each one: extracted dates are often close but wrong. Edit anything before you add it.</p>'
    + `<div class="row" style="margin:0 0 10px"><button class="btn" data-act="pick-all">${pickedIds.length === state.pending.length ? 'Select none' : `Select all ${state.pending.length}`}</button></div>`;
  state.pending.forEach((p) => {
    const e = edits[p.id] || {};
    const forIds = e.for || p.for || [];
    const isPicked = !!picked[p.id];
    const isTask = p.kind === 'task';
    h += `<div class="card${isPicked ? ' picked' : ''}">`
      + `<button class="pick" data-act="pick" data-id="${p.id}" aria-pressed="${isPicked}">${isPicked ? 'Selected' : 'Select'}</button>`
      + (isTask ? '<div class="kindtag">To do</div>' : '')
      + `<input type="text" data-pe="title" data-id="${p.id}" value="${esc(e.title ?? p.title)}" aria-label="Title">`
      + (isTask
        ? `<div class="stagerow"><div><label class="label">Due</label><input type="date" data-pe="date" data-id="${p.id}" value="${esc(e.date ?? p.date)}" aria-label="Due date"></div></div>`
        : `<div class="stagerow"><input type="date" data-pe="date" data-id="${p.id}" value="${esc(e.date ?? p.date)}" aria-label="Date"><input type="time" data-pe="time" data-id="${p.id}" value="${esc(e.time ?? p.time)}" aria-label="Time"></div>`)
      + (p.where ? `<div class="cardmeta">${esc(p.where)}</div>` : '')
      + (p.note ? `<div class="cardmeta">${esc(p.note)}</div>` : '')
      + `<div class="cardmeta">${sourceLine(p)}</div>`
      + '<div class="chips" style="margin-top:10px">' + roster().map((m) => `<button class="chip" data-act="pfor" data-id="${p.id}" data-mid="${m.id}" aria-pressed="${forIds.includes(m.id)}"><span class="dot" style="background:${colorOf(m.id)}"></span>${esc(m.name)}</button>`).join('') + '</div>'
      + (hasKid(forIds) && !isTask ? driverSelectHtml(`pd-${p.id}`, e.driver || '') : '')
      + `<div class="row"><button class="btn go" data-act="approve" data-id="${p.id}"${busy ? ' disabled' : ''}>${isTask ? 'Add to to-dos' : 'Add to the week'}</button>`
      + `<button class="btn" data-act="shelve-pending" data-id="${p.id}"${busy ? ' disabled' : ''}>To the shelf</button>`
      + `<button class="btn del" data-act="reject" data-id="${p.id}"${busy ? ' disabled' : ''}>Discard</button></div></div>`;
  });
  if (state.pending.length > 1 && !pickedIds.length) h += `<button class="ghost" data-act="reject-all"${busy ? ' disabled' : ''}>Discard all ${state.pending.length}</button>`;
  return h;
}

function sourceLine(p) {
  const from = { email: 'From an email', photo: 'From a photo', pdf: 'From a PDF', doc: 'From a document', feed: 'From a calendar feed' }[p.source] || 'From pasted text';
  const flag = p.confidence === 'low' ? ', <span class="flag">worth checking</span>' : '';
  const link = /^https?:\/\//.test(p.sourceRef) ? `, <a href="${esc(p.sourceRef)}" target="_blank" rel="noopener">see the original</a>` : p.sourceRef ? `: ${esc(p.sourceRef)}` : '';
  return from + flag + link;
}

function driverSelectHtml(id, current) {
  return `<div class="field"><label for="${id}">Who is taking them</label><select id="${id}">`
    + '<option value="">Not decided</option>'
    + `<option value="none"${current === 'none' ? ' selected' : ''}>Nobody, no driving needed</option>`
    + drivers().map((m) => `<option value="${m.id}"${current === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')
    + '</select></div>';
}

function bulkBarHtml() {
  if (view !== 'inbox' || !state.pending.length) return '';
  const n = Object.keys(picked).filter((k) => picked[k]).length;
  if (!n) return '';
  return `<div class="bulkbar"><div><strong>${n} selected</strong><div class="row" style="margin-top:8px">`
    + `<button class="btn go" data-act="bulk-approve"${busy ? ' disabled' : ''}>Add to the week</button>`
    + `<button class="btn" data-act="bulk-shelve"${busy ? ' disabled' : ''}>To the shelf</button>`
    + `<button class="btn del" data-act="bulk-reject"${busy ? ' disabled' : ''}>Discard</button>`
    + '<button class="btn" data-act="pick-none">Cancel</button></div></div></div>';
}

function capturePending() {
  root.querySelectorAll('[data-pe]').forEach((el) => {
    const id = el.dataset.id;
    edits[id] = edits[id] || {};
    edits[id][el.dataset.pe] = el.value;
  });
  (state.pending || []).forEach((p) => {
    const sel = document.getElementById(`pd-${p.id}`);
    if (sel) { edits[p.id] = edits[p.id] || {}; edits[p.id].driver = sel.value; }
  });
}
function captureIntake() { const el = document.getElementById('etext'); if (el) intakeText = el.value; }

function pendingPayload(p) {
  const e = edits[p.id] || {};
  return { id: p.id, kind: p.kind, title: e.title ?? p.title, date: e.date ?? p.date, time: p.kind === 'task' ? '' : (e.time ?? p.time), for: e.for || p.for || [], driver: e.driver || '', withUs: e.withUs || [], where: p.where, note: p.note, source: p.source };
}

async function runExtraction() {
  captureIntake();
  if (intakeMode === 'text' && !intakeText.trim()) return;
  if (intakeMode === 'file' && !fileData) { errMsg = 'Choose a photo or PDF first.'; render(); return; }
  parsing = true; parseNote = ''; errMsg = ''; render();
  try {
    const r = intakeMode === 'file' ? await api.extractFile(fileData, fileType) : await api.extractText(intakeText);
    await reload();
    const how = r.parsed ? 'Read as a calendar file, so nothing was guessed. ' : '';
    if (!r.found) parseNote = 'No dated events in that. If the dates are in an attachment, paste the text itself or send the file.';
    else if (!r.added) parseNote = `Found ${r.found}, but ${r.found === 1 ? 'it was' : 'they were'} already on the calendar, already waiting, or in the past.`;
    else {
      parseNote = `${how}Found ${r.found}, added ${r.added} below to check.${r.past ? ` ${r.past} already past.` : ''}${r.dupe ? ` ${r.dupe} already known.` : ''}`;
      intakeText = ''; fileData = ''; fileType = ''; filePreview = ''; fileName = '';
    }
  } catch (err) { errMsg = err.message; }
  parsing = false; render();
}

/* ---------- ask ---------- */

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

function askHtml() {
  let h = '<div class="asklog">';
  if (!askLog.length) {
    h += '<p class="note" style="margin-top:14px">Tell me what to add or change, or ask a question. For example, "add a dentist appointment for '
      + `${esc(kids()[0]?.name || 'the kids')} on December 2 at 2pm", "who is driving Thursday?" or "when was the last orthodontist visit?"</p>`;
  }
  askLog.forEach((m) => { h += `<div class="bubble ${m.role === 'user' ? 'me' : 'them'}">${esc(m.text)}</div>`; });
  if (askBusy) h += '<p class="thinking">Working on it…</p>';
  waiting.forEach((w) => {
    h += `<div class="confirm"><div class="cardtitle">${esc(w.summary)}</div>`
      + `<div class="row"><button class="btn go" data-act="ask-confirm" data-token="${esc(w.token)}"${askBusy ? ' disabled' : ''}>Yes, do it</button>`
      + `<button class="btn" data-act="ask-cancel" data-token="${esc(w.token)}"${askBusy ? ' disabled' : ''}>Cancel</button></div></div>`;
  });
  h += '</div><div class="askbar">'
    + `<textarea id="askin" placeholder="What should I do?" aria-label="Message">${esc(askText)}</textarea>`
    + (SpeechRec ? `<button class="mic" data-act="mic" aria-pressed="${listening}" aria-label="${listening ? 'Stop listening' : 'Speak'}">${MIC}</button>` : '')
    + '</div>'
    + `<button class="primary" data-act="ask-send"${askBusy ? ' disabled' : ''}>${askBusy ? 'Working…' : 'Send'}</button>`;
  return h;
}

function captureAsk() { const el = document.getElementById('askin'); if (el) askText = el.value; }

async function runAsk() {
  captureAsk();
  const msg = askText.trim();
  if (!msg || askBusy) return;
  stopListening();
  askLog.push({ role: 'user', text: msg });
  const history = askLog.slice(-9, -1).map((m) => ({ role: m.role, content: m.text }));
  // Clear the box for good: put the keyboard away (ends phone dictation) and empty it.
  const box = document.getElementById('askin');
  if (box) { box.value = ''; box.blur(); }
  askText = ''; askBusy = true; errMsg = ''; render();
  try {
    const r = await api.ask(msg, history);
    askLog.push({ role: 'assistant', text: r.reply || 'Done.' });
    if (r.pending && !waiting.some((w) => w.token === r.pending.token)) waiting.push(r.pending);
    if (r.changed) await reload();
  } catch (err) { errMsg = err.message; }
  askBusy = false; render();
}

async function runConfirm(token, cancel) {
  if (!token || askBusy) return;
  askBusy = true; errMsg = ''; render();
  try {
    const r = cancel ? await api.cancelConfirm(token) : await api.confirm(token);
    waiting = waiting.filter((w) => w.token !== token);
    askLog.push({ role: 'assistant', text: r.reply || 'Done.' });
    if (r.changed) await reload();
  } catch (err) { errMsg = err.message; }
  askBusy = false; render();
}

/** Changes staged from Siri (or another phone) that are waiting for this person's tap. */
async function refreshWaiting() {
  if (!api || !api.myPendingConfirmations) return;
  try {
    const server = await api.myPendingConfirmations();
    const known = new Set(server.map((w) => w.token));
    waiting = [...waiting.filter((w) => known.has(w.token)), ...server.filter((w) => !waiting.some((x) => x.token === w.token))];
  } catch (_) { /* not critical */ }
}

function toggleMic() {
  if (listening) { stopListening(); render(); return; }
  captureAsk();
  recognizer = new SpeechRec();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;
  const before = askText ? askText.trim() + ' ' : '';
  const mine = recognizer;
  recognizer.onresult = (ev) => {
    if (recognizer !== mine || !listening) return;      // late words after Send are ignored
    let said = '';
    for (const r of ev.results) said += r[0].transcript;
    askText = before + said;
    const el = document.getElementById('askin');
    if (el) el.value = askText;
  };
  recognizer.onerror = (ev) => { if (ev.error !== 'aborted') errMsg = ev.error === 'not-allowed' ? 'Allow the microphone to talk instead of type.' : 'Could not hear that. Try again.'; };
  recognizer.onend = () => { listening = false; recognizer = null; render(); };
  listening = true;
  recognizer.start();
  render();
}
function stopListening() {
  listening = false;
  if (recognizer) {
    recognizer.onresult = null;                         // nothing it hears from now on reaches the box
    try { recognizer.stop(); } catch (_) { /* already stopped */ }
  }
}

/* ---------- the bottom sheet ---------- */

function chipsHtml(act, chosen, list) {
  return '<div class="chips">' + list.map((m) => `<button class="chip" data-act="${act}" data-id="${m.id}" aria-pressed="${chosen.includes(m.id)}"><span class="dot" style="background:${colorOf(m.id)}"></span>${esc(m.name)}</button>`).join('') + '</div>';
}

function driverHtml() {
  if (!hasKid(draft.for)) return '';
  return driverSelectHtml('f-driver', draft.driver);
}

function captureDraft() {
  if (!draft) return;
  ['title', 'date', 'time', 'end', 'where', 'cost', 'link', 'note'].forEach((k) => { const el = document.getElementById('f-' + k); if (el) draft[k] = el.value; });
  const dv = document.getElementById('f-driver');
  if (dv) draft.driver = dv.value;
}

function captureMembers() {
  if (!memberDraft) return;
  root.querySelectorAll('[data-mn]').forEach((el) => { const m = memberDraft[+el.dataset.mn]; if (m) m.name = el.value.trim(); });
  root.querySelectorAll('[data-mk]').forEach((el) => { const m = memberDraft[+el.dataset.mk]; if (m) m.kind = el.value; });
  if (settingsDraft) {
    const n = document.getElementById('s-notify'); if (n) settingsDraft.notify = n.value;
    ['weekly-day', 'weekly-hour', 'reminder-hour', 'digest-hour', 'morning-hour'].forEach((k) => { const el = document.getElementById('s-' + k); if (el) settingsDraft[k] = el.value; });
  }
}

function formHtml(isEdit) {
  const event = addKind === 'event';
  const seg = isEdit ? '' : '<div class="seg">'
    + `<button data-act="kind" data-k="event" aria-pressed="${event}">Calendar</button>`
    + `<button data-act="kind" data-k="task" aria-pressed="${addKind === 'task'}">To do</button>`
    + `<button data-act="kind" data-k="idea" aria-pressed="${addKind === 'idea'}">Shelf</button></div>`;
  if (addKind === 'task') {
    return `<h2>${isEdit ? 'Edit to-do' : 'Add something'}</h2>` + seg
      + `<div class="field"><label for="f-title">What needs doing</label><input type="text" id="f-title" data-autofocus value="${esc(draft.title)}" placeholder="Return permission slip, register for soccer…"></div>`
      + `<div class="field"><label for="f-date">Due</label><input type="date" id="f-date" value="${esc(draft.date || todayStr())}"></div>`
      + `<div class="field"><span class="label">Who it is for</span>${chipsHtml('for', draft.for, roster())}</div>`
      + `<div class="field"><label for="f-note">Notes</label><textarea id="f-note">${esc(draft.note)}</textarea></div>`
      + `<button class="primary" data-act="${isEdit ? 'save-task' : 'create'}"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add to to-dos'}</button>`
      + (isEdit ? `<button class="primary danger" data-act="del-task" data-id="${draft.id}"${busy ? ' disabled' : ''}>Delete</button>` : '')
      + '<button class="ghost" data-act="close">Cancel</button>';
  }
  return `<h2>${isEdit ? 'Edit' : 'Add something'}</h2>` + seg
    + `<div class="field"><label for="f-title">What is it</label><input type="text" id="f-title" data-autofocus value="${esc(draft.title)}" placeholder="${event ? 'Orthodontist, soccer practice…' : 'Something you might do'}"></div>`
    + (event
      ? `<div class="stagerow"><div><label class="label" for="f-date">Date</label><input type="date" id="f-date" value="${esc(draft.date || todayStr())}"></div>`
        + `<div><label class="label" for="f-time">Starts (blank for all day)</label><input type="time" id="f-time" value="${esc(draft.time)}"></div></div>`
        + `<div class="stagerow"><div><label class="label" for="f-end">Ends (optional)</label><input type="time" id="f-end" value="${esc(draft.end || '')}"></div><div></div></div>`
        + `<div class="field"><label for="f-where">Where</label><input type="text" id="f-where" value="${esc(draft.where)}"></div>`
      : `<div class="stagerow"><div><label class="label" for="f-date">Date (if there is one)</label><input type="date" id="f-date" value="${esc(draft.date)}"></div>`
        + `<div><label class="label" for="f-time">Time</label><input type="time" id="f-time" value="${esc(draft.time)}"></div></div>`
        + `<div class="field"><label for="f-cost">Rough cost</label><input type="text" id="f-cost" value="${esc(draft.cost)}" placeholder="$40 each, free…"></div>`
        + `<div class="field"><label for="f-link">Link</label><input type="url" id="f-link" value="${esc(draft.link)}" placeholder="https://"></div>`)
    + `<div class="field"><span class="label">Who it is for</span>${chipsHtml('for', draft.for, roster())}</div>`
    + (event ? driverHtml() + (kids().length ? `<div class="field"><span class="label">Who is with us that day</span>${chipsHtml('withus', draft.withUs || [], kids())}</div>` : '') : '')
    + `<div class="field"><label for="f-note">Notes</label><textarea id="f-note">${esc(draft.note)}</textarea></div>`
    + `<button class="primary" data-act="${isEdit ? 'save-edit' : 'create'}"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : isEdit ? 'Save changes' : event ? 'Add to the week' : 'Put it on the shelf'}</button>`
    + '<button class="ghost" data-act="close">Cancel</button>';
}

function householdHtml() {
  const s = settingsDraft;
  const hourOpts = (cur) => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${+cur === h ? ' selected' : ''}>${pretty(`${String(h).padStart(2, '0')}:00`)}</option>`).join('');
  const dayOpts = (cur) => DAYS.map((d) => `<option value="${d.toUpperCase()}"${String(cur).toUpperCase() === d.toUpperCase() ? ' selected' : ''}>${d}</option>`).join('');
  let h = '<h2>Household</h2><p class="note">Rename anyone, or add someone. <strong>Other adult</strong> is for people who turn up on the calendar without living here, like a co-parent, a grandparent or a sitter. Removing a person leaves their events alone.</p>';
  memberDraft.forEach((m, i) => {
    h += `<div class="mrow"><span class="dot" style="background:${PALETTE[i % 8]}"></span>`
      + `<input type="text" data-mn="${i}" value="${esc(m.name)}" aria-label="Name">`
      + `<select data-mk="${i}" aria-label="Kind"><option value="adult"${m.kind === 'adult' ? ' selected' : ''}>Adult</option><option value="kid"${m.kind === 'kid' ? ' selected' : ''}>Kid</option><option value="other"${m.kind === 'other' ? ' selected' : ''}>Other adult</option></select>`
      + `<button data-act="rm-member" data-i="${i}" aria-label="Remove ${esc(m.name)}">×</button></div>`;
  });
  h += '<button class="btn" data-act="add-member">Add a person</button>';
  if (s) {
    h += '<div class="subhead">Emails and reminders</div>'
      + `<div class="field"><label for="s-notify">Who gets the emails (one per line)</label><textarea id="s-notify" style="min-height:70px">${esc(s.notify)}</textarea></div>`
      + `<div class="hours"><div class="field"><label for="s-weekly-day">Weekly summary on</label><select id="s-weekly-day">${dayOpts(s['weekly-day'])}</select></div>`
      + `<div class="field"><label for="s-weekly-hour">at</label><select id="s-weekly-hour">${hourOpts(s['weekly-hour'])}</select></div>`
      + `<div class="field"><label for="s-reminder-hour">Evening-before reminder at</label><select id="s-reminder-hour">${hourOpts(s['reminder-hour'])}</select></div>`
      + `<div class="field"><label for="s-digest-hour">"Things are waiting" email at</label><select id="s-digest-hour">${hourOpts(s['digest-hour'])}</select></div>`
      + `<div class="field"><label for="s-morning-hour">Morning "today" notification</label><select id="s-morning-hour"><option value="off"${s['morning-hour'] === 'off' ? ' selected' : ''}>Off</option>${hourOpts(s['morning-hour'])}</select></div></div>`;
  }
  h += `<button class="primary" data-act="save-members"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save household'}</button>`
    + '<div class="subhead">Look</div><p class="note">Just for this phone.</p><div class="chips">'
    + THEMES.map((t) => `<button class="chip" data-act="theme" data-t="${t.id}" aria-pressed="${theme === t.id}">${esc(t.name)} <span style="opacity:.7">${esc(t.hint)}</span></button>`).join('')
    + '</div>'
    + pushHtml()
    + siriHtml()
    + '<div class="subhead">Tools</div><div class="row">'
    + `<button class="btn" data-act="check-feeds"${busy ? ' disabled' : ''}>Check the school calendar now</button>`
    + `<button class="btn" data-act="test-weekly"${busy ? ' disabled' : ''}>Email me this week's summary</button>`
    + `<button class="btn" data-act="test-sms"${busy ? ' disabled' : ''}>Send a test text</button></div>`
    + `<p class="note" style="margin-top:18px">Signed in as ${esc(me?.email || '')}.</p>`
    + '<button class="btn" data-act="signout">Sign out</button>'
    + '<button class="ghost" data-act="close">Close</button>';
  return h;
}

function pushHtml() {
  if (!pushState) return '';
  const h = '<div class="subhead">Notifications on this phone</div>';
  const dis = busy ? ' disabled' : '';
  switch (pushState) {
    case 'install':
      return h + '<p class="note">On iPhone, notifications only work from the Home Screen app. In Safari tap Share, then <b>Add to Home Screen</b>, open Household from there and come back here.</p>';
    case 'unsupported':
      return h + '<p class="note">This browser cannot show notifications from the app. Emails still arrive as usual.</p>';
    case 'blocked':
      return h + '<p class="note">Notifications are blocked for Household. Turn them on in the phone\'s <b>Settings → Notifications → Household</b>, then come back here.</p>';
    case 'on':
      return h + '<p class="note">On. The morning "today" note, the evening reminder, the weekly summary and the "things are waiting" note show up here, at the times above.</p>'
        + `<div class="row"><button class="btn" data-act="push-test"${dis}>Send a test</button><button class="btn del" data-act="push-off"${dis}>Turn off</button></div>`;
    default:
      return h + '<p class="note">Get the morning "today" note, the evening reminder and the weekly summary as notifications, like texts but from the app.</p>'
        + `<div class="row"><button class="btn go" data-act="push-on"${dis}>Turn on notifications</button></div>`;
  }
}

function siriHtml() {
  if (!siri) return '';
  let h = '<div class="subhead">Ask Household from Siri</div>';
  if (siri.key) {
    return h + '<p class="note">Your Siri key. Copy it into the Shortcut now: it will not be shown again. Treat it like a password.</p>'
      + `<div class="field"><label for="siri-key">Key</label><input type="text" id="siri-key" readonly value="${esc(siri.key)}"></div>`
      + `<div class="field"><label for="siri-url">Address</label><input type="text" id="siri-url" readonly value="${esc(api.agentUrl || '')}"></div>`
      + '<div class="row"><button class="btn go" data-act="copy" data-from="siri-key">Copy key</button><button class="btn" data-act="copy" data-from="siri-url">Copy address</button></div>'
      + '<p class="note">Then follow "Ask Household with Siri" in SETUP.md to build the Shortcut.</p>';
  }
  return h + `<p class="note">${siri.has ? 'Your Siri key is on.' : 'Lets an iPhone Shortcut send requests to the agent, so you can say "Hey Siri, Ask Household".'}</p>`
    + `<div class="row"><button class="btn${siri.has ? '' : ' go'}" data-act="siri-make"${busy ? ' disabled' : ''}>${siri.has ? 'Make a new key' : 'Make my Siri key'}</button>`
    + (siri.has ? `<button class="btn del" data-act="siri-off"${busy ? ' disabled' : ''}>Turn off</button>` : '') + '</div>';
}

function sheetHtml() {
  let inner;
  if (sheet.mode === 'household') inner = householdHtml();
  else if (sheet.mode === 'event') {
    const e = eventById(sheet.id);
    if (!e) { sheet = null; return ''; }
    const d = parseYmd(e.date);
    const dm = e.driver && e.driver !== 'none' ? member(e.driver) : null;
    const lines = [
      `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${e.time ? ', ' + span(e) : ', all day'}`,
      e.series ? 'Repeats weekly' : '',
      names(e.for || []),
      dm ? `${dm.name} driving` : e.driver === 'none' ? 'No driving needed' : needsDriver(e) ? 'No driver yet' : '',
      (e.withUs || []).length ? `${names(e.withUs)} with us` : '',
      awayKids(e) ? `${names(awayKids(e).kids)} at ${awayKids(e).where} that day` : '',
      e.where, e.note,
      /^sync:/.test(e.source || '') ? `From the ${e.source.slice(5)} calendar. Change it there; edits here are replaced on the next sync.` : '',
    ].filter(Boolean);
    inner = `<h2>${esc(e.title)}</h2><p class="note">${lines.map(esc).join('<br>')}</p>`
      + `<button class="primary" data-act="edit-event" data-id="${e.id}">Edit</button>`
      + `<button class="btn" style="width:100%;margin-top:8px;padding:12px" data-act="shelve-event" data-id="${e.id}"${busy ? ' disabled' : ''}>Move to the shelf</button>`
      + `<button class="primary danger" data-act="del-event" data-id="${e.id}"${busy ? ' disabled' : ''}>Delete</button>`
      + '<button class="ghost" data-act="close">Close</button>';
  } else inner = formHtml(sheet.mode === 'edit');
  return `<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
}

/* ---------- actions ---------- */

const newDraft = () => ({ title: '', date: todayStr(), time: '', where: '', cost: '', link: '', note: '', for: [], driver: '', withUs: [] });

/* ---------- phone notifications ---------- */

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
const deviceName = () => (isIos() ? (/iPad/.test(navigator.userAgent) ? 'iPad' : 'iPhone') : /Android/.test(navigator.userAgent) ? 'Android' : 'Browser');

async function swReady() {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
}

async function readPushState() {
  if (!api.pushKey) return 'unsupported';
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isInstalled()) return 'install';
  if (!capable) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await swReady();
  if (!reg) return 'unsupported';
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === 'granted') {
    const j = sub.toJSON();
    api.savePush(j.endpoint, j.keys.p256dh, j.keys.auth, deviceName()).catch(() => {});   // keep the server's copy current
    return 'on';
  }
  return 'off';
}

async function turnOnPush() {
  // Ask first, straight from the tap: iPhones only show the prompt for a direct tap.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { pushState = perm === 'denied' ? 'blocked' : 'off'; return; }
  const reg = await swReady();
  if (!reg) throw new Error('The app is still installing. Close it, open it again and try once more.');
  const { publicKey } = await api.pushKey();
  const opts = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let sub;
  try { sub = await reg.pushManager.subscribe(opts); }
  catch (_) { const old = await reg.pushManager.getSubscription(); if (old) await old.unsubscribe(); sub = await reg.pushManager.subscribe(opts); }
  const j = sub.toJSON();
  await api.savePush(j.endpoint, j.keys.p256dh, j.keys.auth, deviceName());
  pushState = 'on';
  try { await api.testPush(); } catch (_) { /* the switch is on either way */ }
}

async function turnOffPush() {
  const reg = await swReady();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe(); await api.removePush(endpoint); }
  pushState = 'off';
}

async function openHousehold() {
  memberDraft = roster().map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
  settingsDraft = null;
  sheet = { mode: 'household' };
  render();
  try {
    settings = await api.settings();
    settingsDraft = {
      notify: (settings.notify || []).join('\n'),
      'weekly-day': settings.weekly?.day || 'MONDAY', 'weekly-hour': settings.weekly?.hour ?? 7,
      'reminder-hour': settings.reminders?.hour ?? 18, 'digest-hour': settings.digest?.hour ?? 19,
      'morning-hour': settings.morning && settings.morning.enabled === false ? 'off' : String(settings.morning?.hour ?? 7),
    };
    if (api.hasSiriKey) siri = { has: await api.hasSiriKey() };
    try { pushState = await readPushState(); } catch (_) { pushState = 'unsupported'; }
    if (sheet && sheet.mode === 'household') render();
  } catch (err) { errMsg = err.message; render(); }
}

async function saveHousehold() {
  captureMembers();
  const ms = memberDraft.filter((m) => m.name);
  const s = settingsDraft;
  await mutate(async () => {
    await api.saveMembers(ms);
    if (s && settings) {
      await api.saveSettings({
        notify: s.notify.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean),
        weekly: { ...(settings.weekly || {}), enabled: true, day: s['weekly-day'], hour: +s['weekly-hour'] },
        reminders: { ...(settings.reminders || {}), enabled: true, hour: +s['reminder-hour'] },
        digest: { ...(settings.digest || {}), enabled: true, hour: +s['digest-hour'] },
        morning: s['morning-hour'] === 'off'
          ? { hour: 7, email: false, ...(settings.morning || {}), enabled: false }
          : { email: false, ...(settings.morning || {}), enabled: true, hour: +s['morning-hour'] },
      });
    }
  }, () => { memberDraft = null; settingsDraft = null; sheet = null; });
}

async function bulk(kind) {
  const chosen = state.pending.filter((x) => picked[x.id]);
  if (!chosen.length) return;
  const verb = { approve: 'added to the calendar', shelve: 'moved to the shelf', reject: 'discarded' }[kind];
  busy = true; errMsg = ''; parseNote = ''; render();
  try {
    const r = kind === 'approve' ? await api.approveMany(chosen.map(pendingPayload))
      : kind === 'shelve' ? await api.shelveMany(chosen.map(pendingPayload))
      : await api.rejectMany(chosen.map((x) => x.id));
    chosen.forEach((x) => { delete picked[x.id]; delete edits[x.id]; });
    parseNote = `${r.done} ${verb}${r.failed && r.failed.length ? `. ${r.failed.length} could not be done: ${r.failed.join('; ')}` : '.'}`;
    await reload();
  } catch (err) { errMsg = err.message; }
  busy = false; render();
}

root.addEventListener('submit', async (ev) => {
  if (ev.target.dataset.form !== 'signin') return;
  ev.preventDefault();
  // Read what was typed before re-rendering, which rebuilds the form.
  const email = val('g-email'), password = document.getElementById('g-pass').value;
  if (!email || !password) { gateErr = 'Enter your email and password.'; render(); return; }
  busy = true; gateErr = ''; render();
  try {
    await api.signIn(email, password);
    busy = false;
    await enter();
  } catch (err) { busy = false; gateErr = err.message === 'Invalid login credentials' ? 'That email and password do not match.' : err.message; render(); }
});

root.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  if (act === 'scrim' && ev.target !== t) return;

  if (sheet && (sheet.mode === 'add' || sheet.mode === 'edit')) captureDraft();
  if (sheet && sheet.mode === 'household') captureMembers();
  if (!sheet && view === 'inbox') { captureIntake(); capturePending(); }
  if (!sheet && view === 'ask') captureAsk();

  switch (act) {
    case 'retry': await boot(); break;
    case 'signout': stopListening(); await api.signOut(); state = null; sheet = null; gate = 'signin'; render(); break;

    case 'setup-add': {
      captureSetup();
      const which = t.dataset.t;
      (which === 'adult' ? setupDraft.adults : which === 'other' ? setupDraft.others : setupDraft.kids).push('');
      renderSetup(); break;
    }
    case 'setup-done': {
      captureSetup();
      const ms = [...setupDraft.adults.filter(Boolean).map((name) => ({ name, kind: 'adult' })),
        ...setupDraft.kids.filter(Boolean).map((name) => ({ name, kind: 'kid' })),
        ...setupDraft.others.filter(Boolean).map((name) => ({ name, kind: 'other' }))];
      if (!ms.length) return;
      await mutate(() => api.saveMembers(ms), () => { setupDraft = null; });
      break;
    }

    case 'household': await openHousehold(); break;
    case 'add-member': memberDraft.push({ id: '', name: '', kind: 'kid' }); render(); break;
    case 'rm-member': memberDraft.splice(+t.dataset.i, 1); render(); break;
    case 'save-members': await saveHousehold(); break;
    case 'theme': applyTheme(t.dataset.t); render(); break;
    case 'check-feeds':
      await mutate(async () => { const r = await api.checkFeeds(); info = (r.report || []).join(' ') || 'Checked.'; }, () => { sheet = null; view = 'inbox'; });
      break;
    case 'test-weekly':
      await mutate(async () => { const r = await api.sendTest('weekly'); info = r.sent && r.sent.length ? 'Sent this week\'s summary to you only.' : 'Nothing was sent.'; });
      break;

    case 'test-sms':
      busy = true; render();
      try {
        const r = await api.testSms();
        if (r.error) errMsg = r.error;
        else {
          const bad = r.results.filter((x) => !x.ok);
          info = bad.length ? bad.map((x) => `${x.name}: ${x.error}`).join(' ')
            : `Test text sent to ${r.results.map((x) => x.name).join(' & ')}.${r.enabled ? '' : ' Reminders by text are still off: set sms → enabled to true in settings.'}`;
        }
      } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'filter': filterId = id; render(); break;
    case 'view':
      view = t.dataset.v; schedulingId = null;
      if (view !== 'inbox') picked = {};
      if (view !== 'ask') stopListening();
      render();
      if (view === 'ask') { await refreshWaiting(); render(); }
      break;
    case 'week': weekOffset = +t.dataset.d === 0 ? 0 : weekOffset + +t.dataset.d; render(); break;
    case 'month': monthOffset = +t.dataset.d === 0 ? 0 : monthOffset + +t.dataset.d; render(); break;
    case 'refresh': await load(); break;
    case 'print': window.print(); break;

    case 'open-add': draft = newDraft(); addKind = 'event'; sheet = { mode: 'add' }; render(); break;
    case 'kind': {
      const was = addKind; addKind = t.dataset.k;
      if (was !== addKind) draft.date = addKind === 'idea' ? '' : (draft.date || todayStr());
      render(); break;
    }
    case 'tasks-more': tasksOpen = !tasksOpen; render(); break;
    case 'task-done': {
      const tk = (state.tasks || []).find((x) => x.id === id); if (!tk) return;
      await mutate(() => api.setTaskDone(id, true), () => showUndo(`Done: ${tk.title}`, () => mutate(() => api.setTaskDone(id, false))));
      break;
    }
    case 'task': {
      const tk = (state.tasks || []).find((x) => x.id === id); if (!tk) return;
      draft = { ...newDraft(), id: tk.id, title: tk.title, date: tk.due, note: tk.note, for: (tk.for || []).slice() };
      addKind = 'task'; sheet = { mode: 'edit', id: tk.id }; render(); break;
    }
    case 'save-task': {
      if (!draft.title.trim()) { document.getElementById('f-title')?.focus(); return; }
      const tid = draft.id;
      await mutate(() => api.updateTask({ id: tid, title: draft.title.trim(), due: draft.date || todayStr(), for: draft.for.slice(), note: draft.note }), () => { sheet = null; draft = null; });
      break;
    }
    case 'del-task': {
      const tk = (state.tasks || []).find((x) => x.id === id); if (!tk) return;
      await mutate(() => api.deleteTask(id), () => { sheet = null; draft = null; showUndo(`Deleted "${tk.title}"`, () => mutate(() => api.restoreTask(tk))); });
      break;
    }
    case 'for': {
      const i = draft.for.indexOf(id);
      if (i > -1) draft.for.splice(i, 1); else draft.for.push(id);
      if (!hasKid(draft.for)) draft.driver = '';
      render(); break;
    }
    case 'withus': {
      draft.withUs = draft.withUs || [];
      const i = draft.withUs.indexOf(id);
      if (i > -1) draft.withUs.splice(i, 1); else draft.withUs.push(id);
      render(); break;
    }
    case 'close': case 'scrim': fromEmail = null; sheet = null; draft = null; memberDraft = null; settingsDraft = null; siri = null; pushState = ''; render(); break;
    case 'push-on':
      busy = true; render();
      try { await turnOnPush(); if (pushState === 'on') info = 'Notifications are on. A test is on its way.'; } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'push-off':
      busy = true; render();
      try { await turnOffPush(); info = 'Notifications turned off on this phone.'; } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'push-test':
      busy = true; render();
      try { const r = await api.testPush(); info = r && r.sent ? 'Test sent. It should appear in a few seconds.' : 'Nothing was sent. Turn notifications off and on again.'; } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'siri-make':
      if (siri && siri.has && !confirm('Make a new key? The old one stops working, so the Shortcut will need the new one.')) return;
      busy = true; render();
      try { siri = { has: true, key: await api.createSiriKey() }; } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'siri-off':
      busy = true; render();
      try { await api.revokeSiriKey(); siri = { has: false }; info = 'Siri key turned off.'; } catch (err) { errMsg = err.message; }
      busy = false; render(); break;
    case 'copy': {
      const el = document.getElementById(t.dataset.from);
      if (!el) return;
      try { await navigator.clipboard.writeText(el.value); info = 'Copied.'; } catch (_) { el.select(); info = 'Select and copy it.'; }
      render(); break;
    }
    case 'dismiss': errMsg = ''; info = ''; render(); break;

    case 'create': {
      if (!draft.title.trim()) { document.getElementById('f-title')?.focus(); return; }
      // Adding a weekly-email suggestion (to the calendar or the shelf) counts as liking it.
      if (fromEmail) { const f = fromEmail; fromEmail = null; api.rateEvent({ ...f, vote: 1, how: 'added' }).catch(() => {}); }
      if (addKind === 'task') {
        await mutate(() => api.addTask({ id: uid(), title: draft.title.trim(), due: draft.date || todayStr(), for: draft.for.slice(), note: draft.note }),
          () => { sheet = null; draft = null; view = 'week'; });
      } else if (addKind === 'event') {
        const nid = uid(), when = draft.date || todayStr();
        await mutate(() => api.addEvent({ id: nid, title: draft.title.trim(), date: when, time: draft.time, end: draft.time && draft.end > draft.time ? draft.end : '', for: draft.for.slice(), driver: draft.driver, withUs: (draft.withUs || []).slice(), where: draft.where, note: draft.note, source: 'manual' }),
          () => { sheet = null; draft = null; flashId = nid; view = 'week'; weekOffset = weekOffsetFor(when); });
      } else {
        await mutate(() => api.addIdea({ id: uid(), title: draft.title.trim(), date: draft.date, time: draft.time, for: draft.for.slice(), cost: draft.cost, link: draft.link, note: draft.note }),
          () => { sheet = null; draft = null; view = 'shelf'; });
      }
      break;
    }
    case 'event': sheet = { mode: 'event', id }; render(); break;
    case 'edit-event': {
      const e = eventById(id); if (!e) return;
      draft = { id: e.id, title: e.title, date: e.date, time: e.time, end: e.end || '', where: e.where, cost: '', link: '', note: e.note, for: (e.for || []).slice(), driver: e.driver, withUs: (e.withUs || []).slice() };
      addKind = 'event'; sheet = { mode: 'edit', id: e.id }; render(); break;
    }
    case 'save-edit': {
      if (!draft.title.trim()) { document.getElementById('f-title')?.focus(); return; }
      const edited = draft.date || todayStr(), eid = draft.id;
      await mutate(() => api.updateEvent({ id: eid, title: draft.title.trim(), date: edited, time: draft.time, end: draft.time && draft.end > draft.time ? draft.end : '', for: draft.for.slice(), driver: draft.driver, withUs: (draft.withUs || []).slice(), where: draft.where, note: draft.note }),
        () => { sheet = null; flashId = eid; draft = null; view = 'week'; weekOffset = weekOffsetFor(edited); });
      break;
    }
    case 'del-event': {
      const gone = eventById(id); if (!gone) return;
      await mutate(() => api.deleteEvent(id), () => {
        sheet = null;
        showUndo(`Deleted "${gone.title}"`, () => mutate(() => api.restoreEvent(gone, null)));
      });
      break;
    }
    case 'shelve-event': {
      const moving = eventById(id); if (!moving) return;
      const ideaId = uid();
      await mutate(() => api.eventToIdea(id, ideaId), () => {
        sheet = null; view = 'shelf';
        showUndo(`Moved "${moving.title}" to the shelf`, () => mutate(() => api.restoreEvent(moving, ideaId), () => { view = 'week'; weekOffset = weekOffsetFor(moving.date); flashId = moving.id; }));
      });
      break;
    }
    case 'sched': schedulingId = id; render(); break;
    case 'sched-cancel': schedulingId = null; render(); break;
    case 'confirm-sched': {
      const idea = state.ideas.find((x) => x.id === id); if (!idea) return;
      const sd = val('sd') || todayStr(), st = val('st'), newId = uid();
      await mutate(() => api.ideaToEvent(id, newId, sd, st), () => {
        schedulingId = null; flashId = newId; view = 'week'; weekOffset = weekOffsetFor(sd);
        showUndo('Moved to the week', () => mutate(() => api.restoreIdea(idea, newId), () => { view = 'shelf'; }));
      });
      break;
    }
    case 'drop-idea': {
      const gone = state.ideas.find((x) => x.id === id); if (!gone) return;
      await mutate(() => api.deleteIdea(id), () => showUndo(`Removed "${gone.title}"`, () => mutate(() => api.addIdea(gone))));
      break;
    }

    case 'mode': intakeMode = t.dataset.m; parseNote = ''; errMsg = ''; render(); break;
    case 'parse': await runExtraction(); break;
    case 'pick': picked[id] = !picked[id]; render(); break;
    case 'pick-all': {
      const allOn = state.pending.every((x) => picked[x.id]);
      picked = {};
      if (!allOn) state.pending.forEach((x) => { picked[x.id] = true; });
      render(); break;
    }
    case 'pick-none': picked = {}; render(); break;
    case 'bulk-approve': await bulk('approve'); break;
    case 'bulk-shelve': await bulk('shelve'); break;
    case 'bulk-reject': await bulk('reject'); break;
    case 'pfor': {
      const mid = t.dataset.mid, pend = state.pending.find((x) => x.id === id); if (!pend) return;
      edits[id] = edits[id] || {};
      const cur = (edits[id].for || pend.for || []).slice();
      const i = cur.indexOf(mid);
      if (i > -1) cur.splice(i, 1); else cur.push(mid);
      edits[id].for = cur;
      if (!hasKid(cur)) edits[id].driver = '';
      render(); break;
    }
    case 'approve': {
      const target = state.pending.find((x) => x.id === id); if (!target) return;
      const payload = pendingPayload(target);
      await mutate(() => api.approve(payload), () => { delete edits[id]; parseNote = ''; view = 'week'; weekOffset = weekOffsetFor(payload.date); });
      break;
    }
    case 'shelve-pending': {
      const target = state.pending.find((x) => x.id === id); if (!target) return;
      await mutate(() => api.shelve(pendingPayload(target)), () => { delete edits[id]; parseNote = ''; view = 'shelf'; });
      break;
    }
    case 'reject': await mutate(() => api.reject(id), () => { delete edits[id]; }); break;
    case 'reject-all': await mutate(() => api.rejectAll(), () => { edits = {}; }); break;

    case 'ask-send': await runAsk(); break;
    case 'ask-confirm': await runConfirm(t.dataset.token, false); break;
    case 'ask-cancel': await runConfirm(t.dataset.token, true); break;
    case 'mic': toggleMic(); break;

    case 'undo': if (undo) { const fn = undo.fn; undo = null; await fn(); } break;
    default: break;
  }
});

root.addEventListener('input', (ev) => { if (ev.target.id === 'askin') askText = ev.target.value; });
root.addEventListener('keydown', (ev) => {
  if (ev.target.id === 'askin' && ev.key === 'Enter' && !ev.shiftKey && window.matchMedia('(pointer: fine)').matches) { ev.preventDefault(); runAsk(); }
});

root.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id !== 'photo' || !el.files || !el.files[0]) return;
  const file = el.files[0];
  const reader = new FileReader();
  if (file.type === 'application/pdf') {
    if (file.size > 5 * 1024 * 1024) { errMsg = 'That PDF is over 5 MB. Try sending just the page with the dates.'; render(); return; }
    reader.onload = (e) => { fileData = String(e.target.result).split(',')[1]; fileType = 'application/pdf'; filePreview = ''; fileName = file.name; errMsg = ''; parseNote = ''; render(); };
    reader.readAsDataURL(file);
    return;
  }
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const max = 1500; let w = img.width, h = img.height;
      if (w > max || h > max) { if (w > h) { h = Math.round(h * max / w); w = max; } else { w = Math.round(w * max / h); h = max; } }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const url = c.toDataURL('image/jpeg', 0.85);
      filePreview = url; fileData = url.split(',')[1]; fileType = 'image/jpeg'; fileName = file.name; errMsg = ''; parseNote = '';
      render();
    };
    img.onerror = () => { errMsg = 'Could not read that image.'; render(); };
    img.src = e.target.result;
  };
  reader.onerror = () => { errMsg = 'Could not read that file.'; render(); };
  reader.readAsDataURL(file);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state && !gate && !sheet && !busy && !parsing && !askBusy
      && !(view === 'inbox' && (intakeText || fileData)) && !(view === 'ask' && askText)) load();
});
window.addEventListener('online', () => { offline = false; load(); });
window.addEventListener('offline', () => { offline = true; render(); });

/* ---------- start ---------- */

let unsubscribe = null;

/* A link like ?add=1&title=…&date=…&time=…&where=…&note=… (from the weekly email) opens a filled-in Add form. */
let incoming = null, rating = null, fromEmail = null;
function readIncoming() {
  const q = new URLSearchParams(location.search);
  const clip = (k, n) => (q.get(k) || '').slice(0, n);
  if (q.get('rate') === 'up' || q.get('rate') === 'down') {
    rating = { title: clip('title', 200), kind: q.get('kind') === 'music' ? 'music' : 'event', where: clip('where', 300), vote: q.get('rate') === 'up' ? 1 : -1 };
  }
  if (q.get('add') !== '1' && !rating) return;
  if (q.get('add') === '1') incoming = { kind: q.get('kind') === 'music' ? 'music' : 'event', title: clip('title', 200), date: /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : '',
    time: /^\d{2}:\d{2}$/.test(q.get('time') || '') ? q.get('time') : '', where: clip('where', 300), note: clip('note', 1000) };
  const keep = new URLSearchParams(); if (q.has('demo')) keep.set('demo', '');
  history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep.toString().replace(/=$/, '') : ''));
}
async function openIncoming() {
  if (rating && state) {
    const r = rating; rating = null;
    try {
      if (r.title) await api.rateEvent(r);
      info = r.vote > 0 ? `Noted: interested in "${r.title}". Future suggestions will lean that way.` : `Noted: "${r.title}" is not for you. You'll see fewer like it.`;
    } catch (err) { errMsg = err.message; }
    render();
  }
  if (!incoming || !state) return;
  fromEmail = { title: incoming.title, kind: incoming.kind, where: incoming.where };
  const { kind: _k, ...fields } = incoming;
  draft = { ...newDraft(), ...fields, date: incoming.date || todayStr() };
  addKind = 'event'; sheet = { mode: 'add' }; incoming = null;
  info = 'From the weekly email. Check the details, then add it (or switch to Shelf to keep it as a maybe).';
  render();
}

async function enter() {
  try {
    me = await api.session();
    if (!me) { gate = 'signin'; render(); return; }
    if (!(await api.isAllowed())) { gate = 'denied'; render(); return; }
    gate = null;
    await load();
    await openIncoming();
    if (unsubscribe) unsubscribe();
    unsubscribe = api.onChange(() => { if (!busy && !sheet && !parsing) load(); });
  } catch (err) { gate = 'error'; gateErr = err.message; render(); }
}

async function boot() {
  applyTheme(theme);
  readIncoming();
  const cfg = window.HM_CONFIG || {};
  const demo = new URLSearchParams(location.search).has('demo');
  try {
    if (demo) api = createDemoBackend();
    else if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { gate = 'setup'; render(); return; }
    else { const { createLiveBackend } = await import('./backend.js'); api = await createLiveBackend(cfg); }
  } catch (err) { gate = 'error'; gateErr = `Could not load the app: ${err.message}`; render(); return; }
  await enter();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
