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
let draft = null, memberDraft = null, setupDraft = null, settingsDraft = null;
let intakeMode = 'text', intakeText = '', fileData = '', fileType = '', filePreview = '', fileName = '';
let parsing = false, parseNote = '', edits = {}, picked = {};
let askText = '', askLog = [], askBusy = false, askPending = null, listening = false, recognizer = null;
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
const needsDriver = (e) => !!e.time && !e.driver && hasKid(e.for || []) && e.date >= todayStr();

/* ---------- data ---------- */

async function reload() {
  state = await api.load();
  errMsg = '';
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
    + `<span>${state.events.filter((e) => e.date === todayStr()).length || 'Nothing'} on today${state.pending.length ? `, ${state.pending.length} waiting` : ''}</span></div><div class="topbtns">`
    + `<button class="linkish" data-act="household">Household</button>`
    + `<button class="linkish" data-act="refresh">${busy ? 'Saving…' : 'Refresh'}</button></div></div>`
    + (api.mode === 'demo' ? '<div class="banner">Demo with sample data. Nothing is saved.</div>' : '')
    + (offline ? '<div class="banner">You are offline. Changes will fail until you reconnect.</div>' : '')
    + '<div class="tabs" role="tablist">'
    + tab('week', 'Week') + tab('month', 'Month')
    + tab('shelf', `Shelf<span class="count">${state.ideas.length}</span>`)
    + tab('inbox', `Inbox${state.pending.length ? `<span class="count">${state.pending.length}</span>` : ''}`)
    + tab('ask', 'Ask')
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
    const evs = state.events.filter((e) => e.date === key && visible(e)).sort((x, y) => (x.time || '00:00').localeCompare(y.time || '00:00'));
    body += `<section class="day${key === today ? ' is-today' : ''}${key < today ? ' is-past' : ''}${evs.length ? '' : ' empty'}" aria-label="${DAYS[d.getDay()]} ${d.getDate()}">`
      + `<div class="dayhead"><span class="dnum">${d.getDate()}</span><span class="dname">${key === today ? 'Today' : DAYS[d.getDay()].slice(0, 3)}</span></div><div class="dayevents">`;
    if (!evs.length) body += '<div class="none">Nothing yet</div>';
    evs.forEach((e) => {
      body += `<button class="ev" data-act="event" data-id="${e.id}" data-flash="${e.id}"><span class="bar" style="${barStyle(e.for || [])}"></span>`
        + `<span class="evbody"><span class="evtop"><span class="evtime">${e.time ? pretty(e.time) : 'All day'}</span><span class="evtitle">${esc(e.title)}</span></span>`
        + `<span class="evmeta">${metaPieces(e)}</span></span></button>`;
    });
    body += '</div></section>';
  }
  return filterHtml()
    + `<div class="weekbar"><span class="range">${range}</span><span class="nav">`
    + '<button data-act="week" data-d="-1" aria-label="Previous week">‹</button>'
    + '<button data-act="week" data-d="0">Today</button>'
    + '<button data-act="week" data-d="1" aria-label="Next week">›</button></span></div>' + body;
}

function monthHtml() {
  const base = new Date(); base.setDate(1); base.setMonth(base.getMonth() + monthOffset);
  const y = base.getFullYear(), m = base.getMonth();
  const prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const daysIn = new Date(y, m + 1, 0).getDate(), startDow = new Date(y, m, 1).getDay(), today = todayStr();
  const label = `${FULLMONTHS[m]} ${y}`;
  const byDay = {};
  state.events.forEach((e) => { if (String(e.date).slice(0, 7) === prefix && visible(e)) (byDay[e.date] = byDay[e.date] || []).push(e); });
  Object.values(byDay).forEach((l) => l.sort((a, b) => (a.time || '00:00').localeCompare(b.time || '00:00')));

  let grid = '<div class="mgrid">' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="mdow">${d}</div>`).join('');
  const total = Math.ceil((startDow + daysIn) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const dn = i - startDow + 1;
    if (dn < 1 || dn > daysIn) { grid += '<div class="mcell off"></div>'; continue; }
    const key = `${prefix}-${String(dn).padStart(2, '0')}`, evs = byDay[key] || [];
    grid += `<div class="mcell${key === today ? ' now' : ''}"><div class="mnum">${dn}</div>`
      + evs.slice(0, 3).map((e) => `<div class="mev"><span class="dot" style="${barStyle(e.for || [])}"></span><span>${e.time ? pretty(e.time, true) + ' ' : ''}${esc(e.title)}</span></div>`).join('')
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
        return `<div class="pev"><span class="dot" style="${barStyle(e.for || [])}"></span><span><span class="ptime">${e.time ? pretty(e.time, true) : 'all day'}</span> ${esc(e.title)} <span class="pwho">${esc(tail)}</span></span></div>`;
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
    h += `<div class="card${isPicked ? ' picked' : ''}">`
      + `<button class="pick" data-act="pick" data-id="${p.id}" aria-pressed="${isPicked}">${isPicked ? 'Selected' : 'Select'}</button>`
      + `<input type="text" data-pe="title" data-id="${p.id}" value="${esc(e.title ?? p.title)}" aria-label="Title">`
      + `<div class="stagerow"><input type="date" data-pe="date" data-id="${p.id}" value="${esc(e.date ?? p.date)}" aria-label="Date"><input type="time" data-pe="time" data-id="${p.id}" value="${esc(e.time ?? p.time)}" aria-label="Time"></div>`
      + (p.where ? `<div class="cardmeta">${esc(p.where)}</div>` : '')
      + (p.note ? `<div class="cardmeta">${esc(p.note)}</div>` : '')
      + `<div class="cardmeta">${sourceLine(p)}</div>`
      + '<div class="chips" style="margin-top:10px">' + roster().map((m) => `<button class="chip" data-act="pfor" data-id="${p.id}" data-mid="${m.id}" aria-pressed="${forIds.includes(m.id)}"><span class="dot" style="background:${colorOf(m.id)}"></span>${esc(m.name)}</button>`).join('') + '</div>'
      + (hasKid(forIds) ? driverSelectHtml(`pd-${p.id}`, e.driver || '') : '')
      + `<div class="row"><button class="btn go" data-act="approve" data-id="${p.id}"${busy ? ' disabled' : ''}>Add to the week</button>`
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
  return { id: p.id, title: e.title ?? p.title, date: e.date ?? p.date, time: e.time ?? p.time, for: e.for || p.for || [], driver: e.driver || '', withUs: e.withUs || [], where: p.where, note: p.note };
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
  if (askPending) {
    h += `<div class="confirm"><div class="cardtitle">${esc(askPending.summary)}</div>`
      + `<div class="row"><button class="btn go" data-act="ask-confirm"${askBusy ? ' disabled' : ''}>Yes, do it</button>`
      + `<button class="btn" data-act="ask-cancel"${askBusy ? ' disabled' : ''}>Cancel</button></div></div>`;
  }
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
  askText = ''; askBusy = true; askPending = null; errMsg = ''; render();
  try {
    const r = await api.ask(msg, history);
    askLog.push({ role: 'assistant', text: r.reply || 'Done.' });
    askPending = r.pending || null;
    if (r.changed) await reload();
  } catch (err) { errMsg = err.message; }
  askBusy = false; render();
}

async function runConfirm() {
  if (!askPending || askBusy) return;
  const token = askPending.token;
  askBusy = true; errMsg = ''; render();
  try {
    const r = await api.confirm(token);
    askPending = null;
    askLog.push({ role: 'assistant', text: r.reply || 'Done.' });
    if (r.changed) await reload();
  } catch (err) { errMsg = err.message; }
  askBusy = false; render();
}

function toggleMic() {
  if (listening) { stopListening(); render(); return; }
  captureAsk();
  recognizer = new SpeechRec();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.interimResults = true;
  recognizer.continuous = false;
  const before = askText ? askText.trim() + ' ' : '';
  recognizer.onresult = (ev) => {
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
function stopListening() { if (recognizer) { try { recognizer.stop(); } catch (_) { /* already stopped */ } } listening = false; }

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
  ['title', 'date', 'time', 'where', 'cost', 'link', 'note'].forEach((k) => { const el = document.getElementById('f-' + k); if (el) draft[k] = el.value; });
  const dv = document.getElementById('f-driver');
  if (dv) draft.driver = dv.value;
}

function captureMembers() {
  if (!memberDraft) return;
  root.querySelectorAll('[data-mn]').forEach((el) => { const m = memberDraft[+el.dataset.mn]; if (m) m.name = el.value.trim(); });
  root.querySelectorAll('[data-mk]').forEach((el) => { const m = memberDraft[+el.dataset.mk]; if (m) m.kind = el.value; });
  if (settingsDraft) {
    const n = document.getElementById('s-notify'); if (n) settingsDraft.notify = n.value;
    ['weekly-day', 'weekly-hour', 'reminder-hour', 'digest-hour'].forEach((k) => { const el = document.getElementById('s-' + k); if (el) settingsDraft[k] = el.value; });
  }
}

function formHtml(isEdit) {
  const event = addKind === 'event';
  return `<h2>${isEdit ? 'Edit' : 'Add something'}</h2>`
    + (isEdit ? '' : '<div class="seg">'
      + `<button data-act="kind" data-k="event" aria-pressed="${event}">On the calendar</button>`
      + `<button data-act="kind" data-k="idea" aria-pressed="${!event}">On the shelf</button></div>`)
    + `<div class="field"><label for="f-title">What is it</label><input type="text" id="f-title" data-autofocus value="${esc(draft.title)}" placeholder="${event ? 'Orthodontist, soccer practice…' : 'Something you might do'}"></div>`
    + (event
      ? `<div class="stagerow"><div><label class="label" for="f-date">Date</label><input type="date" id="f-date" value="${esc(draft.date || todayStr())}"></div>`
        + `<div><label class="label" for="f-time">Time (blank for all day)</label><input type="time" id="f-time" value="${esc(draft.time)}"></div></div>`
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
      + `<div class="field"><label for="s-digest-hour">"Things are waiting" email at</label><select id="s-digest-hour">${hourOpts(s['digest-hour'])}</select></div></div>`;
  }
  h += `<button class="primary" data-act="save-members"${busy ? ' disabled' : ''}>${busy ? 'Saving…' : 'Save household'}</button>`
    + '<div class="subhead">Look</div><p class="note">Just for this phone.</p><div class="chips">'
    + THEMES.map((t) => `<button class="chip" data-act="theme" data-t="${t.id}" aria-pressed="${theme === t.id}">${esc(t.name)} <span style="opacity:.7">${esc(t.hint)}</span></button>`).join('')
    + '</div>'
    + '<div class="subhead">Tools</div><div class="row">'
    + `<button class="btn" data-act="check-feeds"${busy ? ' disabled' : ''}>Check the school calendar now</button>`
    + `<button class="btn" data-act="test-weekly"${busy ? ' disabled' : ''}>Email me this week's summary</button></div>`
    + `<p class="note" style="margin-top:18px">Signed in as ${esc(me?.email || '')}.</p>`
    + '<button class="btn" data-act="signout">Sign out</button>'
    + '<button class="ghost" data-act="close">Close</button>';
  return h;
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
      `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}${e.time ? ' at ' + pretty(e.time) : ', all day'}`,
      names(e.for || []),
      dm ? `${dm.name} driving` : e.driver === 'none' ? 'No driving needed' : needsDriver(e) ? 'No driver yet' : '',
      (e.withUs || []).length ? `${names(e.withUs)} with us` : '',
      e.where, e.note,
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
    };
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
  busy = true; gateErr = ''; render();
  try {
    await api.signIn(val('g-email'), document.getElementById('g-pass').value);
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
      await mutate(async () => { const r = await api.sendTest('weekly'); info = r.sent && r.sent.length ? 'Sent this week\'s summary.' : 'Nothing was sent. Add an email address under Emails and reminders first.'; });
      break;

    case 'filter': filterId = id; render(); break;
    case 'view':
      view = t.dataset.v; schedulingId = null;
      if (view !== 'inbox') picked = {};
      if (view !== 'ask') stopListening();
      render(); break;
    case 'week': weekOffset = +t.dataset.d === 0 ? 0 : weekOffset + +t.dataset.d; render(); break;
    case 'month': monthOffset = +t.dataset.d === 0 ? 0 : monthOffset + +t.dataset.d; render(); break;
    case 'refresh': await load(); break;
    case 'print': window.print(); break;

    case 'open-add': draft = newDraft(); addKind = 'event'; sheet = { mode: 'add' }; render(); break;
    case 'kind': {
      const was = addKind; addKind = t.dataset.k;
      if (was !== addKind) draft.date = addKind === 'event' ? (draft.date || todayStr()) : '';
      render(); break;
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
    case 'close': case 'scrim': sheet = null; draft = null; memberDraft = null; settingsDraft = null; render(); break;
    case 'dismiss': errMsg = ''; info = ''; render(); break;

    case 'create': {
      if (!draft.title.trim()) { document.getElementById('f-title')?.focus(); return; }
      if (addKind === 'event') {
        const nid = uid(), when = draft.date || todayStr();
        await mutate(() => api.addEvent({ id: nid, title: draft.title.trim(), date: when, time: draft.time, for: draft.for.slice(), driver: draft.driver, withUs: (draft.withUs || []).slice(), where: draft.where, note: draft.note, source: 'manual' }),
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
      draft = { id: e.id, title: e.title, date: e.date, time: e.time, where: e.where, cost: '', link: '', note: e.note, for: (e.for || []).slice(), driver: e.driver, withUs: (e.withUs || []).slice() };
      addKind = 'event'; sheet = { mode: 'edit', id: e.id }; render(); break;
    }
    case 'save-edit': {
      if (!draft.title.trim()) { document.getElementById('f-title')?.focus(); return; }
      const edited = draft.date || todayStr(), eid = draft.id;
      await mutate(() => api.updateEvent({ id: eid, title: draft.title.trim(), date: edited, time: draft.time, for: draft.for.slice(), driver: draft.driver, withUs: (draft.withUs || []).slice(), where: draft.where, note: draft.note }),
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
    case 'ask-confirm': await runConfirm(); break;
    case 'ask-cancel': askPending = null; askLog.push({ role: 'assistant', text: 'Okay, cancelled. Nothing was changed.' }); render(); break;
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

async function enter() {
  try {
    me = await api.session();
    if (!me) { gate = 'signin'; render(); return; }
    if (!(await api.isAllowed())) { gate = 'denied'; render(); return; }
    gate = null;
    await load();
    if (unsubscribe) unsubscribe();
    unsubscribe = api.onChange(() => { if (!busy && !sheet && !parsing) load(); });
  } catch (err) { gate = 'error'; gateErr = err.message; render(); }
}

async function boot() {
  applyTheme(theme);
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
