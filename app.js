/* Hardband Photos — vanilla JS, on-device (IndexedDB) photo log for drill-pipe hardband inspections. */
'use strict';

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const isoLocal = (t) => { const d = new Date(t); return `${isoDay(t)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dtLocalValue = (t) => { const d = new Date(t); return `${isoDay(t)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const fmtDate = (t) => { const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const fmtShort = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtMB = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + ' MB';
const byText = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Unknown';
const safeToken = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ================= IndexedDB ================= */
const DB_NAME = 'hardband-photos';
const DB_VER = 3; // v2 adds the 'outbox' store for team sync, v3 the 'rejects' store (rejected-wire log); existing data untouched
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['rigs', 'customers', 'pipeSpecs']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const p = db.createObjectStore('photos', { keyPath: 'id' });
        p.createIndex('createdAt', 'createdAt');
        p.createIndex('customerId', 'customerId');
        p.createIndex('rigId', 'rigId');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('rejects')) db.createObjectStore('rejects', { keyPath: 'id' });
    };
    req.onsuccess = () => { const d = req.result; d.onversionchange = () => d.close(); resolve(d); };
    req.onerror = () => reject(req.error);
    // An older copy of the app still open elsewhere delays the upgrade; it continues once that copy closes.
    req.onblocked = () => { try { toast('Updating storage — close other open copies of this app.', 6000); } catch (e) { /* ignore */ } };
  });
  return dbPromise;
}
function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const st = t.objectStore(store);
    let out;
    const r = fn(st);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}
const db = {
  all: (s) => tx(s, 'readonly', (st) => st.getAll()),
  get: (s, id) => tx(s, 'readonly', (st) => st.get(id)),
  put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
  del: (s, id) => tx(s, 'readwrite', (st) => st.delete(id)),
  clear: (s) => tx(s, 'readwrite', (st) => st.clear()),
};
const setMeta = (key, value) => { S.meta[key] = value; return db.put('meta', { key, value }); };

// Some Safari builds historically refused Blobs in IndexedDB; fall back to ArrayBuffers.
const storedToBlob = (x) => (!x ? null : x instanceof Blob ? x : x.__ab ? new Blob([x.__ab], { type: x.type || 'image/jpeg' }) : null);
async function putPhoto(p) {
  try { await db.put('photos', p); }
  catch (e) {
    const rec = { ...p, blob: { __ab: await p.blob.arrayBuffer(), type: p.blob.type }, thumb: p.thumb ? { __ab: await p.thumb.arrayBuffer(), type: p.thumb.type } : null };
    await db.put('photos', rec);
  }
}

/* ================= state ================= */
const S = {
  rigs: new Map(), customers: new Map(), pipeSpecs: new Map(), photos: [], rejects: [], meta: {},
  gone: { rigs: new Map(), customers: new Map(), pipeSpecs: new Map() }, // deleted/merged entries (team sync tombstones)
  search: { q: '', customerId: '', rigId: '', end: '', stage: '', op: '', from: '', to: '' }, showFilters: false, showClosed: false,
  queue: [], qIndex: 0, savedCount: 0, batchValues: null, lastSaved: null, keepJoint: false,
  pendingKeep: null, pendingStage: null, forceStage: null, keepFrom: null, addFromDetail: false, addDetailStage: null, // durable Same-joint intent until handleFiles consumes it
  context: null, addContext: null, lastListHash: '#/', lastList: [], manageTab: 'rigs',
  viewUrls: [], scroll: {}, modalCancel: null,
  inspection: null, addInspect: false, // inspection session: { workOrder, rigName, rigId, customerId, pipeSpecId, operator, count, ready }
};
const KINDS = {
  rigs: { store: 'rigs', field: 'name', label: 'Rig', plural: 'Rigs', ref: 'rigId', notes: true, prefix: 'r' },
  customers: { store: 'customers', field: 'name', label: 'Customer', plural: 'Customers', ref: 'customerId', prefix: 'c' },
  pipeSpecs: { store: 'pipeSpecs', field: 'description', label: 'Pipe spec', plural: 'Pipe specs', ref: 'pipeSpecId', prefix: 's' },
};
const labelOf = (kind, id) => { const it = S[kind].get(id) || S.gone[kind].get(id); return it ? it[KINDS[kind].field] : ''; };
const sortedItems = (kind) => [...S[kind].values()].sort((a, b) => byText(a[KINDS[kind].field], b[KINDS[kind].field]));
const countUsing = (kind, id) => S.photos.filter((p) => p[KINDS[kind].ref] === id).length;
// Photo stage: 'pre' = taken during inspection BEFORE hardbanding, 'post' = AFTER hardbanding.
// Photos saved before this field existed (no stage) count as 'post'.
const STAGES = {
  pre: { label: 'Before hardband (inspection)', short: 'Before', badge: 'BEFORE', words: 'before pre inspection' },
  repair: { label: 'Repair', short: 'Repair', badge: 'REPAIR', words: 'repair' },
  plasma: { label: 'Plasma cut', short: 'Plasma', badge: 'PLASMA', words: 'plasma cut' },
  inlay: { label: 'Inlay', short: 'Inlay', badge: 'INLAY', words: 'inlay placed' },
  post: { label: 'After hardband', short: 'After', badge: 'AFTER', words: 'after post' },
  preheat: { label: 'Preheat temp photo', short: 'Preheat', badge: 'PREHEAT', words: 'preheat temp temperature' },
};
const STAGE_ORDER = ['pre', 'repair', 'plasma', 'inlay', 'preheat', 'post'];
const REPAIR_MID = ['repair', 'plasma', 'inlay']; // Repair joints only
// Work order per joint. Repair joints skip Preheat (no preheat before plasma cutting):
//   normal / reapply: Before → Preheat → After
//   repair:           Before → Repair → Plasma cut → Inlay → After
const PLAIN_SEQ = ['pre', 'preheat', 'post'];
// Band auto-fill when End is picked: Box → Band 3, Pin → Band 2 (he can still tap another band to override).
const END_BAND = { Box: '3', Pin: '2' };
const REPAIR_SEQ = ['pre', 'repair', 'plasma', 'inlay', 'post'];
/** Next stage in this joint's work order, or null at the end (After). Legacy Preheat on a repair joint → After. */
// Repair joints: the Before picture serves as the repair picture (hbp-v28), so Before → Plasma cut. A Repair-stage photo
// (picked by hand in the Stage row, or older data like D13) still continues to Plasma cut.
const REPAIR_FLOW = ['pre', 'plasma', 'inlay', 'post'];
function nextStage(st, repair) {
  if (repair && st === 'repair') return 'plasma';
  const seq = repair ? REPAIR_FLOW : PLAIN_SEQ;
  const i = seq.indexOf(st);
  if (i < 0) return st === 'preheat' ? 'post' : null;
  return i < seq.length - 1 ? seq[i + 1] : null;
}
const stageOf = (p) => (p && STAGES[p.stage] ? p.stage : 'post');
const stageBadge = (p, extra = '') => `<span class="stage-badge ${stageOf(p)}${extra ? ' ' + extra : ''}">${STAGES[stageOf(p)].badge}</span>`;
// Repair joint = a comma-split notes token that is the word "Repair" or starts with it (case-insensitive, word
// boundary): "Repair", "repair", "Repair  Defender HB first Ptech…" (typed, no comma — D12) all count.
// Not a repair joint: "Needs repair" (After condition chip), "Reapply", "Repaired" (no word boundary).
const notesTokens = (notes) => String(notes || '').split(',').map((t) => t.trim()).filter(Boolean);
const REPAIR_TOKEN = /^repair\b/i;
const notesHasRepair = (notes) => notesTokens(notes).some((t) => REPAIR_TOKEN.test(t));
function isRepairJoint(notes, serial, end) {
  if (notesHasRepair(notes)) return true;
  const k = serialKey(serial);
  if (!k) return false;
  const e = end || '';
  return S.photos.some((x) => !x.deletedAt && serialKey(x.serialNumber) === k && (x.end || '') === e && notesHasRepair(x.notes));
}
// Repair joints: the Before picture is the repair picture (hbp-v29), so the Stage row is Before / Plasma cut / Inlay / After.
// keepRepair: an existing Repair-stage photo (e.g. D13) being edited keeps its Repair button so it shows and can be changed away.
function stageKeys(repair, keepPreheat, keepRepair) {
  return repair ? ['pre', ...(keepRepair ? ['repair'] : []), 'plasma', 'inlay', ...(keepPreheat ? ['preheat'] : []), 'post'] : PLAIN_SEQ.slice();
}
function stageButtonsHTML(repair, keepPreheat, keepRepair) {
  // Work order: Before → Preheat → After. Repair joints: Before → Plasma cut → Inlay → After (no Preheat, no Repair).
  // keepPreheat: an existing Preheat photo on a repair joint keeps its button so editing never silently changes its stage.
  const rows = repair
    ? [['pre', '<span>Before hardband</span><small>(inspection)</small>'],
       ...(keepRepair ? [['repair', '<span>Repair</span>']] : []),
       ['plasma', '<span>Plasma cut</span>'],
       ['inlay', '<span>Inlay</span>'],
       ...(keepPreheat ? [['preheat', '<span>Preheat</span>']] : []),
       ['post', '<span>After hardband</span>']]
    : [['pre', '<span>Before hardband</span><small>(inspection)</small>'],
       ['preheat', '<span>Preheat</span>'],
       ['post', '<span>After hardband</span>']];
  return rows.map(([v, html]) => `<button type="button" data-v="${v}" role="radio">${html}</button>`).join('');
}
// Pipe spec sticks for the whole job (he never changes pipe mid-job):
//  - Start new job session active → the spec on that sheet (updated when he overrides it on a saved photo);
//  - otherwise the spec of the most recently saved, non-deleted photo on that rig (same customer preferred);
//  - '' when neither is known (caller keeps last-used).
function rigLastSpec(rigId, customerId) {
  if (!rigId) return '';
  let best = null, bestT = -1, bestCust = false;
  for (const x of S.photos) {
    if (x.deletedAt || x.rigId !== rigId || !x.pipeSpecId || !S.pipeSpecs.has(x.pipeSpecId)) continue;
    const c = !!customerId && x.customerId === customerId, t = x.addedAt || x.createdAt || 0;
    if ((c && !bestCust) || (c === bestCust && t > bestT)) { best = x; bestT = t; bestCust = c; }
  }
  return best ? best.pipeSpecId : '';
}
function jobSpec(rigId, customerId) {
  const sess = S.addInspect && S.inspection;
  if (sess && sess.pipeSpecId && S.pipeSpecs.has(sess.pipeSpecId) && (!rigId || !sess.rigId || sess.rigId === rigId)) return sess.pipeSpecId;
  return rigLastSpec(rigId, customerId);
}
function jointHasStage(serial, st) {
  const k = serialKey(serial);
  if (!k) return false;
  return S.photos.some((x) => !x.deletedAt && serialKey(x.serialNumber) === k && stageOf(x) === st);
}
/** Stages already photographed for one joint (serial + end, non-deleted). */
function jointStageSet(serial, end) {
  const k = serialKey(serial), e = end || '', set = new Set();
  if (!k) return set;
  for (const x of S.photos) if (!x.deletedAt && serialKey(x.serialNumber) === k && (x.end || '') === e) set.add(stageOf(x));
  return set;
}
/** First stage after `st` in the joint's work order that has no photo yet (null if none). */
function nextMissingStage(st, repair, have) {
  const seq = repair ? REPAIR_SEQ : PLAIN_SEQ;
  let i = seq.indexOf(st);
  if (i < 0) i = st === 'preheat' ? seq.indexOf('post') - 1 : -1;
  for (let j = i + 1; j < seq.length; j++) if (!have.has(seq[j])) return seq[j];
  return null;
}
// Notes chip already in the notes? (comma token, case-insensitive; Repair chip also matches the leading-word form
// "Repair  Defender…"). Tapping a present chip again is a no-op — never "Repair, Repair".
function notesHasChip(notes, chip) {
  const c = String(chip || '').trim().toLowerCase();
  if (!c) return false;
  if (notesTokens(notes).some((t) => t.toLowerCase() === c)) return true;
  return c === 'repair' && notesHasRepair(notes);
}
/** Arm Same-joint / Next-joint intent from a saved-screen CTA. Survives route()/camBtn races until handleFiles.
 *  Photo-detail CTAs carry data-from=<photo id>: the new photo copies that photo's metadata instead of S.lastSaved. */
function armKeepFromEl(el) {
  if (!el || !el.hasAttribute || !el.hasAttribute('data-keep')) return;
  S.pendingKeep = el.dataset.keep === '1';
  S.keepJoint = !!S.pendingKeep;
  const st = el.dataset.stage;
  S.pendingStage = (st && STAGES[st]) ? st : null;
  S.keepFrom = (S.pendingKeep && el.dataset.from) ? el.dataset.from : null;
}
function folderStageSummary(list) {
  const n = (st) => list.filter((p) => stageOf(p) === st).length;
  const bits = [`${n('pre')} before`];
  for (const st of REPAIR_MID) { const c = n(st); if (c) bits.push(`${c} ${st}`); }
  if (n('preheat')) bits.push(`${n('preheat')} preheat`);
  bits.push(`${n('post')} after`);
  return `(${bits.join(' · ')})`;
}

/* ---------- operator: who did the work (part of every record) ----------
   Stored on the record as ONE text value "Name Number", e.g. "Dusty 104" (Supabase column photos.operator).
   The number is the identity: same number = same operator, whatever the capitalisation/spacing of the name.
   Records saved before this existed have no operator ("No operator" / Unassigned).
   The phone remembers the last operator and the names added here (localStorage); the pick list also includes
   every operator found on the (shared) records, so names added on one phone reach the others with their photos. */
const OP_LS = { cur: 'hbp.operator', list: 'hbp.operators' };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: just not remembered */ } };
const cleanOp = (s) => String(s || '').trim().replace(/\s+/g, ' ');
// "Dusty 104" -> { name: 'Dusty', num: '104' }; a value without a trailing number keeps it all as the name.
function parseOp(s) {
  const t = cleanOp(s), m = t.match(/^(?:(.*\S)\s+)?#?(\d+)$/);
  return m ? { name: (m[1] || '').trim(), num: m[2] } : { name: t, num: '' };
}
const opNum = (n) => String(n || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
const opKey = (s) => { const t = cleanOp(s); if (!t) return ''; const o = parseOp(t); return o.num ? 'n:' + opNum(o.num) : 'x:' + o.name.toLowerCase(); };
const opText = (p) => cleanOp(p && p.operator) || 'No operator';
const currentOperator = () => cleanOp(lsGet(OP_LS.cur, ''));
function rememberOperator(label, makeCurrent) {
  const l = cleanOp(label); if (!l) return;
  const list = (lsGet(OP_LS.list, []) || []).filter((x) => opKey(x) !== opKey(l));
  lsSet(OP_LS.list, [l, ...list].slice(0, 300));
  if (makeCurrent) lsSet(OP_LS.cur, l);
}
// Every known operator, one per number: this phone's list first, then the newest spelling found on records.
function operatorRoster() {
  const m = new Map();
  const add = (label) => { const l = cleanOp(label), k = opKey(l); if (k && !m.has(k)) m.set(k, l); };
  add(currentOperator());
  for (const l of lsGet(OP_LS.list, []) || []) add(l);
  for (const p of S.photos.slice().sort((a, b) => (b.updatedAt || b.addedAt || 0) - (a.updatedAt || a.addedAt || 0))) add(p.operator);
  for (const r of S.rejects.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) add(r.operator); // operators known only from rejects
  return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => byText(a.label, b.label));
}
const opLinkHTML = (p) => { const k = opKey(p && p.operator);
  return `<button type="button" class="op-link${k ? '' : ' none'}" data-op-filter="${esc(k || '__none')}" title="Show all photos by this operator">${k ? '👷 ' : ''}${esc(opText(p))}</button>`; };

// Operator dropdown: saved names + "Add new operator…" (Name + Number typed once, then it's in the list).
function opFieldHTML(id, value, { blank = '— Pick your name —', wrapId = '', label = 'Operator' } = {}) {
  const roster = operatorRoster(), v = cleanOp(value);
  let selLabel = '';
  if (v) { const hit = roster.find((o) => o.key === opKey(v)); if (hit) selLabel = hit.label; else { roster.push({ key: opKey(v), label: v }); selLabel = v; } }
  return `<div class="field op-field"${wrapId ? ` id="${wrapId}"` : ''}><label for="${id}">${esc(label)}</label>
    <select id="${id}" class="op-select" data-op-select="1"><option value="">${esc(blank)}</option>${roster.map((o) => `<option value="${esc(o.label)}" ${o.label === selLabel ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}<option value="__new">＋ Add new operator…</option></select>
    <div class="op-add" id="${id}Add" hidden>
      <div class="op-add-row">
        <div class="op-add-name"><label for="${id}Name">Name</label><input id="${id}Name" type="text" placeholder="e.g. Dusty" autocapitalize="words" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="next"></div>
        <div class="op-add-num"><label for="${id}Num">Number</label><input id="${id}Num" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="10" placeholder="e.g. 104" autocomplete="off" enterkeyhint="done"></div>
      </div>
      <div class="muted small">Number = your employee / badge number. It tells two people with the same name apart.</div>
      <div class="row op-add-actions"><button type="button" class="btn ghost" id="${id}AddCancel">Cancel</button><button type="button" class="btn primary" id="${id}AddOk">Save operator</button></div>
    </div>
    <div class="small op-msg" id="${id}Msg" role="alert"></div></div>`;
}
function bindOpField(id, { onChange = null } = {}) {
  const sel = $('#' + id), box = $('#' + id + 'Add'), nm = $('#' + id + 'Name'), nu = $('#' + id + 'Num'), msg = $('#' + id + 'Msg');
  let prev = sel.value === '__new' ? '' : sel.value;
  const choose = (label) => {
    if (label && ![...sel.options].some((o) => o.value === label)) {
      const o = document.createElement('option'); o.value = label; o.textContent = label;
      sel.insertBefore(o, sel.querySelector('option[value="__new"]'));
    }
    sel.value = label; prev = label; box.hidden = true; msg.textContent = '';
    if (onChange) onChange(label);
  };
  const ctl = {
    get value() { return sel.value === '__new' ? '' : sel.value; },
    get adding() { return !box.hidden; },
    choose,
    say(t) { msg.textContent = t; },
    // Save the typed Name + Number. Returns the operator ("Name Number"), or '' with a message if it can't.
    commit() {
      let name = cleanOp(nm.value), num = String(nu.value || '').trim();
      if (!num) { const o = parseOp(name); if (o.num && o.name) { name = o.name; num = o.num; } } // "Dusty 104" typed in Name
      if (num) name = name.replace(new RegExp('\\s+#?' + num.replace(/\D/g, '') + '$'), '').trim();
      if (!name) { msg.textContent = 'Type your name.'; nm.focus(); return ''; }
      if (!num) { msg.textContent = 'Type your number (digits only), e.g. badge number.'; nu.focus(); return ''; }
      if (!/^\d+$/.test(num)) { msg.textContent = 'Number: digits only.'; nu.focus(); return ''; }
      const key = 'n:' + opNum(num), same = operatorRoster().find((o) => o.key === key);
      if (same) {
        if (parseOp(same.label).name.toLowerCase() === name.toLowerCase()) { rememberOperator(same.label); choose(same.label); return same.label; }
        msg.innerHTML = `Number ${esc(num)} is already used by <b>${esc(same.label)}</b>. Pick them, or type a different number.
          <button type="button" class="btn secondary block op-use" id="${id}Use">Use ${esc(same.label)}</button>`;
        $('#' + id + 'Use').onclick = () => { rememberOperator(same.label); choose(same.label); };
        nu.focus(); return '';
      }
      const label = `${name} ${num}`;
      rememberOperator(label);
      choose(label);
      return label;
    },
  };
  sel.addEventListener('change', () => {
    msg.textContent = '';
    if (sel.value !== '__new') { prev = sel.value; box.hidden = true; if (onChange) onChange(sel.value); return; }
    nm.value = ''; nu.value = ''; box.hidden = false;
    setTimeout(() => nm.focus(), 30);
  });
  $('#' + id + 'AddCancel').onclick = () => { box.hidden = true; msg.textContent = ''; sel.value = prev; };
  $('#' + id + 'AddOk').onclick = () => ctl.commit();
  nm.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nu.focus(); } });
  nu.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ctl.commit(); } });
  nu.addEventListener('input', () => { const d = nu.value.replace(/\D/g, ''); if (d !== nu.value) nu.value = d; msg.textContent = ''; });
  nm.addEventListener('input', () => { msg.textContent = ''; });
  return ctl;
}
// Tap an operator name anywhere: the library shows everything that operator did.
function applyOperatorFilter(key) {
  Object.assign(S.search, { q: '', customerId: '', rigId: '', end: '', stage: '', from: '', to: '', op: key || '' });
  S.showFilters = true; S.scroll['#/'] = 0;
  if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/';
}
function operatorSheet() {
  const m = openModal(`<h3>Who's working?</h3>
    <p class="muted small">Pick your name once — this phone remembers it and puts it on every new photo.</p>
    ${opFieldHTML('sheetOp', currentOperator())}
    <div class="stack form-actions"><button type="button" class="btn primary big block" id="sheetOpDone">Done</button></div>`);
  const ctl = bindOpField('sheetOp', { onChange: (l) => { if (l) rememberOperator(l, true); } });
  $('#sheetOpDone', m).onclick = () => {
    if (ctl.adding && !ctl.commit()) return;
    if (ctl.value) rememberOperator(ctl.value, true);
    closeModal(true); if (!location.hash || location.hash === '#/') renderHome();
  };
  return m;
}

/* ---------- wire: which hardband wire was used on the job ----------
   Stored on each photo as one text value (Supabase column photos.wire, migration 008_wire.sql), e.g. "Duraband NC".
   Common wires are always offered; "＋ Add new wire…" reveals a plain text box (no datalist: iOS crashed on those), the
   typed name joins the pick list on this phone (localStorage) and is selected. Same name, any case = same wire.
   The last wire used is remembered (localStorage) and preset on Start new job and new photos. */
const WIRE_LS = { cur: 'hbp.wire', list: 'hbp.wires' };
const WIRE_COMMON = ['Duraband NC', 'Tuffband NC', 'Arnco 100XT', 'Arnco 150XT', 'Arnco 200XT', 'Arnco 300XT', 'Arnco 350XT', 'Arnco 400XT', 'BoTn 5000', 'Build-up'];
const cleanWire = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
const wireKey = (s) => cleanWire(s).toLowerCase();
const currentWire = () => cleanWire(lsGet(WIRE_LS.cur, ''));
function rememberWire(w, makeCurrent) {
  const v = cleanWire(w); if (!v) return;
  if (!WIRE_COMMON.some((x) => wireKey(x) === wireKey(v))) {
    const list = (lsGet(WIRE_LS.list, []) || []).filter((x) => wireKey(x) !== wireKey(v));
    lsSet(WIRE_LS.list, [v, ...list].slice(0, 100));
  }
  if (makeCurrent) lsSet(WIRE_LS.cur, v);
}
// Common wires first (fixed order), then this phone's custom wires and any found on (shared) photos, A-Z.
function wireRoster() {
  const seen = new Set(WIRE_COMMON.map(wireKey)), extra = [];
  const add = (w) => { const v = cleanWire(w), k = wireKey(v); if (k && !seen.has(k)) { seen.add(k); extra.push(v); } };
  for (const w of lsGet(WIRE_LS.list, []) || []) add(w);
  add(currentWire());
  for (const p of S.photos || []) add(p.wire);
  return [...WIRE_COMMON, ...extra.sort(byText)];
}
const WIRE_INLAY = 'Build-up'; // Inlay photos (repair joints) are welded with Build-up wire
// The joint's normal hardband wire: newest non-deleted, non-Inlay photo of that serial + end with a wire; else the last wire used.
function jointNormalWire(serial, end) {
  const k = serialKey(serial), e = end || '';
  let best = null;
  if (k) for (const x of S.photos) {
    if (x.deletedAt || serialKey(x.serialNumber) !== k || (x.end || '') !== e || stageOf(x) === 'inlay' || !cleanWire(x.wire) || wireKey(x.wire) === wireKey(WIRE_INLAY)) continue;
    if (!best || (x.addedAt || x.createdAt || 0) > (best.addedAt || best.createdAt || 0)) best = x;
  }
  const w = best ? cleanWire(best.wire) : currentWire();
  return wireKey(w) === wireKey(WIRE_INLAY) ? '' : w;
}
const canonWire = (w) => { const k = wireKey(w); return k ? (wireRoster().find((x) => wireKey(x) === k) || cleanWire(w)) : ''; };
function wireFieldHTML(id, value, { wrapId = '', label = 'Wire', blank = '— Pick the wire —' } = {}) {
  const v = canonWire(value), list = wireRoster();
  if (v && !list.includes(v)) list.push(v);
  return `<div class="field wire-field"${wrapId ? ` id="${wrapId}"` : ''}><label for="${id}">${esc(label)}</label>
    <select id="${id}" class="wire-select"><option value="" ${v ? '' : 'selected'}>${esc(blank)}</option><option value="__new">＋ Add new wire…</option>${list.map((w) => `<option value="${esc(w)}" ${w === v ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select>
    <div class="wire-add" id="${id}Add" hidden>
      <input id="${id}New" type="text" maxlength="80" placeholder="Type the wire name" autocapitalize="words" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="done">
      <div class="row op-add-actions"><button type="button" class="btn ghost" id="${id}AddCancel">Cancel</button><button type="button" class="btn primary" id="${id}AddOk">Add wire</button></div>
    </div>
    <div class="small op-msg" id="${id}Msg" role="alert"></div></div>`;
}
function bindWireField(id, { onChange = null } = {}) {
  const sel = $('#' + id), box = $('#' + id + 'Add'), inp = $('#' + id + 'New'), msg = $('#' + id + 'Msg');
  let prev = sel.value === '__new' ? '' : sel.value;
  const choose = (w) => {
    if (w && ![...sel.options].some((o) => o.value === w)) { const o = document.createElement('option'); o.value = w; o.textContent = w; sel.appendChild(o); }
    sel.value = w; prev = w; box.hidden = true; msg.textContent = '';
    if (onChange) onChange(w);
  };
  const ctl = {
    get value() { return sel.value === '__new' ? '' : sel.value; },
    get adding() { return !box.hidden; },
    choose,
    // Put the typed wire in the pick list and select it (same name in any case = the existing one). '' if blank.
    commit() {
      const v = cleanWire(inp.value);
      if (!v) { msg.textContent = 'Type the wire name (or Cancel).'; inp.focus(); return ''; }
      const w = canonWire(v); rememberWire(w); choose(w); return w;
    },
  };
  sel.addEventListener('change', () => {
    msg.textContent = '';
    if (sel.value !== '__new') { prev = sel.value; box.hidden = true; if (onChange) onChange(sel.value); return; }
    inp.value = ''; box.hidden = false; setTimeout(() => inp.focus(), 30);
  });
  $('#' + id + 'AddCancel').onclick = () => { box.hidden = true; msg.textContent = ''; sel.value = prev; };
  $('#' + id + 'AddOk').onclick = () => ctl.commit();
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ctl.commit(); } });
  inp.addEventListener('input', () => { msg.textContent = ''; });
  return ctl;
}

const SEED = {
  customer: { id: 'c_eog', name: 'EOG' },
  rig: { id: 'r_six', name: 'Six', notes: 'Possibly H&P 246 — confirm and rename' },
  spec: { id: 's_45r3_450duo', description: '4-1/2" Range 3, 450 Duo' },
};
async function seedIfNeeded() {
  const m = await db.get('meta', 'seeded');
  if (m) return;
  await db.put('customers', SEED.customer);
  await db.put('rigs', SEED.rig);
  await db.put('pipeSpecs', SEED.spec);
  await db.put('meta', { key: 'lastUsed', value: { customerId: SEED.customer.id, rigId: SEED.rig.id, pipeSpecId: SEED.spec.id } });
  await db.put('meta', { key: 'seeded', value: Date.now() });
}
async function loadAll() {
  const [r, c, s, p, m, x] = await Promise.all([db.all('rigs'), db.all('customers'), db.all('pipeSpecs'), db.all('photos'), db.all('meta'), db.all('rejects')]);
  for (const [kind, list] of [['rigs', r], ['customers', c], ['pipeSpecs', s]]) {
    S[kind] = new Map(list.filter((x) => !x.deletedAt).map((x) => [x.id, x]));
    S.gone[kind] = new Map(list.filter((x) => x.deletedAt).map((x) => [x.id, x]));
  }
  S.photos = p.filter((x) => !x.deletedAt).map((x) => ({ ...x, blob: storedToBlob(x.blob), thumb: storedToBlob(x.thumb) }));
  S.rejects = x.filter((y) => !y.deletedAt);
  S.meta = Object.fromEntries(m.map((x) => [x.key, x.value]));
  urlCache.forEach((u) => URL.revokeObjectURL(u)); urlCache.clear();
}
async function askPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return;
    if (await navigator.storage.persisted()) return;
    const granted = await navigator.storage.persist();
    await setMeta('persist', { at: Date.now(), granted });
  } catch (e) { /* ignore */ }
}

/* ================= images ================= */
const urlCache = new Map();
function thumbUrl(p) {
  let u = urlCache.get(p.id);
  if (!u && (p.thumb || p.blob)) { u = URL.createObjectURL(p.thumb || p.blob); urlCache.set(p.id, u); }
  return u || '';
}
function dropThumb(id) { const u = urlCache.get(id); if (u) { URL.revokeObjectURL(u); urlCache.delete(id); } }
function viewUrl(blob) { const u = URL.createObjectURL(blob); S.viewUrls.push(u); return u; }

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This browser could not read that image format.')); };
    img.src = url;
  });
}
function drawScaled(img, maxEdge, quality) {
  // Modern browsers apply EXIF orientation when drawing <img>, so output is upright.
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const s = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => c.toBlob((b) => { c.width = c.height = 0; b ? resolve({ blob: b, w, h }) : reject(new Error('Image encode failed')); }, 'image/jpeg', quality));
}
// Minimal EXIF reader: DateTimeOriginal (0x9003) → DateTimeDigitized (0x9004) → DateTime (0x0132).
async function exifDate(file) {
  try {
    const buf = await file.slice(0, 262144).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const marker = v.getUint16(o);
      if ((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA) break;
      const len = v.getUint16(o + 2);
      if (marker === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) return parseTiffDate(v, o + 10);
      o += 2 + len;
    }
  } catch (e) { /* ignore */ }
  return null;
}
function parseTiffDate(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (p) => v.getUint16(p, le), u32 = (p) => v.getUint32(p, le);
  const ifd = (off) => {
    const n = u16(t + off), tags = {};
    for (let i = 0; i < n; i++) { const e = t + off + 2 + i * 12; tags[u16(e)] = { count: u32(e + 4), at: e + 8 }; }
    return tags;
  };
  const str = (tag) => { const p = tag.count > 4 ? t + u32(tag.at) : tag.at; let s = ''; for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(p + i)); return s; };
  const ifd0 = ifd(u32(t + 4));
  let ds = null;
  if (ifd0[0x8769]) { const ex = ifd(u32(ifd0[0x8769].at)); if (ex[0x9003]) ds = str(ex[0x9003]); else if (ex[0x9004]) ds = str(ex[0x9004]); }
  if (!ds && ifd0[0x0132]) ds = str(ifd0[0x0132]);
  const m = ds && ds.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) || d.getFullYear() < 1995 ? null : d.getTime();
}
async function processFile(file) {
  const exif = await exifDate(file);
  const img = await loadImage(file);
  const full = await drawScaled(img, 2000, 0.85);
  const th = await drawScaled(img, 400, 0.72);
  const lm = file.lastModified && file.lastModified > 788918400000 && file.lastModified <= Date.now() + 60000 ? file.lastModified : null;
  return { blob: full.blob, thumb: th.blob, width: full.w, height: full.h, createdAt: exif || lm || Date.now(), dateSource: exif ? 'exif' : lm ? 'file' : 'capture', origName: file.name || '' };
}

/* ================= UI plumbing ================= */
const view = $('#view');
// Tap-to-pick suggestions under a text field: plain buttons, used instead of <datalist> (iOS home-screen web apps
// crashed with datalist fields). On focus: the most recent ones; while typing: the ones containing the text. Only the
// small button list is redrawn; the input itself is never replaced, and nothing calls focus() from blur.
function attachPickList(input, box, names) {
  const norm = (x) => String(x || '').trim().toLowerCase();
  let lastSig = null;
  const fill = () => {
    const q = norm(input.value);
    const hits = names.filter((n) => norm(n) !== q && (!q || norm(n).includes(q))).slice(0, 8);
    const sig = hits.join('\0');
    const wantHidden = !hits.length;
    // Skip redundant DOM writes — rewriting pick-list HTML / toggling hidden steals iOS focus.
    if (sig === lastSig && box.hidden === wantHidden) return;
    lastSig = sig;
    const wasFocused = document.activeElement === input;
    const selStart = input.selectionStart, selEnd = input.selectionEnd;
    box.innerHTML = hits.map((n) => `<button type="button" data-pick="${esc(n)}">${esc(n)}</button>`).join('');
    box.hidden = wantHidden;
    // Only restore when the DOM write actually stole focus (iOS). Restoring on every
    // fill clobbers select-all / caret updates from the same keystroke or Playwright fill.
    if (wasFocused && document.activeElement !== input) {
      input.focus({ preventScroll: true });
      try { if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd); } catch (_) {}
    }
  };
  input.addEventListener('focus', fill);
  input.addEventListener('input', fill);
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) box.hidden = true; }, 250));
  box.addEventListener('mousedown', (e) => e.preventDefault()); // tapping a suggestion doesn't move the focus
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    input.value = b.dataset.pick; box.hidden = true; lastSig = null; input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function setChrome({ title, back = null, bottom = true, insp = false }) {
  $('#inspBtn').hidden = !insp;
  document.body.classList.toggle('with-insp-btn', !!(bottom && insp));
  $('#title').textContent = title;
  const bb = $('#backBtn');
  bb.hidden = !back;
  bb.onclick = back ? () => { if (typeof back === 'function') back(); else location.hash = back; } : null;
  $('#bottombar').hidden = !bottom;
  document.body.style.paddingBottom = bottom ? '' : 'calc(24px + env(safe-area-inset-bottom, 0px))';
}
let toastTimer;
// action = { label, fn }: a button inside the toast (e.g. Undo right after logging a reject).
function toast(msg, ms = 2600, action = null) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-btn'; b.id = 'toastAction'; b.textContent = action.label;
    b.onclick = () => { clearTimeout(toastTimer); t.hidden = true; action.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function openModal(html, { locked = false, onCancel = null } = {}) {
  closeModal();
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const back = root.firstElementChild;
  S.modalCancel = onCancel;
  back.addEventListener('click', (e) => { if (e.target === back && !locked) closeModal(); });
  return root.querySelector('.modal');
}
function closeModal(silent) {
  const cb = S.modalCancel; S.modalCancel = null;
  $('#modalRoot').innerHTML = '';
  if (cb && !silent) cb();
}
function confirmBox({ title, msg = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3>${msg ? `<p>${msg}</p>` : ''}
      <div class="row form-actions"><button class="btn ghost" data-a="no" id="confirmNo">${esc(cancel)}</button>
      <button class="btn ${danger ? 'danger solid' : 'primary'}" data-a="yes" id="confirmYes">${esc(ok)}</button></div>`, { onCancel: () => resolve(false) });
    m.addEventListener('click', (e) => { const a = e.target.closest('[data-a]'); if (!a) return; closeModal(true); resolve(a.dataset.a === 'yes'); });
  });
}
function promptBox({ title, fields, ok = 'Save', note = '' }) {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3>${note ? `<p class="muted small">${note}</p>` : ''}
      <form id="promptForm">${fields.map((f, i) => `<div class="field"><label for="pf${i}">${esc(f.label)}</label>
        ${f.multiline ? `<textarea id="pf${i}" name="${f.key}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
        : `<input id="pf${i}" name="${f.key}" type="text" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" ${f.caps ? 'autocapitalize="characters"' : ''}>`}</div>`).join('')}
      <div class="row form-actions"><button type="button" class="btn ghost" data-a="no">Cancel</button><button type="submit" class="btn primary" id="promptOk">${esc(ok)}</button></div></form>`, { onCancel: () => resolve(null) });
    const form = $('#promptForm', m);
    const first = $('input,textarea', form); if (first) setTimeout(() => first.focus(), 50);
    $('[data-a="no"]', m).onclick = () => { closeModal(true); resolve(null); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const out = {}; fields.forEach((f, i) => { out[f.key] = $(`#pf${i}`, m).value.trim(); });
      if (fields[0] && !out[fields[0].key]) { $('#pf0', m).focus(); return; }
      closeModal(true); resolve(out);
    };
  });
}
function busy(text) {
  openModal(`<h3 id="busyText">${esc(text)}</h3><div class="progress"><div id="busyBar"></div></div>`, { locked: true });
  return {
    update: (t, frac) => { const a = $('#busyText'), b = $('#busyBar'); if (a && t) a.textContent = t; if (b && frac != null) b.style.width = Math.round(frac * 100) + '%'; },
    done: () => closeModal(true),
  };
}

/* ================= lookups (rigs / customers / specs) ================= */
async function createLookup(kind, vals) {
  const K = KINDS[kind];
  const name = vals[K.field].trim();
  const dup = sortedItems(kind).find((x) => x[K.field].toLowerCase() === name.toLowerCase());
  if (dup && kind === 'rigs' && dup.closedAt) { await setRigClosed(dup.id, false); toast(`Job "${name}" reopened.`); return dup; }
  if (dup) { toast(`${K.label} "${name}" already exists — selected it.`); return dup; }
  const item = { id: `${K.prefix}_${uid()}`, [K.field]: name, updatedAt: Date.now() };
  if (K.notes) item.notes = vals.notes || '';
  await db.put(K.store, item);
  S[kind].set(item.id, item);
  markDirty(K.store, item.id);
  return item;
}
// Complete job (hbp-v31): a job = a rig folder. Completed rigs (closedAt) leave the open lists and pickers but are never
// deleted; photos still open, export and sync. Synced as rigs.closed_at (009_rigs_closed_at.sql).
async function setRigClosed(id, closed) {
  const it = S.rigs.get(id);
  if (!it) return;
  const upd = { ...it, updatedAt: Date.now() };
  if (closed) upd.closedAt = Date.now(); else delete upd.closedAt;
  await db.put('rigs', upd); S.rigs.set(id, upd);
  markDirty('rigs', id);
  if (closed && S.inspection && S.inspection.rigId === id) endInspection(); // the Start new job session was on this rig
}
async function newLookupDialog(kind) {
  const K = KINDS[kind];
  const fields = [{ key: K.field, label: K.label + (kind === 'pipeSpecs' ? ' (size, range, grade/hardband…)' : ' name'), placeholder: kind === 'pipeSpecs' ? 'e.g. 5" Range 2, 450 Duo' : '' }];
  if (K.notes) fields.push({ key: 'notes', label: 'Notes (optional)', multiline: true });
  const vals = await promptBox({ title: `New ${K.label.toLowerCase()}`, fields, ok: 'Add' });
  if (!vals) return null;
  return createLookup(kind, vals);
}
async function editLookupDialog(kind, id) {
  const K = KINDS[kind];
  const item = S[kind].get(id);
  if (!item) return;
  const n = countUsing(kind, id);
  const m = openModal(`<h3>Edit ${esc(K.label.toLowerCase())}</h3>
    <p class="muted small">${n} photo${n === 1 ? '' : 's'} use this ${esc(K.label.toLowerCase())}. Renaming updates all of them.</p>
    <form id="lkForm">
      <div class="field"><label for="lkName">${K.field === 'description' ? 'Description' : 'Name'}</label>
        <input id="lkName" type="text" value="${esc(item[K.field])}" autocomplete="off"></div>
      ${K.notes ? `<div class="field"><label for="lkNotes">Notes</label><textarea id="lkNotes">${esc(item.notes || '')}</textarea></div>` : ''}
      <div class="stack form-actions">
        <button type="submit" class="btn primary big block" id="lkSave">Save</button>
        ${n === 0 ? `<button type="button" class="btn danger block" id="lkDel">Delete ${esc(K.label.toLowerCase())}</button>`
        : `<p class="muted small">To delete, move its photos first (edit each photo), or rename it to match another ${esc(K.label.toLowerCase())} to merge.</p>`}
        <button type="button" class="btn ghost block" id="lkCancel">Cancel</button>
      </div>
    </form>`);
  $('#lkCancel', m).onclick = () => closeModal(true);
  const del = $('#lkDel', m);
  if (del) del.onclick = async () => {
    if (!(await confirmBox({ title: `Delete "${item[K.field]}"?`, ok: 'Delete', danger: true }))) return;
    await removeLookup(kind, id);
    const lu = S.meta.lastUsed || {};
    if (lu[K.ref] === id) { lu[K.ref] = ''; await setMeta('lastUsed', lu); }
    toast('Deleted'); route();
  };
  $('#lkForm', m).onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#lkName', m).value.trim();
    if (!name) return $('#lkName', m).focus();
    const notes = K.notes ? $('#lkNotes', m).value.trim() : undefined;
    const other = sortedItems(kind).find((x) => x.id !== id && x[K.field].toLowerCase() === name.toLowerCase());
    if (other) {
      closeModal(true);
      const ok = await confirmBox({ title: `Merge into "${other[K.field]}"?`, ok: 'Merge',
        msg: `A ${esc(K.label.toLowerCase())} named "${esc(other[K.field])}" already exists. Move all ${n} photo(s) from "${esc(item[K.field])}" into it and remove "${esc(item[K.field])}"?` });
      if (!ok) return;
      await mergeLookup(kind, id, other.id, notes);
      toast(`Merged into ${other[K.field]}`); route(); return;
    }
    const upd = { ...item, [K.field]: name, updatedAt: Date.now() };
    if (K.notes) upd.notes = notes;
    await db.put(K.store, upd); S[kind].set(id, upd); markDirty(K.store, id);
    closeModal(true); toast('Saved — all photos updated'); route();
  };
}
async function mergeLookup(kind, fromId, toId, notes) {
  const K = KINDS[kind];
  for (const p of S.photos.filter((x) => x[K.ref] === fromId)) { p[K.ref] = toId; p.updatedAt = Date.now(); await putPhoto(p); markDirty('photos', p.id); }
  const target = S[kind].get(toId);
  if (K.notes && !target.notes && notes) { target.notes = notes; target.updatedAt = Date.now(); await db.put(K.store, target); markDirty(K.store, toId); }
  await removeLookup(kind, fromId, toId);
  const lu = S.meta.lastUsed || {};
  if (lu[K.ref] === fromId) { lu[K.ref] = toId; await setMeta('lastUsed', lu); }
}

// Local-only mode: really delete (as before). Team mode: keep a tombstone so the delete reaches other phones
// and nothing is hard-deleted on the server.
async function removeLookup(kind, id, mergedInto) {
  const K = KINDS[kind], item = S[kind].get(id);
  S[kind].delete(id);
  if (!HB_CFG.on || !item) { await db.del(K.store, id); return; }
  const tomb = { ...item, deletedAt: Date.now(), updatedAt: Date.now() };
  if (mergedInto) tomb.mergedInto = mergedInto;
  await db.put(K.store, tomb); S.gone[kind].set(id, tomb); markDirty(K.store, id);
}
async function removePhoto(p) {
  S.photos = S.photos.filter((x) => x.id !== p.id);
  dropThumb(p.id);
  if (!HB_CFG.on) { await db.del('photos', p.id); return; }
  p.deletedAt = Date.now(); p.updatedAt = p.deletedAt;
  await putPhoto(p); markDirty('photos', p.id); // file is uploaded first (if needed), then freed on this phone
}
// Re-draw the current screen after a background sync, unless the user is in the middle of something.
function softRefresh() {
  ensurePipeSpecs().catch((e) => console.warn('pipe specs', e)); // team sync may have brought in specs to map / rename
  const h = location.hash;
  const ae = document.activeElement;
  if ($('#modalRoot').innerHTML || /^#\/(add|edit|saved)/.test(h) || (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) { S.staleView = true; return; }
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}

/* ================= router ================= */
function route() {
  closeModal(true);
  S.staleView = false;
  S.viewUrls.forEach((u) => URL.revokeObjectURL(u)); S.viewUrls = [];
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((x) => decodeURIComponent(x));
  const v = parts[0] || '';
  if (v !== 'saved') S.keepJoint = false; // pendingKeep/pendingStage survive until handleFiles (camera return races)
  if (v === '' && S.inspection) endInspection(); // leaving back to home finishes the inspection
  drawInspBar(v);
  try {
    if (v === '') renderHome();
    else if (v === 'folder') renderFolder(parts[1], parts[2]);
    else if (v === 'photo') renderPhoto(parts[1]);
    else if (v === 'compare') renderCompare(parts[1], parts[2]);
    else if (v === 'edit') renderForm('edit', parts[1]);
    else if (v === 'add') renderForm('add');
    else if (v === 'saved') renderSaved();
    else if (v === 'tools') renderTools();
    else if (v === 'manage') renderManage(parts[1]);
    else if (v === 'backup') renderBackup();
    else if (v === 'rejects') renderRejects(parts[1]);
    else { location.hash = '#/'; return; }
  } catch (e) { console.error(e); view.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; }
  window.scrollTo(0, S.scroll[location.hash] || 0);
}
window.addEventListener('hashchange', (e) => {
  try { S.scroll[new URL(e.oldURL).hash || '#/'] = window.scrollY; } catch (_) { /* ignore */ }
  route();
});

/* ================= home: folders + search ================= */
const hasSearch = () => { const s = S.search; return !!(s.q.trim() || s.customerId || s.rigId || s.end || s.stage || s.op || s.from || s.to); };
const filterCount = () => { const s = S.search; return [s.op, s.customerId, s.rigId, s.end, s.stage, s.from, s.to].filter(Boolean).length; };
function haystack(p) {
  return [labelOf('customers', p.customerId), labelOf('rigs', p.rigId), (S.rigs.get(p.rigId) || {}).notes, labelOf('pipeSpecs', p.pipeSpecId),
    p.serialNumber, p.end, p.bandNumber ? 'B' + p.bandNumber : '', p.notes, isoDay(p.createdAt), STAGES[stageOf(p)].words, cleanOp(p.operator), p.wire || ''].join(' \u0001 ').toLowerCase();
}
function searchPhotos() {
  const s = S.search;
  const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
  return S.photos.filter((p) => {
    if (s.customerId && p.customerId !== s.customerId) return false;
    if (s.rigId && p.rigId !== s.rigId) return false;
    if (s.end && p.end !== s.end) return false;
    if (s.stage && stageOf(p) !== s.stage) return false;
    if (s.op && (s.op === '__none' ? !!opKey(p.operator) : opKey(p.operator) !== s.op)) return false;
    const d = isoDay(p.createdAt);
    if (s.from && d < s.from) return false;
    if (s.to && d > s.to) return false;
    if (!terms.length) return true;
    const h = haystack(p);
    return terms.every((t) => h.includes(t));
  }).sort((a, b) => b.createdAt - a.createdAt);
}
const bandText = (p) => [p.end || '', p.bandNumber ? (p.bandNumber === 'All' ? 'whole' : 'B' + p.bandNumber) : ''].filter(Boolean).join(' ');
function tileHTML(p, showFolder) {
  const cap = [p.serialNumber || 'no SN', bandText(p)].filter(Boolean).join(' · ');
  const sub = showFolder ? `${labelOf('rigs', p.rigId)} · ${fmtShort(p.createdAt)}` : fmtShort(p.createdAt);
  return `<a class="tile" href="#/photo/${encodeURIComponent(p.id)}" data-id="${esc(p.id)}"><img loading="lazy" src="${thumbUrl(p)}" alt="${esc(cap)}">${stageBadge(p, 'on-tile')}<span class="cap">${esc(cap)}<span class="cap2">${esc(sub)}</span></span></a>`;
}
// Operator filter: All, Unassigned, then every operator found on the records or rejects (one entry per number),
// each with its photo count and reject count.
function opFilterList() {
  const roster = new Map(operatorRoster().map((o) => [o.key, o.label])), found = new Map(), seen = new Map();
  const slot = (k, label) => { if (!found.has(k)) found.set(k, { n: 0, r: 0 }); if (!seen.has(k)) seen.set(k, cleanOp(label)); return found.get(k); };
  let none = 0;
  for (const p of S.photos) { const k = opKey(p.operator); if (!k) { none++; continue; } slot(k, p.operator).n++; }
  const rc = rejectCounts();
  for (const [k, n] of rc.m) slot(k, rc.label.get(k)).r = n;
  const list = [...found.entries()].map(([key, c]) => ({ key, n: c.n, r: c.r, label: roster.get(key) || seen.get(key) }));
  return { list: list.sort((a, b) => byText(a.label, b.label)), none, noneR: rc.none };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const countsText = (n, r) => plural(n, 'photo') + (r ? ', ' + plural(r, 'reject') : '');
function opFilterOpts(sel) {
  const { list, none, noneR } = opFilterList();
  if (sel && sel !== '__none' && !list.some((o) => o.key === sel)) list.push({ key: sel, n: 0, r: 0, label: (operatorRoster().find((o) => o.key === sel) || {}).label || sel.slice(2) });
  return `<option value="">All operators</option><option value="__none" ${sel === '__none' ? 'selected' : ''}>Unassigned (no operator)${none || noneR ? ` — ${countsText(none, noneR)}` : ''}</option>` +
    list.map((o) => `<option value="${esc(o.key)}" ${o.key === sel ? 'selected' : ''}>${esc(o.label)} — ${countsText(o.n, o.r)}</option>`).join('');
}
const opFilterLabel = (key) => (key === '__none' ? 'No operator' : (opFilterList().list.find((o) => o.key === key) || operatorRoster().find((o) => o.key === key) || { label: key.slice(2) }).label);
const opts = (kind, sel, blank, openOnly = false) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
  sortedItems(kind).filter((x) => !(openOnly && kind === 'rigs' && x.closedAt && x.id !== sel)).map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x[KINDS[kind].field])}</option>`).join('');

function renderHome() {
  S.lastListHash = '#/'; S.context = null;
  setChrome({ title: 'Hardband Photos', bottom: true, insp: true });
  const s = S.search, fc = filterCount();
  const curOp = currentOperator();
  view.innerHTML = `
    <button type="button" id="opChip" class="op-chip${curOp ? '' : ' unset'}" aria-label="Operator on this phone">👷 <span class="op-chip-l">Operator:</span> <b id="opChipName">${esc(curOp || 'Tap to pick your name')}</b> <span class="op-chip-c">▾</span></button>
    <button type="button" id="rejectBtn" class="btn reject-btn big block">⛔ Log rejected wire</button>
    <a class="btn ghost block" id="homeToolsBtn" href="#/tools">🧰 Tools (add from library, open folder)</a>
    ${rejectSummaryHTML(curOp)}
    <div class="searchbar">
      <input id="q" type="search" placeholder="Search serial, rig, notes…" value="${esc(s.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search">
      <button id="filterBtn" class="btn ghost" aria-expanded="${S.showFilters}">Filter${fc ? `<span class="chip-count">${fc}</span>` : ''}</button>
    </div>
    <div id="filters" class="filters card" ${S.showFilters ? '' : 'hidden'}>
      <div class="full"><label for="fO">Operator</label><select id="fO">${opFilterOpts(s.op)}</select>
        <a class="rej-link" id="rejectsLink" href="#/rejects">⛔ Rejects by operator <span class="rej-n" id="rejectsLinkN">${S.rejects.length}</span> <span class="chev">›</span></a></div>
      <div><label for="fC">Customer</label><select id="fC">${opts('customers', s.customerId, 'Any customer')}</select></div>
      <div><label for="fR">Rig</label><select id="fR">${opts('rigs', s.rigId, 'Any rig')}</select></div>
      <div><label for="fE">End</label><select id="fE"><option value="">Box or Pin</option><option ${s.end === 'Box' ? 'selected' : ''}>Box</option><option ${s.end === 'Pin' ? 'selected' : ''}>Pin</option></select></div>
      <div><label for="fS">Stage</label><select id="fS"><option value="">Any stage</option><option value="pre" ${s.stage === 'pre' ? 'selected' : ''}>Before</option><option value="repair" ${s.stage === 'repair' ? 'selected' : ''}>Repair</option><option value="plasma" ${s.stage === 'plasma' ? 'selected' : ''}>Plasma cut</option><option value="inlay" ${s.stage === 'inlay' ? 'selected' : ''}>Inlay</option><option value="preheat" ${s.stage === 'preheat' ? 'selected' : ''}>Preheat</option><option value="post" ${s.stage === 'post' ? 'selected' : ''}>After</option></select></div>
      <div><label for="fFrom">From date</label><input id="fFrom" type="date" value="${esc(s.from)}"></div>
      <div><label for="fTo">To date</label><input id="fTo" type="date" value="${esc(s.to)}"></div>
      <button id="fClear" class="btn ghost full">Clear search &amp; filters</button>
    </div>
    <div id="banner"></div>
    <div id="homeBody"></div>`;
  const q = $('#q');
  q.addEventListener('input', () => { s.q = q.value; renderHomeBody(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
  $('#filterBtn').onclick = () => { S.showFilters = !S.showFilters; $('#filters').hidden = !S.showFilters; $('#filterBtn').setAttribute('aria-expanded', S.showFilters); };
  const bind = (id, key) => { $(id).addEventListener('change', (e) => { s[key] = e.target.value; renderHome(); }); };
  bind('#fO', 'op'); bind('#fC', 'customerId'); bind('#fR', 'rigId'); bind('#fE', 'end'); bind('#fS', 'stage'); bind('#fFrom', 'from'); bind('#fTo', 'to');
  $('#fClear').onclick = () => { Object.assign(s, { q: '', customerId: '', rigId: '', end: '', stage: '', op: '', from: '', to: '' }); renderHome(); };
  $('#opChip').onclick = operatorSheet;
  $('#rejectBtn').onclick = logRejectSheet;
  renderBanner();
  renderHomeBody();
}
function renderBanner() {
  const el = $('#banner'); if (!el) return;
  const html = [];
  if (isIOS && !isStandalone() && !S.meta.hideInstallTip) {
    html.push(`<div class="banner" id="installTip"><span>📲</span><span style="flex:1">Add to Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b>, then use the icon. Photos saved here in Safari stay separate from the Home Screen app.</span><button class="btn ghost" id="hideTip" style="min-height:44px">OK</button></div>`);
  }
  const last = (S.meta.lastExport || {}).at || 0;
  const unbacked = S.photos.filter((p) => (p.addedAt || p.createdAt) > last && !p.remoteImage);
  if (unbacked.length) {
    const oldest = Math.min(...unbacked.map((p) => p.addedAt || p.createdAt));
    const age = Date.now() - (last || oldest);
    if (unbacked.length >= 20 || age > 3 * 864e5) html.push(`<div class="banner" id="backupNag"><span>💾</span><span style="flex:1">${unbacked.length} photo${unbacked.length === 1 ? '' : 's'} not backed up. <a href="#/backup">Back up now</a></span></div>`);
  }
  el.innerHTML = html.join('');
  const h = $('#hideTip'); if (h) h.onclick = async () => { await setMeta('hideInstallTip', true); renderBanner(); };
}
function renderHomeBody() {
  const body = $('#homeBody'); if (!body) return;
  if (hasSearch()) {
    const res = searchPhotos();
    S.lastList = res.map((p) => p.id);
    const opNote = S.search.op ? ` · <span id="resultOp">${S.search.op === '__none' ? 'no operator' : '👷 ' + esc(opFilterLabel(S.search.op))}</span> <button type="button" class="btn ghost op-clear" id="opClear">✕ All operators</button>` : '';
    const nRej = S.search.op ? rejectsOf(S.search.op).length : 0;
    const rejNote = S.search.op ? (nRej ? `<a class="rej-link" id="opRejects" href="#/rejects/${encodeURIComponent(S.search.op)}">⛔ ${plural(nRej, 'reject')} logged <span class="chev">›</span></a>`
      : '<div class="muted small rej-none" id="opRejects">⛔ No rejects logged</div>') : '';
    body.innerHTML = `<div class="result-count" id="resultCount">${res.length} photo${res.length === 1 ? '' : 's'} found${opNote}</div>${rejNote}` +
      (res.length ? `<div class="grid" id="results">${res.map((p) => tileHTML(p, true)).join('')}</div>` : `<div class="empty">No matches.</div>`);
    const oc = $('#opClear'); if (oc) oc.onclick = () => { S.search.op = ''; renderHome(); };
    return;
  }
  if (!S.photos.length) {
    body.innerHTML = `<div class="empty"><div class="big-emoji">🔩</div><p><b>No photos yet.</b></p><p>Tap <b>📷 Take Photo</b> below. Photos default to <b>${esc(labelOf('customers', (S.meta.lastUsed || {}).customerId) || '—')} / ${esc(labelOf('rigs', (S.meta.lastUsed || {}).rigId) || '—')}</b>.</p></div>`;
    return;
  }
  const groups = new Map();
  for (const p of S.photos) {
    const ck = p.customerId || '', rk = p.rigId || '';
    if (!groups.has(ck)) groups.set(ck, new Map());
    const g = groups.get(ck);
    if (!g.has(rk)) g.set(rk, []);
    g.get(rk).push(p);
  }
  const custs = [...groups.keys()].sort((a, b) => byText(labelOf('customers', a) || '~', labelOf('customers', b) || '~'));
  const isClosed = (rk) => !!(S.rigs.get(rk) || {}).closedAt;
  const nClosed = custs.reduce((n, ck) => n + [...groups.get(ck).keys()].filter(isClosed).length, 0);
  const section = (closed) => custs.map((ck) => {
    const rigs = new Map([...groups.get(ck)].filter(([rk]) => isClosed(rk) === closed));
    if (!rigs.size) return '';
    const total = [...rigs.values()].reduce((n, a) => n + a.length, 0);
    const rows = [...rigs.keys()].sort((a, b) => byText(labelOf('rigs', a) || '~', labelOf('rigs', b) || '~')).map((rk) => {
      const list = rigs.get(rk).slice().sort((a, b) => b.createdAt - a.createdAt);
      const rig = S.rigs.get(rk) || {};
      const joints = new Set(list.map((p) => p.serialNumber || '')).size;
      return `<a class="folder" href="#/folder/${encodeURIComponent(ck)}/${encodeURIComponent(rk)}" data-rig="${esc(rig.name || '')}">
        <img src="${thumbUrl(list[0])}" alt="">
        <div class="meta"><b>📁 ${esc(rig.name || 'No rig')}</b>${closed ? ' <span class="done-tag">✅ Completed</span>' : ''}
          <small>${list.length} photo${list.length === 1 ? '' : 's'} · ${joints} joint${joints === 1 ? '' : 's'} · last ${fmtShort(list[0].createdAt)}</small>
          ${rig.notes ? `<small>${esc(rig.notes)}</small>` : ''}</div>
        <span class="chev">›</span></a>`;
    }).join('');
    return `<h2 class="cust-head">${esc(labelOf('customers', ck) || 'No customer')} <span class="count">${total}</span></h2>${rows}`;
  }).join('');
  body.innerHTML = (section(false) || '<div class="empty">No open jobs.</div>')
    + (nClosed ? `<button type="button" class="btn ghost block" id="showClosedBtn" style="margin-top:14px">${S.showClosed ? 'Hide' : 'Show'} completed jobs (${nClosed})</button>`
      + (S.showClosed ? `<div id="closedJobs"><h2 class="cust-head">✅ Completed jobs</h2>${section(true)}</div>` : '') : '');
  const sc = $('#showClosedBtn'); if (sc) sc.onclick = () => { S.showClosed = !S.showClosed; renderHomeBody(); };
}

/* ================= folder ================= */
function folderPhotos(ck, rk) { return S.photos.filter((p) => (p.customerId || '') === (ck || '') && (p.rigId || '') === (rk || '')); }
// Same joint = same serial ignoring case and spaces ("xj 778" = "XJ778").
const serialKey = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
function jointGroups(list) {
  const m = new Map();
  for (const p of list) { const k = serialKey(p.serialNumber); if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  const endOrd = { Box: 0, Pin: 1 }, stOrd = { pre: 0, repair: 1, plasma: 2, inlay: 3, preheat: 4, post: 5 };
  const groups = [...m.entries()].map(([key, ps]) => ({ key, sn: ps.slice().sort((a, b) => b.createdAt - a.createdAt)[0].serialNumber || '',
    ps: ps.sort((a, b) => stOrd[stageOf(a)] - stOrd[stageOf(b)] || (endOrd[a.end] ?? 2) - (endOrd[b.end] ?? 2) || String(a.bandNumber).localeCompare(String(b.bandNumber)) || a.createdAt - b.createdAt), latest: Math.max(...ps.map((p) => p.createdAt)) }));
  return groups.sort((a, b) => b.latest - a.latest);
}
// Before / After photos of one joint (all folders), newest first. null if the serial is blank.
function jointStages(sn) {
  const k = serialKey(sn);
  if (!k) return null;
  const all = S.photos.filter((x) => serialKey(x.serialNumber) === k).sort((a, b) => b.createdAt - a.createdAt);
  return { pre: all.filter((x) => stageOf(x) === 'pre'), post: all.filter((x) => stageOf(x) === 'post') };
}
// Compare link for a photo: this photo on its side, the newest photo of the other stage on the other side.
function compareHash(p) {
  const j = jointStages(p.serialNumber);
  if (!j || !j.pre.length || !j.post.length) return '';
  const pre = stageOf(p) === 'pre' ? p : j.pre[0], post = stageOf(p) === 'post' ? p : j.post[0];
  return `#/compare/${encodeURIComponent(pre.id)}/${encodeURIComponent(post.id)}`;
}
function renderFolder(ck, rk) {
  const list = folderPhotos(ck, rk);
  const rig = S.rigs.get(rk);
  S.context = { customerId: ck, rigId: rk };
  S.lastListHash = location.hash;
  setChrome({ title: `${labelOf('customers', ck) || 'No customer'} / ${rig ? rig.name : 'No rig'}`, back: '#/', bottom: false }); // hbp-v32: Next joint in the card covers capture
  const groups = jointGroups(list);
  S.lastList = groups.flatMap((g) => g.ps.map((p) => p.id));
  view.innerHTML = `
    <div class="card">
      <div class="folder-head"><div class="folder-head-l"><div class="muted small">${esc(labelOf('customers', ck) || 'No customer')}</div>
      <div style="font-size:22px;font-weight:800" id="folderRigName">${esc(rig ? rig.name : 'No rig')}</div></div>
      ${rig && !rig.closedAt ? `<button type="button" class="btn ghost complete-mini" id="completeJobBtn" aria-label="Complete job">✅ Complete</button>` : ''}</div>
      ${rig && rig.notes ? `<div class="muted small" style="margin-top:4px">${esc(rig.notes)}</div>` : ''}
      <div class="muted small" style="margin-top:6px">${list.length} photo${list.length === 1 ? '' : 's'} · ${groups.length} joint${groups.length === 1 ? '' : 's'}${list.length ? ` <span id="folderStages">${folderStageSummary(list)}</span>` : ''}. New photos taken here go in this folder.</div>
      ${rig && rig.closedAt ? `<div class="done-tag" id="folderClosed" style="margin-top:8px">✅ Completed ${esc(fmtShort(rig.closedAt))}</div>` : ''}
      <label for="camInput" class="btn primary big block" data-keep="0" id="folderNextJointBtn" style="margin-top:10px">📷 Next joint</label>
      ${rig && rig.closedAt ? `<button class="btn secondary block" id="reopenJobBtn" style="margin-top:8px">↩ Reopen job</button>` : ''}
    </div>
    ${list.length ? groups.map((g) => { const ch = g.key ? compareHash(g.ps.find((x) => stageOf(x) === 'post') || g.ps[0]) : ''; return `<div class="sn-head">${g.sn ? 'SN ' + esc(g.sn) : 'No serial number'} <span class="muted">(${g.ps.length})</span>${ch ? ` <a class="pair-mark" href="${ch}" title="Before and After photos — compare" aria-label="Compare Before / After">⇄</a>` : ''}</div>
      <div class="grid">${g.ps.map((p) => tileHTML(p, false)).join('')}</div>`; }).join('') : '<div class="empty">No photos in this folder.</div>'}`;
  // Next joint into this folder (S.context = this customer / rig), starts as Before. Armed like the Saved screen's CTAs.
  const nj = $('#folderNextJointBtn'), armNj = () => { armKeepFromEl(nj); S.keepFrom = null; };
  nj.addEventListener('pointerdown', armNj); nj.addEventListener('touchstart', armNj, { passive: true }); nj.addEventListener('click', armNj);
  const cj = $('#completeJobBtn');
  if (cj) cj.onclick = async () => {
    const ask = confirmBox({ title: `Mark ${rig.name} complete?`, msg: 'Its photos stay saved; it just moves off the open list.', ok: 'Complete' });
    setTimeout(() => { const no = $('#confirmNo'); if (no) no.focus(); }, 0); // Cancel is the default
    if (!(await ask)) return;
    await setRigClosed(rk, true); toast(`${rig.name} completed`); route();
  };
  const rj = $('#reopenJobBtn');
  if (rj) rj.onclick = async () => { await setRigClosed(rk, false); toast(`${rig.name} reopened`); route(); };
}

/* ================= photo detail ================= */
function renderPhoto(id) {
  const p = S.photos.find((x) => x.id === id);
  if (!p) { setChrome({ title: 'Photo', back: S.lastListHash, bottom: true }); view.innerHTML = '<div class="empty">Photo not found.</div>'; return; }
  const folderHash = `#/folder/${encodeURIComponent(p.customerId || '')}/${encodeURIComponent(p.rigId || '')}`;
  let list = S.lastList.includes(id) ? S.lastList : jointGroups(folderPhotos(p.customerId, p.rigId)).flatMap((g) => g.ps.map((x) => x.id));
  const i = list.indexOf(id);
  const prev = i > 0 ? list[i - 1] : null, next = i >= 0 && i < list.length - 1 ? list[i + 1] : null;
  setChrome({ title: p.serialNumber ? `SN ${p.serialNumber}` : 'Photo', back: S.lastListHash && S.lastListHash !== location.hash ? S.lastListHash : folderHash, bottom: false });
  const rig = S.rigs.get(p.rigId) || {};
  const canShare = !!(navigator.canShare && window.File);
  const capHTML = detailCaptureHTML(p);
  view.innerHTML = `
    <img class="detail-img" id="detailImg" src="${p.blob ? viewUrl(p.blob) : p.thumb ? viewUrl(p.thumb) : ''}" alt="Hardband photo">
    ${p.blob ? '' : `<p class="muted small" id="fullNote" style="text-align:center">Loading full-size photo…</p>`}
    <div class="pager">
      <a class="btn ghost" ${prev ? `href="#/photo/${encodeURIComponent(prev)}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>‹ Prev</a>
      <span class="muted small" style="flex:0 0 auto;align-self:center">${i + 1} / ${list.length}</span>
      <a class="btn ghost" ${next ? `href="#/photo/${encodeURIComponent(next)}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>Next ›</a>
    </div>
    <div class="card" style="margin-top:12px">
      <dl class="kv" id="detailFields">
        <dt>Stage</dt><dd id="detailStage">${stageBadge(p)} ${esc(STAGES[stageOf(p)].label)}</dd>
        <dt>Operator</dt><dd id="detailOp">${opLinkHTML(p)}</dd>
        <dt>Customer</dt><dd>${esc(labelOf('customers', p.customerId) || '—')}</dd>
        <dt>Rig</dt><dd>${esc(rig.name || '—')}${rig.notes ? `<div class="muted small">${esc(rig.notes)}</div>` : ''}</dd>
        <dt>Pipe spec</dt><dd>${esc(labelOf('pipeSpecs', p.pipeSpecId) || '—')}</dd>
        <dt>Wire</dt><dd id="detailWire">${esc(p.wire || '—')}</dd>
        <dt>Serial #</dt><dd>${esc(p.serialNumber || '—')}</dd>
        <dt>End</dt><dd>${esc(p.end || '—')}</dd>
        <dt>Band</dt><dd>${p.bandNumber ? (p.bandNumber === 'All' ? 'All / whole connection' : 'Band ' + esc(p.bandNumber)) : '—'}</dd>
        <dt>Condition</dt><dd style="white-space:pre-wrap">${esc(p.notes || '—')}</dd>
        <dt>Taken</dt><dd>${fmtDate(p.createdAt)}${p.dateSource === 'capture' ? ' <span class="muted small">(save time)</span>' : ''}</dd>
      </dl>
    </div>
    <div class="stack form-actions">
      ${compareHash(p) ? `<a class="btn secondary block" id="compareBtn" href="${compareHash(p)}">⇄ Compare Before / After</a>` : ''}
      ${capHTML}
      <a class="btn ${capHTML ? 'secondary' : 'primary big'} block" id="editBtn" href="#/edit/${encodeURIComponent(p.id)}">✎ Edit details / move</a>
      ${canShare ? '<button class="btn secondary block" id="shareBtn">⇪ Share / save to Photos</button>' : ''}
      <a class="btn ghost block" href="${folderHash}">📁 Open folder</a>
      <button class="btn danger block" id="delBtn">🗑 Delete photo</button>
    </div>`;
  // Same arming as the Saved-screen CTAs (pointerdown/touchstart fire before the camera sheet steals the page).
  $$('#detailCapture [data-keep]').forEach((l) => {
    const arm = () => armKeepFromEl(l);
    l.addEventListener('pointerdown', arm);
    l.addEventListener('touchstart', arm, { passive: true });
    l.addEventListener('click', arm);
  });
  if (!p.blob) {
    Sync.ensureBlob(p).then((b) => {
      if (location.hash !== `#/photo/${encodeURIComponent(p.id)}`) return;
      const note = $('#fullNote');
      if (!b) { if (note) note.textContent = 'Full-size photo will download when you are online and signed in.'; return; }
      $('#detailImg').src = viewUrl(b); if (note) note.remove();
    }).catch(() => { const note = $('#fullNote'); if (note) note.textContent = 'Full-size photo will download when you are online.'; });
  }
  const sb = $('#shareBtn');
  if (sb) sb.onclick = async () => {
    const blob = p.blob || await Sync.ensureBlob(p).catch(() => null);
    if (!blob) return toast('Full-size photo not downloaded yet — try again when online.');
    const f = new File([blob], exportFileName(p), { type: 'image/jpeg' });
    if (!navigator.canShare({ files: [f] })) return toast('Sharing files is not supported here.');
    try { await navigator.share({ files: [f], title: exportFileName(p) }); } catch (e) { /* cancelled */ }
  };
  $('#delBtn').onclick = async () => {
    const msg = Sync.on ? 'This removes it from the team library on every phone. (A copy is kept on the team server.)' : 'This permanently removes it from this device. It cannot be undone (unless it is in a backup ZIP).';
    if (!(await confirmBox({ title: 'Delete this photo?', msg, ok: 'Delete', danger: true }))) return;
    await removePhoto(p);
    S.lastList = S.lastList.filter((x) => x !== p.id);
    toast('Photo deleted');
    location.hash = folderPhotos(p.customerId, p.rigId).length ? folderHash : '#/';
  };
}

// Photo detail: camera buttons for this joint's missing stages (hbp-v27). Changing Stage in Edit only relabels the photo,
// and the bottom Take Photo bar is hidden here, so this is the capture path from a saved photo (D13 / HP 249).
// Repairs are done in BATCHES (Befores on every joint, then all plasma cuts, then inlays, then Afters), so every stage the
// joint (same serial + end, non-deleted photos) has no photo of yet gets a button — not just "next after this photo".
//   repair joint: Plasma cut → Inlay → After (Plasma cut prominent while missing; the Before is the repair picture)
//   normal joint: Before → Preheat → After
// Each button copies the joint's details from photo p (data-from) and forces its stage; nothing depends on S.lastSaved.
function jointMissingStages(p) {
  if (!p || !p.serialNumber) return [];
  const repair = isRepairJoint(p.notes, p.serialNumber, p.end), have = jointStageSet(p.serialNumber, p.end);
  return (repair ? ['plasma', 'inlay', 'post'] : PLAIN_SEQ).filter((st) => !have.has(st)); // no Repair button: Before = repair picture
}
const CAP_ID = { pre: 'Pre', preheat: 'Preheat', repair: 'Repair', plasma: 'Plasma', inlay: 'Inlay', post: 'After' };
const CAP_NAME = { pre: 'Before', preheat: 'Preheat', repair: 'Repair', plasma: 'Plasma cut', inlay: 'Inlay', post: 'After' };
function jointCaptureButtons(p, prefix) {
  const list = jointMissingStages(p);
  if (!list.length) return '';
  const snTxt = ` (SN ${esc(p.serialNumber)})`, primary = list.includes('plasma') ? 'plasma' : list[0];
  return list.map((stg) => `<label for="camInput" class="btn ${stg === primary ? 'primary big' : 'secondary'} block" data-keep="1" data-stage="${stg}" data-from="${esc(p.id)}" id="${prefix}${CAP_ID[stg]}Btn">${stg === 'plasma' ? '🔥' : '📷'} ${esc(CAP_NAME[stg])} photo${snTxt}</label>`).join('');
}
function detailCaptureHTML(p) {
  const btns = jointCaptureButtons(p, 'detail');
  return btns ? `<div class="stack" id="detailCapture"><p class="muted small" id="detailNextHint">Take a picture for this joint:</p>${btns}</div>` : '';
}

/* ================= Before / After comparison ================= */
function renderCompare(preId, postId) {
  const pre = S.photos.find((x) => x.id === preId), post = S.photos.find((x) => x.id === postId);
  const back = () => { if (history.length > 1) history.back(); else location.hash = '#/'; };
  if (!pre || !post) { setChrome({ title: 'Compare', back, bottom: false }); view.innerHTML = '<div class="empty">Photo not found.</div>'; return; }
  const j = jointStages(pre.serialNumber) || { pre: [pre], post: [post] };
  if (!j.pre.includes(pre)) j.pre.unshift(pre);
  if (!j.post.includes(post)) j.post.unshift(post);
  setChrome({ title: pre.serialNumber || post.serialNumber ? `⇄ SN ${post.serialNumber || pre.serialNumber}` : 'Compare', back, bottom: false });
  const panel = (p, st) => {
    const list = j[st], i = list.indexOf(p), rig = S.rigs.get(p.rigId) || S.gone.rigs.get(p.rigId) || {};
    const src = p.blob ? viewUrl(p.blob) : p.thumb ? viewUrl(p.thumb) : '';
    return `<section class="cmp-panel" id="cmp-${st}" data-id="${esc(p.id)}">
      <div class="cmp-label">${stageBadge({ stage: st }, 'big')} <span>${st === 'pre' ? 'Before hardband' : 'After hardband'}</span></div>
      <a href="#/photo/${encodeURIComponent(p.id)}"><img class="cmp-img" id="cmpImg-${st}" src="${src}" alt="${st === 'pre' ? 'Before' : 'After'} hardband photo"></a>
      ${list.length > 1 ? `<div class="cmp-swap"><span class="muted small" id="cmpCount-${st}">${i + 1} of ${list.length} ${st === 'pre' ? 'Before' : 'After'} photos</span>
        <button type="button" class="btn ghost" data-swap="${st}" id="cmpSwap-${st}">⇆ Show ${i + 1 < list.length ? 'older' : 'newest'}</button></div>` : ''}
      <dl class="kv cmp-kv">
        <dt>Serial #</dt><dd>${esc(p.serialNumber || '—')}</dd>
        <dt>Rig</dt><dd>${esc(rig.name || '—')}</dd>
        <dt>Customer</dt><dd>${esc(labelOf('customers', p.customerId) || '—')}</dd>
        <dt>Operator</dt><dd class="cmp-op">${opLinkHTML(p)}</dd>
        <dt>Taken</dt><dd>${fmtDate(p.createdAt)}</dd>
        <dt>Where</dt><dd>${esc(bandText(p) || '—')}</dd>
        <dt>Condition</dt><dd class="cmp-notes">${esc(p.notes || '—')}</dd>
      </dl></section>`;
  };
  view.innerHTML = `<div class="compare" id="compare">${panel(pre, 'pre')}${panel(post, 'post')}</div>
    <div class="stack form-actions">
      <button class="btn primary big block" id="shareCmpBtn">⇪ Share / Save comparison</button>
    </div>`;
  for (const [p, st] of [[pre, 'pre'], [post, 'post']]) {
    if (p.blob) continue;
    Sync.ensureBlob(p).then((b) => { const im = $(`#cmpImg-${st}`); if (b && im && location.hash.startsWith('#/compare/')) im.src = viewUrl(b); }).catch(() => {});
  }
  $('#compare').onclick = (e) => {
    const b = e.target.closest('[data-swap]'); if (!b) return;
    const st = b.dataset.swap, list = j[st], cur = st === 'pre' ? pre : post;
    const nxt = list[(list.indexOf(cur) + 1) % list.length];
    const ids = st === 'pre' ? [nxt.id, post.id] : [pre.id, nxt.id];
    history.replaceState(null, '', `#/compare/${ids.map(encodeURIComponent).join('/')}`);
    renderCompare(...ids);
  };
  $('#shareCmpBtn').onclick = () => shareComparison(pre, post);
}
function wrapText(ctx, text, maxW, maxLines) {
  const out = [];
  for (const para of String(text || '').split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width <= maxW || !line) line = t; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] = out[maxLines - 1].replace(/.{0,2}$/, '') + '…'; }
  return out;
}
// One JPEG: header (serial, rig, customer), Before | After photos side by side, and under each its label,
// date, rig/customer and condition notes.
async function buildComparisonJpeg(pre, post) {
  const blobs = [];
  for (const p of [pre, post]) blobs.push(p.blob || await Sync.ensureBlob(p).catch(() => null) || p.thumb);
  if (!blobs[0] || !blobs[1]) throw new Error('Photo not downloaded yet — try again when online.');
  const imgs = [await loadImage(blobs[0]), await loadImage(blobs[1])];
  const W = 1600, pad = 32, colW = (W - pad * 3) / 2, font = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const imgH = Math.round(Math.min(colW * 1.25, Math.max(...imgs.map((im) => colW * im.naturalHeight / im.naturalWidth))));
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `26px ${font}`;
  const noteLines = [pre, post].map((p) => wrapText(meas, 'Condition: ' + (p.notes || '—'), colW, 8));
  const rigName = (p) => (S.rigs.get(p.rigId) || S.gone.rigs.get(p.rigId) || {}).name || '—';
  const sameWhere = rigName(pre) === rigName(post) && pre.customerId === post.customerId;
  const headH = 130, textH = 60 + 40 + 38 + (sameWhere ? 0 : 38) + Math.max(...noteLines.map((l) => l.length)) * 34 + pad;
  const H = headH + imgH + textH + 44;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1f2a36'; ctx.fillRect(0, 0, W, headH - 20);
  ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'top';
  ctx.font = `bold 44px ${font}`;
  ctx.fillText(`SN ${post.serialNumber || pre.serialNumber || '—'}  ·  Before / After hardband`, pad, 18);
  ctx.font = `28px ${font}`;
  ctx.fillText(sameWhere ? `Rig ${rigName(post)}  ·  Customer ${labelOf('customers', post.customerId) || '—'}` : 'Hardband Photos comparison', pad, 70);
  [pre, post].forEach((p, k) => {
    const x = pad + k * (colW + pad), y = headH, im = imgs[k];
    ctx.fillStyle = '#111111'; ctx.fillRect(x, y, colW, imgH);
    const s = Math.min(colW / im.naturalWidth, imgH / im.naturalHeight), w = im.naturalWidth * s, h = im.naturalHeight * s;
    ctx.drawImage(im, x + (colW - w) / 2, y + (imgH - h) / 2, w, h);
    const st = k === 0 ? 'pre' : 'post';
    ctx.font = `bold 30px ${font}`;
    const lbl = STAGES[st].badge, lw = ctx.measureText(lbl).width + 28;
    ctx.fillStyle = st === 'pre' ? '#1f2a36' : '#f58220'; ctx.fillRect(x + 14, y + 14, lw, 46);
    ctx.fillStyle = st === 'pre' ? '#ffffff' : '#111111'; ctx.fillText(lbl, x + 28, y + 22);
    let ty = y + imgH + 18;
    ctx.fillStyle = '#111820'; ctx.font = `bold 30px ${font}`;
    ctx.fillText(st === 'pre' ? 'Before hardband (inspection)' : 'After hardband', x, ty); ty += 42;
    ctx.font = `26px ${font}`; ctx.fillStyle = '#333d47';
    ctx.fillText(`${isoLocal(p.createdAt)}${bandText(p) ? '  ·  ' + bandText(p) : ''}${p.serialNumber ? '  ·  SN ' + p.serialNumber : ''}`, x, ty); ty += 38;
    if (!sameWhere) { ctx.fillText(`Rig ${rigName(p)}  ·  ${labelOf('customers', p.customerId) || 'No customer'}`, x, ty); ty += 38; }
    ctx.fillText(`Operator: ${opText(p)}`, x, ty); ty += 38;
    ctx.fillStyle = '#111820';
    for (const line of noteLines[k]) { ctx.fillText(line, x, ty); ty += 34; }
  });
  ctx.fillStyle = '#5b6773'; ctx.font = `22px ${font}`;
  ctx.fillText(`Hardband Photos · made ${isoLocal(Date.now())}`, pad, H - 36);
  const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Image encode failed'))), 'image/jpeg', 0.88));
  c.width = c.height = 0;
  return blob;
}
async function shareComparison(pre, post) {
  const b = busy('Making comparison…');
  let blob;
  try { blob = await buildComparisonJpeg(pre, post); } catch (e) { b.done(); toast(e.message, 5000); return; }
  b.done();
  const name = `${isoDay(post.createdAt)}_${safeToken(serialKey(post.serialNumber || pre.serialNumber)) || 'noSN'}_Before-After.jpg`;
  const file = window.File ? new File([blob], name, { type: 'image/jpeg' }) : null;
  if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { /* cancelled */ }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Comparison saved (download)');
}

/* ================= add / edit form ================= */
// Condition quick-pick buttons (they only add text to the notes box; existing notes are never changed).
// The set shown depends on the stage: inspection before hardbanding, or the result after hardbanding.
const CHIPS = {
  pre: ['Good', 'Eccentric band', 'Repair'],
  repair: [],
  plasma: [],
  inlay: [],
  post: ['Good', 'Rejected wire', 'Excessive porosity'],
  preheat: [],
};
const NOTES_HINT = {
  pre: 'Inspection: band worn flush, height above OD, cracks…',
  repair: 'Repair work in progress…',
  plasma: 'Existing hardbanding removed, cut clean…',
  inlay: 'Inlay seated, fit-up…',
  post: 'Wear, cracks, height above OD, rebuild needed…',
  preheat: 'Preheat temp…',
};
function renderForm(mode, id) {
  let p = null, item = null, vals;
  if (mode === 'edit') {
    p = S.photos.find((x) => x.id === id);
    if (!p) { location.hash = '#/'; return; }
    vals = { customerId: p.customerId, rigId: p.rigId, pipeSpecId: p.pipeSpecId, serialNumber: p.serialNumber || '', end: p.end || '', bandNumber: p.bandNumber || '', notes: p.notes || '', createdAt: p.createdAt, stage: stageOf(p), operator: cleanOp(p.operator), wire: cleanWire(p.wire) };
    vals.wireNormal = wireKey(vals.wire) === wireKey(WIRE_INLAY) ? '' : vals.wire;
    setChrome({ title: 'Edit photo', back: `#/photo/${encodeURIComponent(id)}`, bottom: false });
  } else {
    item = S.queue[S.qIndex];
    if (!item) { location.hash = '#/'; return; }
    const lu = S.meta.lastUsed || {};
    // New capture (!Same joint) always starts Before — never sticky lastStage=After on a fresh joint.
    vals = { customerId: lu.customerId || '', rigId: lu.rigId || '', pipeSpecId: lu.pipeSpecId || '', serialNumber: '', end: '', bandNumber: '', notes: '', stage: 'pre', operator: currentOperator(), wire: currentWire() };
    if (S.addContext) Object.assign(vals, S.addContext);
    if (S.batchValues) Object.assign(vals, { ...S.batchValues, notes: '' }); // same joint: SN / end / band carried
    // Same joint: carry ALL Before metadata (SN, end, band, notes, operator, wire, customer, rig, spec) onto Preheat/After/repair — enter once.
    if (S.addKeep && S.lastSaved) Object.assign(vals, { customerId: S.lastSaved.customerId, rigId: S.lastSaved.rigId, pipeSpecId: S.lastSaved.pipeSpecId, serialNumber: S.lastSaved.serialNumber || '', end: S.lastSaved.end || '', bandNumber: S.lastSaved.bandNumber || '', notes: S.lastSaved.notes || '', stage: stageOf(S.lastSaved), operator: cleanOp(S.lastSaved.operator) || currentOperator(), wire: cleanWire(S.lastSaved.wire) || currentWire() });
    // Joint order: Before → Preheat → After; repair joints Before → Repair → Plasma cut → Inlay → After.
    // New joint / Next photo (keep=0) → Before. Same joint → next stage in that joint's order (After stays After).
    // forceStage (from saved CTA data-stage) wins over lastSaved races so After photo always opens After.
    const forced = S.forceStage; S.forceStage = null;
    const fromDetail = S.addFromDetail; // photo-detail CTA: S.lastSaved = the viewed photo, stage = S.addDetailStage
    if (forced && STAGES[forced]) { vals.stage = forced; if (S.lastSaved) S.addKeep = true; }
    else if (S.addKeep && S.lastSaved) { const ls = S.lastSaved, nx = nextStage(stageOf(ls), isRepairJoint(ls.notes, ls.serialNumber, ls.end)); if (nx) vals.stage = nx; }
    else if (!S.addKeep) vals.stage = 'pre';
    // Re-apply Same-joint carry if forceStage just restored addKeep (after a wiped pendingKeep race).
    if (S.addKeep && S.lastSaved && forced && STAGES[forced]) Object.assign(vals, { customerId: S.lastSaved.customerId, rigId: S.lastSaved.rigId, pipeSpecId: S.lastSaved.pipeSpecId, serialNumber: S.lastSaved.serialNumber || '', end: S.lastSaved.end || '', bandNumber: S.lastSaved.bandNumber || '', notes: S.lastSaved.notes || '', operator: cleanOp(S.lastSaved.operator) || currentOperator(), wire: cleanWire(S.lastSaved.wire) || currentWire(), stage: forced });
    // Never trap on a second picture-only Preheat for the same joint — advance to After.
    if (vals.stage === 'preheat' && vals.serialNumber && jointHasStage(vals.serialNumber, 'preheat')) vals.stage = 'post';
    // Repair joints never get a new Preheat photo (no preheat before plasma cutting) — go to the next repair step.
    if (vals.stage === 'preheat' && isRepairJoint(vals.notes, vals.serialNumber, vals.end)) vals.stage = 'post';
    // New photos never take the Repair stage any more (the Before is the repair picture) — Plasma cut instead.
    if (vals.stage === 'repair') vals.stage = 'plasma';
    // Never default to a second Plasma cut / Inlay photo for a joint that already has one — next missing step.
    if (REPAIR_MID.includes(vals.stage) && vals.serialNumber && isRepairJoint(vals.notes, vals.serialNumber, vals.end)) {
      const have = jointStageSet(vals.serialNumber, vals.end);
      if (have.has(vals.stage)) vals.stage = nextMissingStage(vals.stage, true, have) || 'post';
    }
    // A photo-detail CTA copies everything from the viewed photo; the job session must not swap its SN / operator / wire.
    if (!fromDetail) {
      if (S.addInspect && S.addKeep && S.inspection && S.inspection.serialNumber) vals.serialNumber = S.inspection.serialNumber;
      if (S.addInspect && S.inspection && S.inspection.operator) vals.operator = S.inspection.operator;
      if (S.addInspect && S.inspection) vals.wire = S.inspection.wire || ''; // the job's wire (Start new job / last photo)
    }
    // Repair mid-stages only on repair joints; otherwise fall back (inspection → Before, else After)
    if (REPAIR_MID.includes(vals.stage) && !isRepairJoint(vals.notes, vals.serialNumber, vals.end)) vals.stage = S.addInspect ? 'pre' : 'post';
    // Pipe spec = the job's spec (session sheet, else this rig's last saved photo), never a stale last-used from another rig.
    if (!(fromDetail && vals.pipeSpecId)) { const js = jobSpec(vals.rigId, vals.customerId); if (js) vals.pipeSpecId = js; }
    // Photo-detail CTA: the tapped stage sticks (no fallback to Before / Preheat / After / next step).
    if (fromDetail && STAGES[S.addDetailStage]) vals.stage = S.addDetailStage;
    // Inlay photos use the Build-up wire; every other stage keeps the joint's normal hardband wire (never Build-up
    // carried over from an Inlay photo). Only the wire changes — everything else still copies from the joint.
    if (wireKey(vals.wire) === wireKey(WIRE_INLAY) && S.addKeep && S.lastSaved && stageOf(S.lastSaved) === 'inlay') vals.wire = jointNormalWire(vals.serialNumber, vals.end);
    vals.wireNormal = wireKey(vals.wire) === wireKey(WIRE_INLAY) ? '' : vals.wire;
    if (vals.stage === 'inlay') vals.wire = canonWire(WIRE_INLAY);
    // A completed job is never the default rig for a new joint (same-joint photos keep their rig).
    if (!S.addKeep && vals.rigId && (S.rigs.get(vals.rigId) || {}).closedAt) vals.rigId = '';
    // End pre-filled with no band: use that end's default band (never overwrite a carried band).
    if (!vals.bandNumber && END_BAND[vals.end]) vals.bandNumber = END_BAND[vals.end];
    setChrome({ title: S.queue.length > 1 ? `Add photo ${S.qIndex + 1} of ${S.queue.length}` : 'Add photo', back: discardQueue, bottom: false });
  }
  for (const [k, kind] of [['customerId', 'customers'], ['rigId', 'rigs'], ['pipeSpecId', 'pipeSpecs']]) if (vals[k] && !S[kind].has(vals[k])) vals[k] = '';
  const keepRepair = mode === 'edit' && stageOf(p) === 'repair'; // only an existing Repair photo keeps the Repair button
  const srcBlob = mode === 'edit' ? (p.blob || p.thumb) : item.blob;
  const src = srcBlob ? viewUrl(srcBlob) : '';
  const remaining = mode === 'add' ? S.queue.length - S.qIndex : 0;
  const serials = [...new Set(S.photos.filter((x) => x.rigId === vals.rigId && x.serialNumber).sort((a, b) => b.createdAt - a.createdAt).map((x) => x.serialNumber))].slice(0, 30);
  const selectHTML = (kind, key, idAttr) => `<select id="${idAttr}" data-kind="${kind}">${vals[key] ? '' : '<option value="">— choose —</option>'}${opts(kind, vals[key], '', true)}<option value="__new">＋ New ${KINDS[kind].label.toLowerCase()}…</option></select>`;
  view.innerHTML = `
    <img class="preview" src="${src}" alt="Photo preview">
    <p class="qinfo">${mode === 'add' ? `Taken ${fmtDate(item.createdAt)}${item.dateSource === 'exif' ? ' (from photo)' : ''}` : ''}</p>
    <form id="photoForm" class="card" autocomplete="off">
      <div class="field stage-field"${mode === 'add' && S.addInspect && S.inspection && S.inspection.count === 0 ? ' hidden' : ''}><span class="lbl">Stage</span><div class="seg stage multi-stages${isRepairJoint(vals.notes, vals.serialNumber, vals.end) ? ' repair-stages' : ''}" id="fStage" role="radiogroup" aria-label="Stage">${stageButtonsHTML(isRepairJoint(vals.notes, vals.serialNumber, vals.end), vals.stage === 'preheat', keepRepair)}</div>${mode === 'edit' ? '<p class="muted small" id="stageRelabelHint">Changing Stage relabels this photo. To take a new picture, use the camera buttons on the photo screen.</p>' : ''}</div>
      <div class="pre-head" id="preHead" hidden></div>
      <div class="pre-head" id="preheatHead" hidden></div>
      <div id="mainFields">
      <div class="field" id="fldCustomer"><label for="fCustomer">Customer</label>${selectHTML('customers', 'customerId', 'fCustomer')}</div>
      <div class="field" id="fldRig"><label for="fRig">Rig</label>${selectHTML('rigs', 'rigId', 'fRig')}</div>
      ${opFieldHTML('fOperator', vals.operator, { wrapId: 'fldOperator', blank: 'No operator' })}
      <div class="field" id="fldSpec"><label for="fSpec">Pipe spec</label>${selectHTML('pipeSpecs', 'pipeSpecId', 'fSpec')}</div>
      ${wireFieldHTML('fWire', vals.wire, { wrapId: 'fldWire', blank: 'No wire' })}
      <div class="field" id="fldSerial"><label for="fSerial">Serial number</label>
        <input id="fSerial" type="text" value="${esc(vals.serialNumber)}" placeholder="Stamped serial / joint #" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="done">
        <div class="pick-list" id="snPick" hidden></div></div>
      <div class="field" id="fldPreChips" hidden><span class="lbl">Condition before hardband</span><div id="preChipSlot"></div>
        <div class="muted small notes-peek" id="notesPeek" hidden></div></div>
      <div class="field" id="fldEnd"><span class="lbl">End</span><div class="seg" id="fEnd">
        <button type="button" data-v="Box">Box</button><button type="button" data-v="Pin">Pin</button></div></div>
      <div class="field" id="fldBand"><span class="lbl">Band</span><div class="seg band" id="fBand"></div>
        <div class="band-diagram" id="bandHint"></div></div>
      <div class="field" id="fldNotes"><label for="fNotes">Condition / notes</label>
        <textarea id="fNotes" placeholder="${esc(NOTES_HINT[vals.stage])}">${esc(vals.notes)}</textarea>
        <div class="chips" id="fChips" data-stage="${vals.stage}"></div></div>
      ${mode === 'edit' ? `<div class="field" id="fldDate"><label for="fDate">Date / time taken</label><input id="fDate" type="datetime-local" value="${dtLocalValue(vals.createdAt)}"></div>` : ''}
      </div>
      <details class="more-box" id="moreBox" hidden><summary>More details <span class="muted small" id="moreSum">Box/Pin, band, notes, operator, pipe spec, wire, customer${mode === 'edit' ? ', date' : ''}</span></summary><div id="moreFields"></div></details>
      <div class="stack form-actions">
        ${mode === 'edit'
    ? `<button type="submit" class="btn primary big block" id="saveBtn">Save changes</button><a class="btn ghost block" href="#/photo/${encodeURIComponent(id)}">Cancel</a>`
    : `<button type="submit" class="btn primary big block" id="saveBtn">${remaining > 1 ? `Save &amp; next (${remaining - 1} left)` : 'Save photo'}</button>
           ${remaining > 1 ? `<button type="button" class="btn secondary block" id="saveAllBtn">Save all ${remaining} with these details</button>` : ''}
           <button type="button" class="btn danger block" id="discardBtn">Discard this photo</button>`}
      </div>
    </form>`;

  let end = vals.end, band = vals.bandNumber, stage = vals.stage;
  // Before-hardband (inspection) layout: one-line rig header, serial, the Before chips, and everything else
  // tucked under "More details". After-hardband keeps the original full form. Fields are moved, not re-created,
  // so switching stage never loses what was typed (notes included); only the quick-pick buttons change.
  const fld = (x) => $('#fld' + x);
  const markChips = () => { const v = $('#fNotes').value; $$('#fChips [data-chip]').forEach((b) => b.classList.toggle('on', notesHasChip(v, b.dataset.chip))); };
  const peekNotes = () => { markChips(); const pk = $('#notesPeek'), v = $('#fNotes').value.trim(); pk.hidden = stage !== 'pre' || !v || $('#moreBox').open; pk.textContent = v ? 'Notes: ' + v : ''; };
  const drawHead = () => { $('#preHead').innerHTML = `<span class="pre-head-rig">📁 ${esc(labelOf('rigs', $('#fRig').value) || 'No rig')}</span> · ${stageBadge({ stage: 'pre' })} <b>Before hardband</b> <span class="pre-head-op" id="preHeadOp">· 👷 ${esc(opText({ operator: opCtl.value }))}</span>`; };
  const opCtl = bindOpField('fOperator', { onChange: () => { if (stage === 'pre') drawHead(); } });
  const wireCtl = bindWireField('fWire');
  attachPickList($('#fSerial'), $('#snPick'), serials);
  const drawPreheatHead = () => {
    const sn = ($('#fSerial') && $('#fSerial').value.trim()) || vals.serialNumber || '';
    const rig = labelOf('rigs', ($('#fRig') && $('#fRig').value) || vals.rigId) || 'No rig';
    $('#preheatHead').innerHTML = `${stageBadge({ stage: 'preheat' })} <b>Preheat temp photo</b>${sn ? ' · SN ' + esc(sn) : ''} · 📁 ${esc(rig)} <span class="muted small">— snap and save, tags copied from this joint</span>`;
  };
  const drawStage = () => {
    $$('#fStage button').forEach((b) => { const on = b.dataset.v === stage; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    const ch = $('#fChips'); ch.dataset.stage = stage;
    ch.innerHTML = (CHIPS[stage] || []).map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
    markChips();
    $('#fNotes').placeholder = NOTES_HINT[stage] || '';
    // Only `pre` uses the Before inspection layout; Preheat is picture-only; repair/plasma/inlay/post use the full layout.
    // New After photo (hbp-v30): Serial, End, Band, Condition up front; customer / rig / operator / spec / wire under More details.
    const pre = stage === 'pre', heat = stage === 'preheat', main = $('#mainFields'), more = $('#moreFields');
    const postTrim = stage === 'post' && mode === 'add';
    const order = pre ? ['Serial', 'PreChips', 'End'] : heat ? [] : postTrim ? ['Serial', 'End', 'Band', 'Notes'] : ['Customer', 'Rig', 'Operator', 'Spec', 'Wire', 'Serial', 'End', 'Band', 'Notes', 'Date'];
    order.map(fld).filter(Boolean).forEach((el) => main.appendChild(el));
    if (pre) ['Band', 'Notes', 'Operator', 'Spec', 'Wire', 'Customer', 'Rig', 'Date'].map(fld).filter(Boolean).forEach((el) => more.appendChild(el));
    if (postTrim) ['Customer', 'Rig', 'Operator', 'Spec', 'Wire', 'Date'].map(fld).filter(Boolean).forEach((el) => more.appendChild(el));
    $('#moreSum').textContent = postTrim ? 'customer, rig, operator, pipe spec, wire' : `Box/Pin, band, notes, operator, pipe spec, wire, customer${mode === 'edit' ? ', date' : ''}`;
    if (!heat) (pre ? $('#preChipSlot') : fld('Notes')).appendChild(ch);
    fld('PreChips').hidden = !pre; $('#moreBox').hidden = !(pre || postTrim); $('#preHead').hidden = !pre;
    // Picture-only Preheat: hide stage picker + every metadata field; show a short badge line.
    const stageField = document.querySelector('.stage-field');
    if (stageField) stageField.hidden = heat || (mode === 'add' && S.addInspect && S.inspection && S.inspection.count === 0);
    $('#preheatHead').hidden = !heat;
    if (heat) {
      // Park every metadata field out of the visible form; collect()/save still reads their values.
      ['Customer', 'Rig', 'Operator', 'Spec', 'Wire', 'Serial', 'PreChips', 'End', 'Band', 'Notes', 'Date'].map(fld).filter(Boolean).forEach((el) => { el.hidden = true; });
      main.hidden = true;
      if ($('#fChips')) $('#fChips').hidden = true;
      drawPreheatHead();
    } else {
      main.hidden = false;
      if ($('#fChips')) $('#fChips').hidden = false;
      ['Customer', 'Rig', 'Operator', 'Spec', 'Wire', 'Serial', 'End', 'Band', 'Notes', 'Date'].map(fld).filter(Boolean).forEach((el) => { el.hidden = false; });
    }
    if (pre) drawHead();
    peekNotes();
  };
  // Rebuild the Stage button set when Repair is marked/cleared (or serial/end match a repair joint).
  // Only redraw when the Stage button set or forced stage actually changes — appendChild in drawStage
  // blurs the focused serial/notes input on mobile Safari on every keystroke otherwise.
  const syncRepairStages = () => {
    const repair = isRepairJoint($('#fNotes').value, $('#fSerial').value, end);
    const box = $('#fStage');
    // Repair joints have no Preheat button, except a photo that already is (or was opened as) Preheat keeps it.
    const keepHeat = vals.stage === 'preheat' || stage === 'preheat';
    const want = stageKeys(repair, keepHeat, keepRepair).join(',');
    const have = [...box.querySelectorAll('button')].map((b) => b.dataset.v).join(',');
    let changed = false;
    if (REPAIR_MID.includes(stage) && !repair) { stage = (mode === 'add' && S.addInspect) ? 'pre' : 'post'; changed = true; }
    if (have !== want) {
      box.innerHTML = stageButtonsHTML(repair, keepHeat, keepRepair);
      box.classList.add('multi-stages'); box.classList.toggle('repair-stages', repair);
      changed = true;
    }
    if (changed) drawStage();
  };
  syncRepairStages();
  drawStage(); // initial layout (syncRepairStages skips draw when nothing changed)
  // Preheat from the camera saves itself (hbp-v30): the iOS camera's Retake / Use Photo is the check. Library / Edit don't.
  if (mode === 'add' && stage === 'preheat' && S.addFromCamera && item && !item.autoSaved) {
    item.autoSaved = true;
    setTimeout(() => { const f = $('#photoForm'); if (f && S.queue[S.qIndex] === item && stage === 'preheat') f.requestSubmit(); }, 0);
  }
  // Tapping Inlay switches the wire to Build-up; tapping away again puts the joint's wire back (unless he picked another).
  let wireNormal = vals.wireNormal || '';
  $('#fStage').onclick = (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === stage) return;
    const was = stage;
    stage = b.dataset.v; drawStage();
    if (stage === 'inlay' && was !== 'inlay') {
      if (wireKey(wireCtl.value) !== wireKey(WIRE_INLAY)) wireNormal = wireCtl.value;
      if (!wireCtl.adding) wireCtl.choose(canonWire(WIRE_INLAY));
    } else if (was === 'inlay' && stage !== 'inlay' && !wireCtl.adding && wireKey(wireCtl.value) === wireKey(WIRE_INLAY)) {
      wireCtl.choose(wireNormal ? canonWire(wireNormal) : '');
    }
    if (stage === 'pre' && !$('#fSerial').value) $('#fSerial').focus();
  };
  // New photo: picking another rig re-defaults Pipe spec to that rig's job spec, unless he picked a spec by hand here.
  let specTouched = false;
  $('#fSpec').addEventListener('change', () => { if ($('#fSpec').value !== '__new') specTouched = true; });
  const respec = () => {
    if (mode !== 'add' || specTouched) return;
    const js = jobSpec($('#fRig').value.replace('__new', ''), $('#fCustomer').value.replace('__new', ''));
    const sp = $('#fSpec');
    if (js && sp.value !== js && sp.querySelector(`option[value="${CSS.escape(js)}"]`)) sp.value = js;
  };
  $('#fRig').addEventListener('change', () => { respec(); if (stage === 'pre') drawHead(); });
  $('#fCustomer').addEventListener('change', respec);
  // Notes peek is text-only (safe on input). syncRepairStages reparents via appendChild and blurs iOS — blur/change only.
  $('#fNotes').addEventListener('input', peekNotes);
  $('#fNotes').addEventListener('blur', syncRepairStages);
  $('#fNotes').addEventListener('change', syncRepairStages);
  // Serial: never syncRepairStages on input — same iOS blur. Blur + change only.
  $('#fSerial').addEventListener('blur', syncRepairStages);
  $('#fSerial').addEventListener('change', syncRepairStages);
  $('#moreBox').addEventListener('toggle', peekNotes);
  if (stage === 'pre' && mode === 'add' && !vals.serialNumber) setTimeout(() => { if ($('#fSerial') && !$('#modalRoot').innerHTML) $('#fSerial').focus({ preventScroll: true }); }, 60);
  const drawSeg = () => {
    $$('#fEnd button').forEach((b) => b.classList.toggle('on', b.dataset.v === end));
    const choices = end === 'Pin' ? ['1', '2', 'All'] : ['1', '2', '3', 'All'];
    if (band && !choices.includes(band)) band = '';
    $('#fBand').innerHTML = choices.map((c) => `<button type="button" data-v="${c}" class="${c === band ? 'on' : ''}">${c === 'All' ? 'All / whole' : c}</button>`).join('');
    $('#bandHint').textContent = end === 'Pin' ? 'Pin has 2 bands.' : end === 'Box' ? 'Box has 3 bands.' : 'Box has 3 bands, Pin has 2. Pick an end first.';
  };
  drawSeg();
  $('#fEnd').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const was = end; end = b.dataset.v; if (END_BAND[end] && was !== end) band = END_BAND[end]; drawSeg(); syncRepairStages(); };
  $('#fBand').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; band = band === b.dataset.v ? '' : b.dataset.v; drawSeg(); };
  $('.chips').onclick = (e) => {
    const c = e.target.closest('[data-chip]'); if (!c) return;
    const ta = $('#fNotes'); const cur = ta.value.trim();
    // Already there (e.g. Repair carried from the joint, or typed "Repair  Defender…"): no duplicate, nothing removed.
    if (!notesHasChip(cur, c.dataset.chip)) ta.value = cur ? `${cur}${/[.,;]$/.test(cur) ? '' : ','} ${c.dataset.chip}` : c.dataset.chip;
    peekNotes();
    syncRepairStages();
  };
  $$('select[data-kind]').forEach((sel) => {
    let prevVal = sel.value;
    sel.addEventListener('change', async () => {
      if (sel.value !== '__new') { prevVal = sel.value; return; }
      const kind = sel.dataset.kind;
      const it = await newLookupDialog(kind);
      const chosen = it ? it.id : prevVal;
      sel.innerHTML = `${chosen ? '' : '<option value="">— choose —</option>'}${opts(kind, chosen)}<option value="__new">＋ New ${KINDS[kind].label.toLowerCase()}…</option>`;
      sel.value = chosen; prevVal = chosen;
    });
  });
  const collect = () => ({
    customerId: $('#fCustomer').value.replace('__new', ''), rigId: $('#fRig').value.replace('__new', ''), pipeSpecId: $('#fSpec').value.replace('__new', ''),
    serialNumber: $('#fSerial').value.trim().toUpperCase(), end, bandNumber: band, notes: $('#fNotes').value.trim(), stage, operator: cleanOp(opCtl.value), wire: cleanWire(wireCtl.value),
  });
  // A half-typed new operator is saved with the photo (or the save waits for the missing name/number).
  const opReady = () => (!opCtl.adding || !!opCtl.commit()) && (!wireCtl.adding || !!wireCtl.commit()); // (a half-typed new wire too)
  // Inspection (Before) photos are found by serial later, so a blank serial gets one confirmation.
  const serialOk = async (v) => {
    if (mode !== 'add' || v.stage !== 'pre' || v.serialNumber) return true;
    const go = await confirmBox({ title: 'Save without a serial number?', ok: 'Save anyway', cancel: 'Add serial' });
    if (!go) setTimeout(() => { const f = $('#fSerial'); if (f) f.focus(); }, 30);
    return go;
  };
  let saving = false; // double-tap Save must never store the same picture twice (e.g. two Repair photos)
  $('#photoForm').onsubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (!opReady()) return;
    const v = collect();
    saving = true;
    if (!(await serialOk(v))) { saving = false; return; }
    $('#saveBtn').disabled = true;
    try {
      if (mode === 'edit') {
        const d = $('#fDate').value ? new Date($('#fDate').value).getTime() : p.createdAt;
        Object.assign(p, v, { updatedAt: Date.now() });
        if (v.wire) rememberWire(v.wire);
        if (!isNaN(d) && d !== new Date(dtLocalValue(vals.createdAt)).getTime()) { p.createdAt = d; p.dateSource = 'manual'; }
        await putPhoto(p); markDirty('photos', p.id);
        toast('Saved');
        S.lastListHash = `#/folder/${encodeURIComponent(p.customerId || '')}/${encodeURIComponent(p.rigId || '')}`;
        history.replaceState(null, '', `#/photo/${encodeURIComponent(p.id)}`); route();
      } else {
        await saveQueued(v);
        advanceQueue();
      }
    } catch (err) { console.error(err); toast('Save failed: ' + err.message, 5000); $('#saveBtn').disabled = false; saving = false; }
  };
  const sa = $('#saveAllBtn');
  if (sa) sa.onclick = async () => {
    if (saving) return;
    if (!opReady()) return;
    const v = collect();
    saving = true;
    if (!(await serialOk(v))) { saving = false; return; }
    const b = busy('Saving…'); const n = S.queue.length - S.qIndex;
    try { for (let k = 0; k < n; k++) { b.update(`Saving ${k + 1} of ${n}…`, (k + 1) / n); await saveQueued(v); S.qIndex++; } }
    catch (err) { b.done(); toast('Save failed: ' + err.message, 5000); saving = false; return; }
    b.done(); finishQueue();
  };
  const db2 = $('#discardBtn');
  if (db2) db2.onclick = async () => { if (await confirmBox({ title: 'Discard this photo?', ok: 'Discard', danger: true })) { S.qIndex++; S.batchValues = S.batchValues || null; S.qIndex < S.queue.length ? route() : finishQueue(); } };
}
async function saveQueued(v) {
  const it = S.queue[S.qIndex];
  if (!it || it.savedId) return; // this queued picture is already stored (double submit) — never a second copy
  const now = Date.now();
  const p = { id: uid(), blob: it.blob, thumb: it.thumb, width: it.width, height: it.height, createdAt: it.createdAt, dateSource: it.dateSource, addedAt: now, updatedAt: now, origName: it.origName, ...v };
  if (S.addInspect && S.inspection && S.inspection.workOrder) p.workOrder = S.inspection.workOrder; // the job this inspection is for
  it.savedId = p.id;
  try { await putPhoto(p); } catch (err) { it.savedId = null; throw err; }
  S.photos.push(p);
  markDirty('photos', p.id);
  S.lastSaved = p; S.batchValues = { customerId: v.customerId, rigId: v.rigId, pipeSpecId: v.pipeSpecId, serialNumber: v.serialNumber, end: v.end, bandNumber: v.bandNumber, stage: v.stage, operator: v.operator, wire: v.wire };
  if (S.addInspect && S.inspection && v.serialNumber) S.inspection.serialNumber = v.serialNumber;
  if (v.operator) { rememberOperator(v.operator, true); if (S.addInspect && S.inspection) { S.inspection.operator = v.operator; drawInspBar(); } } // next photo: same operator
  // Inlay's Build-up never becomes the remembered / job wire — later Before / Plasma / After photos keep the hardband wire.
  const inlayWire = v.stage === 'inlay' && wireKey(v.wire) === wireKey(WIRE_INLAY);
  if (v.wire) rememberWire(v.wire, !inlayWire); // next job / photo: same wire
  if (S.addInspect && S.inspection) { Object.assign(S.inspection, { rigId: v.rigId || '', customerId: v.customerId || '', pipeSpecId: v.pipeSpecId || '', ...(inlayWire ? {} : { wire: v.wire || '' }) }); drawInspBar(); } // next photo: what was just saved
  S.savedCount++;
  if (S.addInspect && S.inspection) S.inspection.count++;
  await setMeta('lastUsed', { customerId: v.customerId, rigId: v.rigId, pipeSpecId: v.pipeSpecId });
  if (S.meta.lastStage !== v.stage) await setMeta('lastStage', v.stage); // next photo defaults to the same stage
}
function advanceQueue() { S.qIndex++; if (S.qIndex < S.queue.length) { route(); } else finishQueue(); }
function finishQueue() { S.queue = []; S.qIndex = 0; S.addContext = null; if (S.savedCount) history.replaceState(null, '', '#/saved'); else history.replaceState(null, '', S.lastListHash || '#/'); route(); }
async function discardQueue() {
  const left = S.queue.length - S.qIndex;
  if (left && !(await confirmBox({ title: `Discard ${left} unsaved photo${left === 1 ? '' : 's'}?`, ok: 'Discard', danger: true }))) return;
  S.qIndex = S.queue.length; finishQueue();
}
function renderSaved() {
  const p = S.lastSaved;
  if (!p) { location.hash = '#/'; return; }
  const n = S.savedCount;
  const folderHash = `#/folder/${encodeURIComponent(p.customerId || '')}/${encodeURIComponent(p.rigId || '')}`;
  S.context = { customerId: p.customerId, rigId: p.rigId };
  S.lastListHash = folderHash;
  setChrome({ title: 'Saved', back: '#/', bottom: false });
  view.innerHTML = `
    <div class="saved-hero"><div class="big-emoji">✅</div>
      <h3 id="savedMsg">Saved ${n} photo${n === 1 ? '' : 's'}</h3>
      <p class="muted">${esc(labelOf('customers', p.customerId) || '—')} / ${esc(labelOf('rigs', p.rigId) || '—')}${p.serialNumber ? ' · SN ' + esc(p.serialNumber) : ''}</p><p class="muted small" id="savedOp">👷 ${esc(opText(p))}</p><p id="savedStage">${stageBadge(p)} ${esc(STAGES[stageOf(p)].label)}</p></div>
    <div class="stack">
      ${(() => {
        const sn = p.serialNumber || '', st = stageOf(p), snTxt = sn ? ` (SN ${esc(sn)})` : '';
        // Batch work (photo taken from a photo's detail screen): offer this joint's remaining missing stages, then Next joint.
        if (S.addFromDetail && sn) {
          const btns = jointCaptureButtons(p, 'saved');
          return `<div class="stack" id="savedCapture">${btns ? `<p class="muted small" id="savedNextHint">Still to take for SN ${esc(sn)}:</p>${btns}` : `<p class="muted small" id="savedNextHint">SN ${esc(sn)}: every stage has a photo.</p>`}</div>
      <label for="camInput" class="btn ${btns ? 'ghost' : 'primary big'} block" data-keep="0" id="nextJointBtn">📷 Next joint</label>`;
        }
        const repair = isRepairJoint(p.notes, p.serialNumber, p.end);
        // Repair joint: primary = next step in Before → Repair → Plasma cut → Inlay → After (same joint, SN kept).
        // After Before, Plasma cut is offered directly too (the Repair photo is often skipped). Never Preheat.
        // Repair joint Before (= the repair picture, hbp-v28): primary Plasma cut, then the joint's other missing stages. No Repair button.
        if (repair && st === 'pre' && sn) {
          const rest = jointMissingStages(p).filter((x) => x !== 'plasma');
          const hasPlasma = jointStageSet(p.serialNumber, p.end).has('plasma');
          return `<p class="muted small" id="savedNextHint">Next for SN ${esc(sn)}: Plasma cut → Inlay → After</p>
      ${hasPlasma ? '' : `<label for="camInput" class="btn primary big block" data-keep="1" data-stage="plasma" id="plasmaBtn">🔥 Plasma cut photo${snTxt}</label>`}
      ${rest.map((x) => `<label for="camInput" class="btn secondary block" data-keep="1" data-stage="${x}" id="saved${CAP_ID[x]}Btn">📷 ${esc(CAP_NAME[x])} photo${snTxt}</label>`).join('')}
      <label for="camInput" class="btn ghost block" data-keep="0" id="nextJointBtn">Next joint</label>`;
        }
        if (repair && REPAIR_MID.includes(st)) {
          const nx = nextStage(st, true);
          return `<p class="muted small" id="savedNextHint">Next: ${esc(STAGES[nx].label)} photo${sn ? ' for SN ' + esc(sn) : ''}</p>
      <label for="camInput" class="btn primary big block" data-keep="1" data-stage="${nx}" id="nextPhotoBtn">📷 ${esc(STAGES[nx].short === 'After' ? 'After' : STAGES[nx].label)} photo${snTxt}</label>
      <label for="camInput" class="btn ghost block" data-keep="0" id="nextJointBtn">Next joint</label>`;
        }
        // After Before+SN: primary = Preheat for that joint (keep SN); secondary = next joint.
        if (st === 'pre' && sn) return `<label for="camInput" class="btn primary big block" data-keep="1" data-stage="preheat" id="nextPhotoBtn">📷 Preheat photo (SN ${esc(sn)})</label>
      <label for="camInput" class="btn secondary block" data-keep="0" id="nextJointBtn">📷 Next joint</label>`;
        // After Preheat+SN: primary = After for that joint (force post — do not re-open Preheat).
        if (st === 'preheat' && sn) return `<p class="muted small" id="savedNextHint">Next: After hardband photo for SN ${esc(sn)}</p>
      <label for="camInput" class="btn primary big block" data-keep="1" data-stage="post" id="nextPhotoBtn">📷 After photo (SN ${esc(sn)})</label>
      <label for="camInput" class="btn ghost block" data-keep="0" id="nextJointBtn">Next joint</label>`;
        // Before without serial: keep a Next photo path so he isn't stuck.
        if (st === 'pre') return `<label for="camInput" class="btn primary big block" data-keep="0" id="nextPhotoBtn">📷 Next photo</label>`;
        // After / repair mids: Same joint keeps SN.
        return `${sn ? `<label for="camInput" class="btn primary big block" data-keep="1">📷 Same joint (SN ${esc(sn)})</label>` : ''}
      <label for="camInput" class="btn ${sn ? 'secondary' : 'primary'} big block" data-keep="0">📷 Next joint</label>`;
      })()}
      <a class="btn ghost block" id="savedHomeBtn" href="#/">Home</a>
      <a class="btn ghost block" id="savedToolsBtn" href="#/tools">🧰 Tools</a>
    </div>`;
  // pointerdown/touchstart fire before the camera sheet steals the page — click alone can lose the race to route()/camBtn.
  $$('[data-keep]').forEach((l) => {
    const arm = () => armKeepFromEl(l);
    l.addEventListener('pointerdown', arm);
    l.addEventListener('touchstart', arm, { passive: true });
    l.addEventListener('click', arm);
  });
}
// Tools (hbp-v30): Add from library + Open folder (moved off the Saved screen).
function renderTools() {
  setChrome({ title: 'Tools', back: '#/', bottom: false });
  const lu = S.meta.lastUsed || {}, ls = S.lastSaved;
  const folder = S.lastListHash && S.lastListHash.startsWith('#/folder/') ? S.lastListHash
    : ls ? `#/folder/${encodeURIComponent(ls.customerId || '')}/${encodeURIComponent(ls.rigId || '')}`
    : `#/folder/${encodeURIComponent(lu.customerId || '')}/${encodeURIComponent(lu.rigId || '')}`;
  const rigId = decodeURIComponent(folder.split('/')[3] || ''), rig = S.rigs.get(rigId);
  view.innerHTML = `<div class="stack" id="toolsPage">
      <label for="libInput" class="btn secondary big block" id="toolsLibBtn">🖼 Add from library</label>
      <a class="btn secondary big block" id="toolsFolderBtn" href="${folder}">📁 Open folder</a>
      ${rig ? `<button type="button" class="btn secondary block" id="toolsRenameBtn">✎ Rename / edit rig (${esc(rig.name)})</button>` : ''}
      <a class="btn ghost block" href="#/">Home</a>
    </div>`;
  const lb = $('#toolsLibBtn'), fresh = () => { S.keepJoint = false; S.pendingKeep = false; S.pendingStage = null; S.keepFrom = null; };
  lb.addEventListener('pointerdown', fresh); lb.addEventListener('touchstart', fresh, { passive: true });
  const rb = $('#toolsRenameBtn'); if (rb) rb.onclick = () => editLookupDialog('rigs', rigId);
}
async function handleFiles(fileList, fromCamera = false) {
  const files = Array.from(fileList || []).filter((f) => !f.type || f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  if (!files.length) return;
  const insp = S.inspection;
  if (insp && insp.ready) { await insp.ready.catch(() => null); await new Promise((r) => setTimeout(r, 0)); } // let its folder view settle first
  const inSession = !!(S.inspection && S.inspection.rigId);
  const addCtx = inSession ? { rigId: S.inspection.rigId, customerId: S.inspection.customerId, ...(S.inspection.pipeSpecId ? { pipeSpecId: S.inspection.pipeSpecId } : {}) } : S.context ? { ...S.context } : null;
  // Prefer durable pendingKeep (armed on CTA pointerdown) over keepJoint — route()/camBtn can clear the latter before change fires.
  // data-stage CTAs (Preheat / After) are always Same-joint; if stage was armed, force keep even if a late camBtn click wiped pendingKeep.
  let keep = (S.pendingKeep != null) ? !!S.pendingKeep : !!S.keepJoint;
  const force = S.pendingStage;
  if (force && STAGES[force]) keep = true;
  // Photo-detail CTA: copy that photo (customer, rig, spec, wire, operator, SN, end, band, notes) onto the new one.
  const from = keep && S.keepFrom ? S.photos.find((x) => x.id === S.keepFrom && !x.deletedAt) : null;
  S.pendingKeep = null; S.pendingStage = null; S.keepJoint = false; S.keepFrom = null;
  const b = busy(files.length > 1 ? `Preparing 1 of ${files.length}…` : 'Preparing photo…');
  const q = []; let failed = 0;
  for (let i = 0; i < files.length; i++) {
    b.update(files.length > 1 ? `Preparing ${i + 1} of ${files.length}…` : null, i / files.length);
    try { q.push(await processFile(files[i])); } catch (e) { console.warn(e); failed++; }
  }
  b.done();
  if (failed) toast(`${failed} file${failed === 1 ? '' : 's'} could not be read${q.length ? ' and were skipped' : ''}.`, 4000);
  if (!q.length) return;
  if (from) S.lastSaved = from;
  S.queue = q; S.qIndex = 0; S.savedCount = 0; S.batchValues = null; S.addContext = addCtx; S.addKeep = keep; S.forceStage = force; S.addInspect = inSession;
  S.addFromCamera = !!fromCamera;
  S.addFromDetail = !!(from && force && STAGES[force]); S.addDetailStage = S.addFromDetail ? force : null;
  if (location.hash === '#/add') route(); else location.hash = '#/add';
}

/* ================= inspection session (Start new job) ================= */
// 🔍 Start new job (was "Start inspection") opens a small sheet: Operator (you), Rig name, Customer, Pipe spec, Wire, then 📷 Open camera. All are
// native <select>s (Rig / Customer offer "＋ Add new…" at the top, which reveals a plain text box); no <datalist> anywhere (iOS
// home-screen apps crashed moving between datalist fields). Rig is required and starts unselected; customer is
// required and starts with the last-used one; pipe spec is one of the four below. "Open camera" is a
// <label for="camInput">: the checks run synchronously in its click handler, so the camera opens inside that same tap
// (iOS only opens a camera picker from a direct tap), and a miss cancels the tap and shows the message instead.
// No work order any more (new photos carry none; photos that already have one keep it in the data, CSV and sync).
const INSP_SPECS = [ // the Start inspection drop-down: exactly these, in this order
  { id: 'spec_45_duo', name: '4.5 Duo', key: '4.5duo' },
  { id: 'spec_45_tsds', name: '4.5 TSDS', key: '4.5tsds' },
  { id: 'spec_5_ptech_r3', name: '5" P-Tech R3', key: '5ptechr3', drop47: true }, // = the old 5" P-Tech 47 R3 entry
  { id: 'spec_5_nc50', name: '5" NC50', key: '5nc50' },
];
const INSP_SPEC_DEFAULT = 'spec_5_ptech_r3';
// Same spec name? Ignores case, spaces, punctuation and quote style (" ” ″), reads 4-1/2 as 4.5; for P-Tech R3 also "47".
const specNorm = (s, drop47) => { let k = String(s || '').toLowerCase().replace(/4\s*-?\s*1\s*\/\s*2/g, '4.5').replace(/[^a-z0-9.]/g, ''); if (drop47) k = k.replace(/47/g, ''); return k; };
// The entry a spec maps onto: an existing (older) entry with the same name wins, so old photos keep their link;
// otherwise the one with the fixed id. Same rule on every phone, so they all agree.
function specEntries(sp) {
  const hits = [...S.pipeSpecs.values()].filter((x) => specNorm(x.description, sp.drop47) === sp.key);
  const old = hits.filter((x) => x.id !== sp.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { keep: old[0] || hits.find((x) => x.id === sp.id) || null, hits };
}
// On load and after each team sync: make sure the four exist (fixed ids: two phones or repeated loads never make
// duplicates), carry exactly these names (a rename goes through the normal edit + sync path), and fold same-name
// duplicates into the kept entry (photos move along; team mode keeps a tombstone, nothing is hard-deleted).
let specEnsuring = null;
function ensurePipeSpecs() { return specEnsuring || (specEnsuring = ensurePipeSpecsNow().finally(() => { specEnsuring = null; })); }
async function ensurePipeSpecsNow() {
  if (!S.pipeSpecs) return;
  for (const sp of INSP_SPECS) {
    let { keep, hits } = specEntries(sp);
    if (!keep) {
      const g = S.gone.pipeSpecs.get(sp.id);
      if (g && g.mergedInto && S.pipeSpecs.has(g.mergedInto)) keep = S.pipeSpecs.get(g.mergedInto);
      else {
        keep = { id: sp.id, description: sp.name, updatedAt: Date.now() };
        await db.put('pipeSpecs', keep); S.pipeSpecs.set(keep.id, keep); S.gone.pipeSpecs.delete(sp.id); markDirty('pipeSpecs', keep.id);
      }
    }
    if (keep.description !== sp.name) {
      const upd = { ...keep, description: sp.name, updatedAt: Date.now() };
      await db.put('pipeSpecs', upd); S.pipeSpecs.set(upd.id, upd); markDirty('pipeSpecs', upd.id); keep = upd;
    }
    for (const x of hits) if (x.id !== keep.id && S.pipeSpecs.has(x.id)) await mergeLookup('pipeSpecs', x.id, keep.id);
  }
}
const inspSpecOptions = () => INSP_SPECS.map((sp) => specEntries(sp).keep).filter(Boolean);
// Rig / Customer: a native <select>: placeholder, then "＋ Add new rig…" / "＋ Add new customer…" at the top, then the
// existing entries. Choosing Add new reveals a plain text box right there (no datalist). Rig starts unselected every time (a new job is often a new rig); customer starts with
// the last-used one. A typed name that already exists (any capitalisation / spacing) reuses that entry.
const normName2 = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (x) => String(x || '').trim().replace(/\s+/g, ' ');
const findLookup = (kind, name) => sortedItems(kind).find((x) => normName2(x[KINDS[kind].field]) === normName2(name));
function pickNewHTML(id, kind, sel, blank, label, newLabel, ph) {
  return `<div class="field"><label for="${id}">${esc(label)}</label>
    <select id="${id}"><option value="" ${sel ? '' : 'selected'}>${esc(blank)}</option><option value="__new">${esc(newLabel)}</option>${opts(kind, sel, '', true)}</select>
    <input id="${id}New" type="text" maxlength="80" placeholder="${esc(ph)}" autocapitalize="words" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="done" hidden>
    <div class="small insp-msg" id="${id}Msg" role="alert"></div></div>`;
}
function startInspectionSheet() {
  const list = inspSpecOptions();
  const lu = S.meta.lastUsed || {};
  const def = (list.find((x) => x.id === lu.pipeSpecId) || list.find((x) => x.id === (specEntries(INSP_SPECS[2]).keep || {}).id) || list[0] || {}).id || '';
  const custDef = S.customers.has(lu.customerId) ? lu.customerId : '';
  const m = openModal(`<h3>Start new job</h3>
    <form id="inspForm" autocomplete="off">
      ${opFieldHTML('inspOp', currentOperator(), { wrapId: 'inspOpField', label: 'Operator (you)' })}
      ${pickNewHTML('inspRigPick', 'rigs', '', '— Pick the rig —', 'Rig name', '＋ Add new rig…', 'Type the new rig name')}
      ${pickNewHTML('inspCustPick', 'customers', custDef, '— Pick the customer —', 'Customer', '＋ Add new customer…', 'Type the new customer name')}
      <div class="field"><label for="inspSpec">Pipe spec</label>
        <select id="inspSpec">${list.length ? list.map((x) => `<option value="${esc(x.id)}" ${x.id === def ? 'selected' : ''}>${esc(x.description)}</option>`).join('') : '<option value="">No pipe spec</option>'}</select></div>
      ${wireFieldHTML('inspWire', currentWire(), { wrapId: 'inspWireField' })}
      <div class="stack form-actions">
        <label for="camInput" class="btn primary big block" id="inspCamBtn">📷 Open camera</label>
        <button type="button" class="btn ghost block" id="inspCancel">Cancel</button>
      </div>
    </form>`);
  const opCtl = bindOpField('inspOp', { onChange: (l) => { if (l) rememberOperator(l, true); } });
  const wireCtl = bindWireField('inspWire');
  // Rig / Customer: what's chosen ({ id } or { name } for a new one), or null with the message to show.
  const pick = (id, what) => {
    const sel = $('#' + id, m), box = $('#' + id + 'New', m), msg = $('#' + id + 'Msg', m);
    if (sel.value === '__new') {
      const name = cleanName(box.value);
      if (!name) return { msg, el: box, text: `Type the new ${what} name first.` };
      return { name };
    }
    if (!sel.value) return { msg, el: sel, text: `Pick the ${what} first.` };
    return { id: sel.value };
  };
  // Pipe spec follows the picked rig's job spec (its last saved photo) until he picks a spec by hand.
  let specTouched = false;
  $('#inspSpec', m).addEventListener('change', () => { specTouched = true; });
  const respec = () => {
    const rigId = $('#inspRigPick', m).value, custId = $('#inspCustPick', m).value;
    if (specTouched || !rigId || rigId === '__new') return;
    const js = rigLastSpec(rigId, custId === '__new' ? '' : custId), sp = $('#inspSpec', m);
    if (!js || sp.value === js) return;
    if (!sp.querySelector(`option[value="${CSS.escape(js)}"]`)) { const o = document.createElement('option'); o.value = js; o.textContent = labelOf('pipeSpecs', js); sp.appendChild(o); }
    sp.value = js;
  };
  for (const id of ['inspRigPick', 'inspCustPick']) {
    const sel = $('#' + id, m), box = $('#' + id + 'New', m), msg = $('#' + id + 'Msg', m);
    sel.addEventListener('change', () => { msg.textContent = ''; box.hidden = sel.value !== '__new'; if (!box.hidden) box.focus(); respec(); });
    box.addEventListener('input', () => { msg.textContent = ''; });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); box.blur(); } }); // keyboard closes; Open camera needs its own tap
  }
  // Everything here is synchronous: on a miss the tap is cancelled (preventDefault, message shown, nothing opens);
  // otherwise the label's own default action opens the camera in this same tap. New entries are saved afterwards.
  $('#inspCamBtn', m).addEventListener('click', (e) => {
    for (const x of [$('#inspRigPickMsg', m), $('#inspCustPickMsg', m)]) x.textContent = '';
    const op = opCtl.adding ? opCtl.commit() : opCtl.value;
    if (!op) { e.preventDefault(); if (!opCtl.adding) opCtl.say('Pick your name first (or ＋ Add new operator).'); return; }
    const rig = pick('inspRigPick', 'rig'), cust = pick('inspCustPick', 'customer');
    const miss = [rig, cust].find((x) => x.msg);
    if (miss) { e.preventDefault(); miss.msg.textContent = miss.text; miss.el.focus(); return; }
    const wire = wireCtl.adding ? wireCtl.commit() : wireCtl.value; // optional; a half-typed new wire is added
    if (wireCtl.adding && !wire) { e.preventDefault(); return; }
    rememberOperator(op, true);
    if (wire) rememberWire(wire, true);
    startInspection({ rig, cust, pipeSpecId: $('#inspSpec', m).value, operator: op, wire });
    setTimeout(() => closeModal(true), 0); // after the tap has opened the camera
  });
  $('#inspCancel', m).onclick = () => closeModal(true);
  $('#inspForm', m).onsubmit = (e) => e.preventDefault();
}
function startInspection({ rig, cust, pipeSpecId, operator, wire = '' }) {
  S.keepJoint = false; S.pendingKeep = null; S.pendingStage = null; S.forceStage = null; S.keepFrom = null;
  const sess = { workOrder: '', rigName: rig.name || labelOf('rigs', rig.id), rigId: rig.id || null, customerId: cust.id || '', pipeSpecId: S.pipeSpecs.has(pipeSpecId) ? pipeSpecId : '',
    count: 0, operator: cleanOp(operator || ''), wire: cleanWire(wire) };
  S.inspection = sess;
  drawInspBar();
  sess.ready = (async () => { // new rig / customer: looked up (any capitalisation) or added, after the camera has opened
    if (!sess.customerId && cust.name) sess.customerId = (findLookup('customers', cust.name) || await createLookup('customers', { name: cust.name })).id;
    if (!sess.rigId) { const r = findLookup('rigs', rig.name) || await createLookup('rigs', { name: rig.name }); sess.rigId = r.id; sess.rigName = r.name; }
    await setMeta('lastUsed', { ...(S.meta.lastUsed || {}), customerId: sess.customerId, rigId: sess.rigId, pipeSpecId: sess.pipeSpecId });
    if (S.inspection === sess) { location.hash = `#/folder/${encodeURIComponent(sess.customerId)}/${encodeURIComponent(sess.rigId)}`; drawInspBar(); }
    return sess.rigId;
  })();
}
function endInspection() { S.inspection = null; S.addInspect = false; drawInspBar(); }
function finishInspection() {
  const sess = S.inspection; if (!sess) return;
  endInspection();
  toast(`Inspection finished${sess.count ? ` — ${sess.count} photo${sess.count === 1 ? '' : 's'}` : ''}`);
  if (sess.rigId) location.hash = `#/folder/${encodeURIComponent(sess.customerId)}/${encodeURIComponent(sess.rigId)}`; else route();
}
function drawInspBar(v) {
  const bar = $('#inspBar'), sess = S.inspection;
  if (v === undefined) v = location.hash.replace(/^#\/?/, '').split('/')[0];
  bar.hidden = !sess;
  if (!sess) return;
  $('#inspRig').textContent = (sess.rigId && labelOf('rigs', sess.rigId)) || sess.rigName || 'No rig';
  $('#inspBarOp').textContent = sess.operator ? ` · 👷 ${sess.operator}` : '';
  $('#inspDone').hidden = v === 'add'; // the photo form has its own Save / Discard
}

/* ================= rejects: rejected-wire log ================= */
// One record per rejected wire: { id, operator ('Name Number'), rejectedAt (ms), rigId, rigName, serialNumber, workOrder,
// note, loggedBy (team sign-in name on the phone), updatedAt, deletedAt? }. Only the operator is required.
// workOrder = optional "Work order #" (Supabase column rejects.work_order, migration 005_reject_work_order.sql).
// Counted per operator by number (opKey), like the photos. Shared through the team-library table public.rejects
// (supabase/migrations/004_rejects.sql); until that table exists they stay on the phone and upload later.
// Delete = soft (deletedAt) in team mode, so the delete reaches the other phones; nothing is hard-deleted.
function rejectCounts() {
  const m = new Map(), label = new Map(); let none = 0;
  for (const r of S.rejects) {
    const k = opKey(r.operator);
    if (!k) { none++; continue; }
    m.set(k, (m.get(k) || 0) + 1);
    if (!label.has(k)) label.set(k, cleanOp(r.operator));
  }
  return { m, label, none };
}
const rejectsOf = (key) => S.rejects.filter((r) => (key === '__none' ? !opKey(r.operator) : opKey(r.operator) === key)).sort((a, b) => b.rejectedAt - a.rejectedAt);
const opLabel = (key, fallback) => (key === '__none' ? 'Unassigned (no operator)' : (operatorRoster().find((o) => o.key === key) || {}).label || fallback || key.slice(2));
const rejectRig = (r) => labelOf('rigs', r.rigId) || r.rigName || '';
function rejectSummaryHTML(curOp) {
  const k = opKey(curOp), today = isoDay(Date.now());
  const mine = k ? S.rejects.filter((r) => opKey(r.operator) === k && isoDay(r.rejectedAt) === today).length : 0;
  return `<a class="rej-sum" id="rejSummary" href="#/rejects"><span>${k ? `Your rejects today: <b id="rejMine">${mine}</b>` : `Rejects logged: <b id="rejMine">${S.rejects.length}</b>`}</span><span class="rej-sum-r">By operator ›</span></a>`;
}
async function logReject({ operator, rigId = '', serialNumber = '', workOrder = '', note = '' }) {
  const now = Date.now();
  const r = { id: 'rj_' + uid(), operator: cleanOp(operator), rejectedAt: now, rigId: rigId || '', rigName: labelOf('rigs', rigId) || '',
    serialNumber: String(serialNumber || '').trim().toUpperCase(), workOrder: String(workOrder || '').trim(), note: String(note || '').trim(),
    loggedBy: S.meta.syncName || '', updatedAt: now };
  await db.put('rejects', r);
  S.rejects.push(r);
  markDirty('rejects', r.id);
  return r;
}
async function removeReject(r) {
  if (!HB_CFG.on) { await db.del('rejects', r.id); S.rejects = S.rejects.filter((x) => x.id !== r.id); return; }
  const now = Date.now(), tomb = { ...r, deletedAt: now, updatedAt: Math.max(now, (r.updatedAt || 0) + 1) };
  await db.put('rejects', tomb);
  S.rejects = S.rejects.filter((x) => x.id !== r.id);
  markDirty('rejects', r.id); // (counts as pending right away)
}
function redrawAfterReject() {
  const h = location.hash;
  if (h === '' || h === '#/' || h.startsWith('#/rejects')) { const y = window.scrollY; route(); window.scrollTo(0, y); }
}
async function undoReject(r) {
  await removeReject(r);
  redrawAfterReject();
  toast('Reject removed');
}
// One tap on "Log rejected wire" + one tap on "Log reject". The operator is pre-picked from the phone; with none set,
// the same pick-your-name dropdown (or Add new operator) must be used first. Rig / serial / note are optional.
function logRejectSheet() {
  const lu = S.meta.lastUsed || {};
  const rigId = (S.inspection && S.inspection.rigId) || (S.rigs.has(lu.rigId) ? lu.rigId : '');
  const m = openModal(`<h3>⛔ Log a rejected wire</h3>
    <p class="muted small">Saved with the operator and the time: <b id="rejWhen">${esc(fmtDate(Date.now()))}</b></p>
    ${opFieldHTML('rejOp', currentOperator(), { wrapId: 'rejOpField', label: 'Operator' })}
    <details class="more-box" id="rejMore"><summary>Add details <span class="muted small" id="rejMoreSum"></span></summary>
      <div class="field"><label for="rejRig">Rig</label><select id="rejRig"><option value="">No rig</option>${opts('rigs', rigId)}</select></div>
      <div class="field"><label for="rejSerial">Serial number</label><input id="rejSerial" type="text" placeholder="Stamped serial / joint #" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off"></div>
      <div class="field"><label for="rejNote">Note</label><input id="rejNote" type="text" maxlength="200" placeholder="e.g. porosity, cracks, bad wire" autocomplete="off"></div>
    </details>
    <div class="stack form-actions">
      <button type="button" class="btn danger solid big block" id="rejOk">⛔ Log reject</button>
      <button type="button" class="btn ghost block" id="rejCancel">Cancel</button>
    </div>`);
  const ctl = bindOpField('rejOp');
  const sum = () => { const rn = labelOf('rigs', $('#rejRig', m).value); $('#rejMoreSum', m).textContent = `rig, serial, note — optional${rn ? ` · Rig: ${rn}` : ''}`; };
  sum();
  $('#rejRig', m).addEventListener('change', sum);
  $('#rejCancel', m).onclick = () => closeModal(true);
  $('#rejOk', m).onclick = async () => {
    const op = ctl.adding ? ctl.commit() : ctl.value;
    if (!op) { if (!ctl.adding) ctl.say('Pick your name first (or ＋ Add new operator).'); return; }
    $('#rejOk', m).disabled = true;
    rememberOperator(op, true);
    let r;
    try { r = await logReject({ operator: op, rigId: $('#rejRig', m).value, serialNumber: $('#rejSerial', m).value, note: $('#rejNote', m).value }); }
    catch (e) { console.error(e); $('#rejOk', m).disabled = false; toast('Could not save: ' + e.message, 5000); return; }
    closeModal(true);
    redrawAfterReject();
    toast(`⛔ Reject logged — ${op}`, 8000, { label: 'Undo', fn: () => undoReject(r) });
  };
}
function renderRejects(key) {
  if (!key) {
    setChrome({ title: 'Rejects', back: '#/', bottom: false });
    const { m, label, none } = rejectCounts();
    const rows = [...m.entries()].map(([k, n]) => ({ key: k, n, label: opLabel(k, label.get(k)) }));
    rows.sort((a, b) => b.n - a.n || byText(a.label, b.label));
    if (none) rows.push({ key: '__none', n: none, label: 'Unassigned (no operator)' });
    for (const o of rows) o.last = rejectsOf(o.key)[0].rejectedAt;
    const waiting = (S.meta.rejectBacklog || []).filter((id) => S.rejects.some((r) => r.id === id)).length;
    view.innerHTML = `
      <div class="card">
        <div class="rej-title">⛔ Rejects by operator</div>
        <div class="muted small" id="rejTotal">${plural(S.rejects.length, 'reject')} logged${Sync.signedIn ? ' by the team' : ' on this phone'}. Tap a name to see the date and time of each one.</div>
        ${waiting && Sync.signedIn ? `<div class="muted small" id="rejWaiting">${plural(waiting, 'reject')} saved on this phone will be shared with the team automatically once the team library is updated.</div>` : ''}
      </div>
      <div id="rejList">${rows.map((o) => `<button type="button" class="list-item rej-row" data-rk="${esc(o.key)}">
        <div class="meta"><b>${o.key === '__none' ? '' : '👷 '}${esc(o.label)}</b><small>Last: ${esc(fmtDate(o.last))}</small></div>
        <span class="rej-count" aria-label="${plural(o.n, 'reject')}">${o.n}</span><span class="chev">›</span></button>`).join('')
        || '<div class="empty" id="rejEmpty">No rejects logged yet.<br>Tap <b>⛔ Log rejected wire</b> to record one.</div>'}</div>
      <div class="stack form-actions">
        <button type="button" class="btn reject-btn big block" id="rejLogBtn">⛔ Log rejected wire</button>
        ${S.rejects.length ? '<button type="button" class="btn ghost block" id="rejCsvBtn">⤓ Rejects list (CSV for Excel)</button>' : ''}
      </div>`;
    $('#rejList').onclick = (e) => { const b = e.target.closest('[data-rk]'); if (b) location.hash = '#/rejects/' + encodeURIComponent(b.dataset.rk); };
    $('#rejLogBtn').onclick = logRejectSheet;
    const cb = $('#rejCsvBtn'); if (cb) cb.onclick = shareRejectsCsv;
    return;
  }
  const list = rejectsOf(key), name = opLabel(key);
  setChrome({ title: 'Rejects', back: '#/rejects', bottom: false });
  view.innerHTML = `
    <div class="card">
      <div class="rej-title" id="rejOpName">${key === '__none' ? '' : '👷 '}${esc(name)}</div>
      <div class="rej-big" id="rejOpCount">${plural(list.length, 'reject')}</div>
      <button type="button" class="op-link" id="rejPhotos" data-op-filter="${esc(key)}">📷 Show photos</button>
    </div>
    <div id="rejItems">${list.map((r) => {
      const d = [rejectRig(r) ? '📁 ' + esc(rejectRig(r)) : '', r.serialNumber ? 'SN ' + esc(r.serialNumber) : '', esc(r.note || '')].filter(Boolean).join(' · ');
      return `<div class="list-item rej-item" data-id="${esc(r.id)}"><div class="meta"><b class="rej-when">${esc(fmtDate(r.rejectedAt))}</b>${d ? `<small>${d}</small>` : ''}</div>
        <button type="button" class="btn ghost rej-del" data-del="${esc(r.id)}" aria-label="Delete this reject">🗑 Delete</button></div>`; }).join('')
      || '<div class="empty">No rejects.</div>'}</div>`;
  $('#rejItems').onclick = async (e) => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    const r = S.rejects.find((x) => x.id === b.dataset.del); if (!r) return;
    const ok = await confirmBox({ title: 'Delete this reject?', ok: 'Delete', danger: true,
      msg: `${esc(fmtDate(r.rejectedAt))} · ${esc(opText(r))}. It comes off the count${Sync.on ? ' on every phone' : ''}.` });
    if (!ok) return;
    await removeReject(r);
    toast('Reject deleted');
    route();
  };
}
function rejectsCsv() {
  const rows = [['rejected', 'operator', 'operator_number', 'rig', 'serial_number', 'work_order', 'note', 'logged_by', 'id']];
  for (const r of S.rejects.slice().sort((a, b) => a.rejectedAt - b.rejectedAt)) {
    rows.push([isoLocal(r.rejectedAt), cleanOp(r.operator), parseOp(r.operator).num, rejectRig(r), r.serialNumber || '', r.workOrder || '', r.note || '', r.loggedBy || '', r.id]);
  }
  return '\ufeff' + rows.map((x) => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function rejectsByOperatorCsv() {
  const { m, label, none } = rejectCounts();
  const rows = [['operator', 'operator_number', 'rejects', 'last_reject']];
  const list = [...m.entries()].map(([k, n]) => ({ k, n, l: opLabel(k, label.get(k)) })).sort((a, b) => b.n - a.n || byText(a.l, b.l));
  for (const o of list) rows.push([o.l, parseOp(o.l).num, o.n, isoLocal(rejectsOf(o.k)[0].rejectedAt)]);
  if (none) rows.push(['Unassigned (no operator)', '', none, isoLocal(rejectsOf('__none')[0].rejectedAt)]);
  return '\ufeff' + rows.map((x) => x.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
async function shareRejectsCsv() {
  const d = new Date(), name = `hardband-rejects_${isoDay(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}.csv`;
  const blob = new Blob([rejectsCsv()], { type: 'text/csv' });
  const file = window.File ? new File([blob], name, { type: 'text/csv' }) : null;
  if (file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); } catch (e) { /* cancelled */ }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Rejects list downloaded');
}

/* ================= manage ================= */
function renderManage(tab) {
  tab = KINDS[tab] ? tab : S.manageTab; S.manageTab = tab;
  const K = KINDS[tab];
  setChrome({ title: 'Manage', back: '#/', bottom: false });
  const items = sortedItems(tab);
  view.innerHTML = `
    <div class="tabs" role="tablist">${Object.entries(KINDS).map(([k, x]) => `<button role="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${x.plural}</button>`).join('')}</div>
    <p class="muted small" style="margin:12px 4px">Tap an item to rename it. Photos link to these entries, so a rename updates every photo instantly.</p>
    <div id="lkList">${items.map((it) => { const n = countUsing(tab, it.id); return `<button class="list-item" data-id="${esc(it.id)}">
      <div class="meta"><b>${esc(it[K.field])}</b>${it.notes ? `<small>${esc(it.notes)}</small>` : ''}<small>${n} photo${n === 1 ? '' : 's'}</small></div><span class="chev">✎</span></button>`; }).join('') || '<div class="empty">None yet.</div>'}</div>
    <button class="btn primary big block" id="addLk" style="margin-top:14px">＋ Add ${K.label.toLowerCase()}</button>`;
  $('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) history.replaceState(null, '', `#/manage/${b.dataset.tab}`), renderManage(b.dataset.tab); };
  $('#lkList').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) editLookupDialog(tab, b.dataset.id); };
  $('#addLk').onclick = async () => { const it = await newLookupDialog(tab); if (it) renderManage(tab); };
}

/* ================= team sign-in (shared library) ================= */
function teamCardHTML() {
  if (!Sync.on) return '';
  const st = Sync.status();
  if (!Sync.signedIn) return `
    <div class="card team-card" id="teamCard">
      <b>Team sign-in</b>
      <p class="muted small">Sign in once with the crew's shared email and password to see and share everyone's photos and tags. Photos already on this phone stay here and are uploaded to the team library.</p>
      <form id="teamForm" autocomplete="on">
        <div class="field"><label for="sbEmail">Team email</label><input id="sbEmail" type="email" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc((Sync.session || {}).email || S.meta.syncEmail || '')}"></div>
        <div class="field"><label for="sbPass">Team password</label><input id="sbPass" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="sbName">Your name (optional — shows who changed what)</label><input id="sbName" type="text" value="${esc(S.meta.syncName || '')}" autocomplete="name"></div>
        <p class="small" id="sbMsg" style="color:var(--danger)">${st.long && st.long.startsWith('Team sign-in expired') ? esc(st.long) : ''}</p>
        <button type="submit" class="btn primary big block" id="sbSignIn">Sign in</button>
      </form>
    </div>`;
  return `
    <div class="card team-card" id="teamCard">
      <b>Team library</b>
      <div class="small" style="margin-top:4px">Signed in as <b id="sbWho">${esc(Sync.session.email || 'team')}</b>${S.meta.syncName ? ` · ${esc(S.meta.syncName)}` : ''}</div>
      <p class="small" id="syncStatusText">${esc(st.long || st.text)}</p>
      ${(S.meta.rejectBacklog || []).length ? `<p class="muted small" id="rejBacklogNote">${plural(S.meta.rejectBacklog.length, 'reject')} saved on this phone will be shared once the team library has the rejects table (owner: run supabase/migrations/004_rejects.sql).</p>` : ''}
      <div class="row"><button class="btn secondary" id="sbSyncNow">⟳ Sync now</button><button class="btn ghost" id="sbSignOut">Sign out</button></div>
    </div>`;
}
function bindTeamCard() {
  const f = $('#teamForm');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#sbEmail').value.trim(), pass = $('#sbPass').value;
    if (!email || !pass) { $('#sbMsg').textContent = 'Enter the team email and password.'; return; }
    $('#sbSignIn').disabled = true; $('#sbMsg').textContent = '';
    try {
      await setMeta('syncEmail', email);
      await Sync.signIn(email, pass, $('#sbName').value);
      toast('Signed in — sharing photos with the team');
      renderBackup();
    } catch (err) {
      $('#sbMsg').textContent = err.kind === 'offline' ? 'No connection — try again when you have signal.' : (err.message || 'Sign-in failed.');
      $('#sbSignIn').disabled = false;
    }
  };
  const sn = $('#sbSyncNow'); if (sn) sn.onclick = () => { Sync.lastError = null; Sync.run('button'); };
  const so = $('#sbSignOut');
  if (so) so.onclick = async () => {
    if (!(await confirmBox({ title: 'Sign out of the team library?', msg: 'Photos stay on this phone. New photos won\'t be shared until you sign in again.', ok: 'Sign out' }))) return;
    await Sync.signOut(); renderBackup();
  };
}

/* ================= backup: export / import ================= */
function exportFileName(p) {
  const band = p.bandNumber ? (p.bandNumber === 'All' ? 'All' : 'B' + p.bandNumber) : 'B0';
  return `${isoDay(p.createdAt)}_${safeToken(p.serialNumber) || 'noSN'}_${p.end || 'NoEnd'}-${band}_${STAGES[stageOf(p)].short}_${p.id}.jpg`;
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
async function renderBackup() {
  setChrome({ title: 'Backup', back: '#/', bottom: false });
  const last = S.meta.lastExport;
  const unbacked = S.photos.filter((p) => (p.addedAt || p.createdAt) > ((last || {}).at || 0)).length;
  const total = S.photos.reduce((n, p) => n + (p.blob ? p.blob.size : 0) + (p.thumb ? p.thumb.size : 0), 0);
  view.innerHTML = `${teamCardHTML()}
    <div class="card">
      <div style="font-weight:800;font-size:20px">${S.photos.length} photo${S.photos.length === 1 ? '' : 's'} ${Sync.signedIn ? 'in the library' : 'on this device'}</div>
      <div class="muted small">≈ ${fmtMB(total)} of photos · <span id="storageInfo">checking storage…</span></div>
      <div class="small" style="margin-top:8px">Last backup: <b>${last ? fmtDate(last.at) + ` (${last.count} photos)` : 'never'}</b>${unbacked ? ` · <b style="color:var(--accent-dark)">${unbacked} new since</b>` : ''}</div>
    </div>
    <div class="card">
      <b>Export backup ZIP</b>
      <p class="muted small">Folders <i>Customer/Rig/</i> with full-size JPEGs, plus metadata.csv (opens in Excel), rejects.csv + rejects_by_operator.csv (rejected wires) and metadata.json (for restoring). Save it to Files / iCloud Drive / OneDrive, or email it.</p>
      <button class="btn primary big block" id="exportBtn" ${S.photos.length || S.rejects.length ? '' : 'disabled'}>⤓ Export ZIP</button>
    </div>
    <div class="card">
      <b>Restore / import</b>
      <p class="muted small">Pick a ZIP made by this app. Photos already on this device (same ID) are kept as-is; missing ones are added.</p>
      <label for="importInput" class="btn secondary block" id="importBtn">⤒ Import backup ZIP</label>
    </div>
    <div class="card small muted">
      Photos live inside this app (browser storage), not in your Photos app. If the app is deleted from the Home Screen or website data is cleared, the photos go with it — export a backup regularly.
    </div>`;
  $('#exportBtn').onclick = exportZip;
  bindTeamCard();
  try {
    const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const el = $('#storageInfo');
    if (el) el.textContent = `${est ? `${fmtMB(est.usage || 0)} used${est.quota ? ` of ~${fmtMB(est.quota)}` : ''} · ` : ''}${persisted ? 'persistent storage ✔' : 'storage not marked persistent'}`;
  } catch (e) { /* ignore */ }
}
async function exportZip() {
  if (typeof JSZip === 'undefined') return toast('ZIP library failed to load.');
  const b = busy('Building backup…');
  try {
    const zip = new JSZip();
    const photos = S.photos.slice().sort((a, b2) => a.createdAt - b2.createdAt);
    const need = photos.filter((p) => !p.blob && p.remoteImage);
    for (let i = 0; i < need.length; i++) {
      b.update(`Downloading ${i + 1} of ${need.length} from team library…`, (i + 1) / need.length * 0.1);
      try { await Sync.ensureBlob(need[i]); } catch (e) { /* skipped below */ }
    }
    let skippedFiles = 0;
    const rows = [['file', 'id', 'taken', 'stage', 'operator', 'work_order', 'wire', 'customer', 'rig', 'rig_notes', 'pipe_spec', 'serial_number', 'end', 'band', 'condition_notes', 'added']];
    const jsonPhotos = [];
    photos.forEach((p, i) => {
      const rig = S.rigs.get(p.rigId) || {};
      const path = `${safeName(labelOf('customers', p.customerId) || 'No customer')}/${safeName(rig.name || 'No rig')}/${exportFileName(p)}`;
      if (p.blob) zip.file(path, p.blob, { binary: true, date: new Date(p.createdAt) }); else skippedFiles++;
      rows.push([path, p.id, isoLocal(p.createdAt), STAGES[stageOf(p)].label, cleanOp(p.operator), p.workOrder || '', p.wire || '', labelOf('customers', p.customerId), rig.name || '', rig.notes || '', labelOf('pipeSpecs', p.pipeSpecId),
        p.serialNumber || '', p.end || '', p.bandNumber || '', p.notes || '', p.addedAt ? isoLocal(p.addedAt) : '']);
      const { blob, thumb, ...meta } = p;
      jsonPhotos.push({ ...meta, stage: stageOf(p), file: path, customer: labelOf('customers', p.customerId), rig: rig.name || '', pipeSpec: labelOf('pipeSpecs', p.pipeSpecId) });
      b.update(`Adding ${i + 1} of ${photos.length}…`, (i + 1) / photos.length * 0.2);
    });
    zip.file('metadata.csv', '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
    if (S.rejects.length) { zip.file('rejects.csv', rejectsCsv()); zip.file('rejects_by_operator.csv', rejectsByOperatorCsv()); }
    const jsonRejects = S.rejects.slice().sort((a, b2) => a.rejectedAt - b2.rejectedAt).map((r) => ({ ...r, rig: rejectRig(r) }));
    zip.file('metadata.json', JSON.stringify({ app: 'hardband-photos', schema: 1, exportedAt: new Date().toISOString(),
      customers: [...S.customers.values()], rigs: [...S.rigs.values()], pipeSpecs: [...S.pipeSpecs.values()], photos: jsonPhotos, rejects: jsonRejects }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' }, (m) => b.update('Zipping…', 0.2 + m.percent / 125));
    const d = new Date();
    const name = `hardband-photos-backup_${isoDay(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`;
    b.done();
    const file = window.File ? new File([blob], name, { type: 'application/zip' }) : null;
    const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const markDone = () => setMeta('lastExport', { at: Date.now(), count: photos.length }).then(() => { if (location.hash === '#/backup') renderBackup(); });
    const m = openModal(`<h3>Backup ready</h3><p class="muted">${photos.length} photos${S.rejects.length ? ` · ${plural(S.rejects.length, 'reject')}` : ''} · ${fmtMB(blob.size)}<br><span class="small">${esc(name)}</span>${skippedFiles ? `<br><span class="small">${skippedFiles} full-size photo(s) not downloaded yet (offline) — only their details are included.</span>` : ''}</p>
      <div class="stack form-actions">
        ${canShare ? '<button class="btn primary big block" id="shareZip">⇪ Share / Save to Files</button>' : ''}
        <button class="btn ${canShare ? 'secondary' : 'primary big'} block" id="dlZip">⤓ Download ZIP</button>
        <button class="btn ghost block" id="closeZip">Close</button></div>`);
    $('#dlZip', m).onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      markDone(); toast('Download started');
    };
    const sz = $('#shareZip', m);
    if (sz) sz.onclick = async () => { try { await navigator.share({ files: [file], title: name }); markDone(); } catch (e) { /* cancelled */ } };
    $('#closeZip', m).onclick = () => closeModal(true);
  } catch (e) { console.error(e); b.done(); toast('Export failed: ' + e.message, 5000); }
}
async function importZip(file) {
  if (!file) return;
  if (typeof JSZip === 'undefined') return toast('ZIP library failed to load.');
  const b = busy('Reading backup…');
  try {
    const zip = await JSZip.loadAsync(file);
    const mf = zip.file('metadata.json');
    if (!mf) throw new Error('metadata.json not found — is this a Hardband Photos backup?');
    const meta = JSON.parse(await mf.async('string'));
    if (meta.app !== 'hardband-photos') throw new Error('Not a Hardband Photos backup.');
    let addedLk = 0;
    for (const [kind, arr] of [['customers', meta.customers], ['rigs', meta.rigs], ['pipeSpecs', meta.pipeSpecs]]) {
      for (const it of arr || []) {
        if (!it || !it.id) continue;
        const cur = S[kind].get(it.id);
        // New entries are added; existing ones are replaced only if the backup copy was edited more recently (e.g. restoring onto a fresh phone).
        if (!cur || (it.updatedAt || 0) > (cur.updatedAt || 0)) { await db.put(KINDS[kind].store, it); S[kind].set(it.id, it); markDirty(KINDS[kind].store, it.id); addedLk++; }
      }
    }
    const list = meta.photos || [];
    let added = 0, skipped = 0, missing = 0;
    const have = new Set(S.photos.map((p) => p.id));
    for (let i = 0; i < list.length; i++) {
      const pm = list[i];
      b.update(`Importing ${i + 1} of ${list.length}…`, (i + 1) / list.length);
      if (!pm.id || have.has(pm.id)) { skipped++; continue; }
      const zf = zip.file(pm.file);
      if (!zf) { missing++; continue; }
      const blob = new Blob([await zf.async('arraybuffer')], { type: 'image/jpeg' });
      let thumb = null, w = pm.width, h = pm.height;
      try { const img = await loadImage(blob); thumb = (await drawScaled(img, 400, 0.72)).blob; w = w || img.naturalWidth; h = h || img.naturalHeight; } catch (e) { /* keep without thumb */ }
      const { file: _f, customer: _c, rig: _r, pipeSpec: _s, ...rest } = pm;
      const { remoteImage: _ri, remoteThumb: _rt, deletedAt: _d, ...clean } = rest;
      const rec = { ...clean, blob, thumb, width: w, height: h };
      await putPhoto(rec); S.photos.push(rec); have.add(rec.id); markDirty('photos', rec.id); added++;
    }
    // Rejects: missing ones are added (same id = already here, even if deleted on this phone since).
    let addedRej = 0;
    for (const rm of meta.rejects || []) {
      if (!rm || !rm.id || await db.get('rejects', rm.id)) continue;
      const { rig: _rg, deletedAt: _dd, ...rec } = rm;
      await db.put('rejects', rec); S.rejects.push(rec); markDirty('rejects', rec.id); addedRej++;
    }
    b.done();
    toast(`Imported ${added} photo${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already here` : ''}${missing ? `, ${missing} missing` : ''}${addedRej ? `, ${plural(addedRej, 'reject')}` : ''}${addedLk ? `, ${addedLk} rig/customer/spec entries updated` : ''}.`, 5000);
    route();
  } catch (e) { console.error(e); b.done(); toast('Import failed: ' + e.message, 6000); }
}

/* ================= boot ================= */
async function init() {
  $('#backupBtn').onclick = () => { location.hash = '#/backup'; };
  $('#syncBadge').onclick = () => { location.hash = '#/backup'; };
  $('#manageBtn').onclick = () => { location.hash = '#/manage/' + S.manageTab; };
  // Bottom-bar / library = fresh capture. Arm on pointerdown/touchstart only — NOT click.
  // click can be synthesized when another <label for="camInput"> (After photo CTA) activates the same input,
  // which used to wipe pendingKeep/pendingStage and turn After into Next joint (D7 / HP 249).
  const armFreshCapture = () => { S.keepJoint = false; S.pendingKeep = false; S.pendingStage = null; S.keepFrom = null; };
  for (const id of ['#camBtn', '#libBtn']) {
    const el = $(id);
    el.addEventListener('pointerdown', armFreshCapture);
    el.addEventListener('touchstart', armFreshCapture, { passive: true });
  }
  $('#inspBtn').onclick = startInspectionSheet;
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-op-filter]'); if (!b) return; e.preventDefault(); applyOperatorFilter(b.dataset.opFilter === '__none' ? '__none' : b.dataset.opFilter); });
  $('#inspDone').onclick = () => finishInspection();
  for (const id of ['#camInput', '#libInput']) {
    const inp = $(id);
    inp.addEventListener('change', () => { const f = Array.from(inp.files || []); inp.value = ''; handleFiles(f, id === '#camInput'); });
  }
  const imp = $('#importInput');
  imp.addEventListener('change', () => { const f = imp.files && imp.files[0]; imp.value = ''; importZip(f); });
  try {
    await openDB();
    await seedIfNeeded();
    await loadAll();
    await ensurePipeSpecs().catch((e) => console.warn('pipe specs', e));
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><b>Storage unavailable.</b><p>${esc(e.message || e)}</p><p class="muted small">Private Browsing can block on-device storage. Open in normal Safari or from the Home Screen icon.</p></div>`;
    return;
  }
  askPersist();
  route();
  Sync.init().catch((e) => console.warn('sync init', e));
  Upd.init();
}

/* ================= app updates ("A new version of the app is ready") ================= */
// sw.js installs a new version in the background (bypassing the HTTP cache) and takes over right away (skipWaiting +
// clients.claim), but a page that is already open keeps running the code it loaded. So the app checks for a new
// version at launch and whenever it comes back to the foreground (at most once a minute), asks the service worker
// which version it has, and if that is newer than this page shows a banner under the header. It never reloads by
// itself: only the Update tap does. With an unsaved photo / photo edit or an inspection in progress the tap asks first;
// while a sheet is open (Start inspection, Log rejected wire, a busy export…) its backdrop covers the banner, so typed
// input is never lost. Queued team sync is in IndexedDB (the outbox), so it simply carries on after the reload.
const APP_VERSION = 'hbp-v32'; // keep equal to VERSION in sw.js (the test suite checks)
const verNum = (v) => { const m = /^hbp-v(\d+)$/.exec(String(v || '')); return m ? Number(m[1]) : 0; };
// What would an update interrupt right now? '' = nothing.
function unsavedWork() {
  if ($('#modalRoot').innerHTML) return 'sheet';
  const v = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (v === 'add' && S.queue.length > S.qIndex) return 'photo';
  if (v === 'edit') return 'edit';
  if (S.inspection) return 'inspection';
  return '';
}
const UPD_ASK = {
  photo: { title: 'You have an unsaved photo. Save it first, or update anyway?', cancel: 'Save it first' },
  edit: { title: 'You have unsaved photo changes. Save them first, or update anyway?', cancel: 'Save them first' },
  inspection: { title: 'An inspection is in progress. Finish it first, or update anyway?', cancel: 'Keep inspecting',
    msg: 'Photos you already saved are kept either way. After the update, tap Start new job again.' },
};
const Upd = {
  reg: null, ready: '', dismissed: false, lastCheck: 0, minGap: 60000, checks: 0, sawControllerChange: false,
  early() { // as soon as the script runs, so a takeover during startup isn't missed
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => { this.sawControllerChange = true; this.evaluate(false); }); // prompt, never reload
  },
  init() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      this.reg = reg;
      reg.addEventListener('updatefound', () => this.watch(reg.installing));
      this.watch(reg.installing);
      this.check(true);
    }).catch((e) => console.warn('SW registration failed', e));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) this.check(); });
    window.addEventListener('resize', () => this.place());
  },
  watch(w) { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' || w.state === 'activated') this.evaluate(false); }); },
  async check(force) {
    if (!this.reg || (!force && Date.now() - this.lastCheck < this.minGap)) return;
    this.lastCheck = Date.now(); this.checks++;
    try { await this.reg.update(); } catch (e) { /* offline: next time */ }
    await this.evaluate(true);
  },
  // The version of a service worker (workers older than hbp-v14 don't answer: '').
  swVersion(w) {
    return new Promise((resolve) => {
      if (!w || typeof MessageChannel === 'undefined') return resolve('');
      const ch = new MessageChannel(), t = setTimeout(() => resolve(''), 3000);
      ch.port1.onmessage = (e) => { clearTimeout(t); resolve((e.data && e.data.version) || ''); };
      try { w.postMessage({ type: 'version' }, [ch.port2]); } catch (e) { clearTimeout(t); resolve(''); }
    });
  },
  // A finished (installed or active) newer version = ready. A check shows the banner again even after "Not now".
  async evaluate(fromCheck) {
    const r = this.reg || await navigator.serviceWorker.getRegistration().catch(() => null);
    if (!r) return;
    const v = await this.swVersion(r.waiting || r.active);
    if (verNum(v) <= verNum(APP_VERSION)) return;
    this.ready = v;
    if (fromCheck || !this.dismissed) { this.dismissed = false; this.show(); }
  },
  bar() {
    let b = $('#updBar');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'updBar'; b.className = 'insp-bar upd-bar'; b.setAttribute('role', 'status'); b.hidden = true;
    b.innerHTML = `<span class="insp-text" id="updText">A new version of the app is ready. Tap to update.</span>
      <button type="button" class="btn primary insp-done" id="updBtn">Update</button>
      <button type="button" class="btn ghost insp-done" id="updLater">Not now</button>`;
    $('#topbar').after(b);
    $('#updBtn').onclick = () => this.apply();
    $('#updLater').onclick = () => this.dismiss();
    return b;
  },
  show() { this.bar().hidden = false; this.place(); },
  place() { const b = $('#updBar'); if (b && !b.hidden) b.style.top = $('#topbar').offsetHeight + 'px'; },
  dismiss() { this.dismissed = true; const b = $('#updBar'); if (b) b.hidden = true; },
  async apply() {
    const what = unsavedWork();
    if (what === 'sheet') return; // a sheet is open (its backdrop covers the banner): never drop what was typed
    if (what) {
      const a = UPD_ASK[what];
      if (!(await confirmBox({ title: a.title, msg: a.msg ? esc(a.msg) : '', ok: 'Update anyway', cancel: a.cancel }))) return;
    }
    const btn = $('#updBtn'); if (btn) btn.disabled = true;
    try { await outboxCount(); } catch (e) { /* */ } // waits for any just-queued sync entry to finish writing; IndexedDB keeps it across the reload
    const r = this.reg;
    if (r && r.waiting) { // normally the new version has already taken over; if it's still waiting, let it in first
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
      r.waiting.postMessage({ type: 'skipWaiting' });
      setTimeout(() => location.reload(), 3000);
      return;
    }
    location.reload();
  },
};
Upd.early();
init();
