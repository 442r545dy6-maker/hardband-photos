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
const DB_VER = 2; // v2 adds the 'outbox' store for team sync (existing data untouched)
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
  rigs: new Map(), customers: new Map(), pipeSpecs: new Map(), photos: [], meta: {},
  gone: { rigs: new Map(), customers: new Map(), pipeSpecs: new Map() }, // deleted/merged entries (team sync tombstones)
  search: { q: '', customerId: '', rigId: '', end: '', from: '', to: '' }, showFilters: false,
  queue: [], qIndex: 0, savedCount: 0, batchValues: null, lastSaved: null, keepJoint: false,
  context: null, addContext: null, lastListHash: '#/', lastList: [], manageTab: 'rigs',
  viewUrls: [], scroll: {}, modalCancel: null,
};
const KINDS = {
  rigs: { store: 'rigs', field: 'name', label: 'Rig', plural: 'Rigs', ref: 'rigId', notes: true, prefix: 'r' },
  customers: { store: 'customers', field: 'name', label: 'Customer', plural: 'Customers', ref: 'customerId', prefix: 'c' },
  pipeSpecs: { store: 'pipeSpecs', field: 'description', label: 'Pipe spec', plural: 'Pipe specs', ref: 'pipeSpecId', prefix: 's' },
};
const labelOf = (kind, id) => { const it = S[kind].get(id) || S.gone[kind].get(id); return it ? it[KINDS[kind].field] : ''; };
const sortedItems = (kind) => [...S[kind].values()].sort((a, b) => byText(a[KINDS[kind].field], b[KINDS[kind].field]));
const countUsing = (kind, id) => S.photos.filter((p) => p[KINDS[kind].ref] === id).length;

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
  const [r, c, s, p, m] = await Promise.all([db.all('rigs'), db.all('customers'), db.all('pipeSpecs'), db.all('photos'), db.all('meta')]);
  for (const [kind, list] of [['rigs', r], ['customers', c], ['pipeSpecs', s]]) {
    S[kind] = new Map(list.filter((x) => !x.deletedAt).map((x) => [x.id, x]));
    S.gone[kind] = new Map(list.filter((x) => x.deletedAt).map((x) => [x.id, x]));
  }
  S.photos = p.filter((x) => !x.deletedAt).map((x) => ({ ...x, blob: storedToBlob(x.blob), thumb: storedToBlob(x.thumb) }));
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
function setChrome({ title, back = null, bottom = true }) {
  $('#title').textContent = title;
  const bb = $('#backBtn');
  bb.hidden = !back;
  bb.onclick = back ? () => { if (typeof back === 'function') back(); else location.hash = back; } : null;
  $('#bottombar').hidden = !bottom;
  document.body.style.paddingBottom = bottom ? '' : 'calc(24px + env(safe-area-inset-bottom, 0px))';
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
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
function confirmBox({ title, msg = '', ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3>${msg ? `<p>${msg}</p>` : ''}
      <div class="row form-actions"><button class="btn ghost" data-a="no">Cancel</button>
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
  if (dup) { toast(`${K.label} "${name}" already exists — selected it.`); return dup; }
  const item = { id: `${K.prefix}_${uid()}`, [K.field]: name, updatedAt: Date.now() };
  if (K.notes) item.notes = vals.notes || '';
  await db.put(K.store, item);
  S[kind].set(item.id, item);
  markDirty(K.store, item.id);
  return item;
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
  if (v !== 'saved') S.keepJoint = false;
  try {
    if (v === '') renderHome();
    else if (v === 'folder') renderFolder(parts[1], parts[2]);
    else if (v === 'photo') renderPhoto(parts[1]);
    else if (v === 'edit') renderForm('edit', parts[1]);
    else if (v === 'add') renderForm('add');
    else if (v === 'saved') renderSaved();
    else if (v === 'manage') renderManage(parts[1]);
    else if (v === 'backup') renderBackup();
    else { location.hash = '#/'; return; }
  } catch (e) { console.error(e); view.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div>`; }
  window.scrollTo(0, S.scroll[location.hash] || 0);
}
window.addEventListener('hashchange', (e) => {
  try { S.scroll[new URL(e.oldURL).hash || '#/'] = window.scrollY; } catch (_) { /* ignore */ }
  route();
});

/* ================= home: folders + search ================= */
const hasSearch = () => { const s = S.search; return !!(s.q.trim() || s.customerId || s.rigId || s.end || s.from || s.to); };
const filterCount = () => { const s = S.search; return [s.customerId, s.rigId, s.end, s.from, s.to].filter(Boolean).length; };
function haystack(p) {
  return [labelOf('customers', p.customerId), labelOf('rigs', p.rigId), (S.rigs.get(p.rigId) || {}).notes, labelOf('pipeSpecs', p.pipeSpecId),
    p.serialNumber, p.end, p.bandNumber ? 'B' + p.bandNumber : '', p.notes, isoDay(p.createdAt)].join(' \u0001 ').toLowerCase();
}
function searchPhotos() {
  const s = S.search;
  const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
  return S.photos.filter((p) => {
    if (s.customerId && p.customerId !== s.customerId) return false;
    if (s.rigId && p.rigId !== s.rigId) return false;
    if (s.end && p.end !== s.end) return false;
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
  return `<a class="tile" href="#/photo/${encodeURIComponent(p.id)}" data-id="${esc(p.id)}"><img loading="lazy" src="${thumbUrl(p)}" alt="${esc(cap)}"><span class="cap">${esc(cap)}<span class="cap2">${esc(sub)}</span></span></a>`;
}
const opts = (kind, sel, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
  sortedItems(kind).map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x[KINDS[kind].field])}</option>`).join('');

function renderHome() {
  S.lastListHash = '#/'; S.context = null;
  setChrome({ title: 'Hardband Photos', bottom: true });
  const s = S.search, fc = filterCount();
  view.innerHTML = `
    <div class="searchbar">
      <input id="q" type="search" placeholder="Search serial, rig, notes…" value="${esc(s.q)}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" aria-label="Search">
      <button id="filterBtn" class="btn ghost" aria-expanded="${S.showFilters}">Filter${fc ? `<span class="chip-count">${fc}</span>` : ''}</button>
    </div>
    <div id="filters" class="filters card" ${S.showFilters ? '' : 'hidden'}>
      <div><label for="fC">Customer</label><select id="fC">${opts('customers', s.customerId, 'Any customer')}</select></div>
      <div><label for="fR">Rig</label><select id="fR">${opts('rigs', s.rigId, 'Any rig')}</select></div>
      <div><label for="fE">End</label><select id="fE"><option value="">Box or Pin</option><option ${s.end === 'Box' ? 'selected' : ''}>Box</option><option ${s.end === 'Pin' ? 'selected' : ''}>Pin</option></select></div>
      <div></div>
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
  bind('#fC', 'customerId'); bind('#fR', 'rigId'); bind('#fE', 'end'); bind('#fFrom', 'from'); bind('#fTo', 'to');
  $('#fClear').onclick = () => { Object.assign(s, { q: '', customerId: '', rigId: '', end: '', from: '', to: '' }); renderHome(); };
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
    body.innerHTML = `<div class="result-count" id="resultCount">${res.length} photo${res.length === 1 ? '' : 's'} found</div>` +
      (res.length ? `<div class="grid" id="results">${res.map((p) => tileHTML(p, true)).join('')}</div>` : `<div class="empty">No matches.</div>`);
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
  body.innerHTML = custs.map((ck) => {
    const rigs = groups.get(ck);
    const total = [...rigs.values()].reduce((n, a) => n + a.length, 0);
    const rows = [...rigs.keys()].sort((a, b) => byText(labelOf('rigs', a) || '~', labelOf('rigs', b) || '~')).map((rk) => {
      const list = rigs.get(rk).slice().sort((a, b) => b.createdAt - a.createdAt);
      const rig = S.rigs.get(rk) || {};
      const joints = new Set(list.map((p) => p.serialNumber || '')).size;
      return `<a class="folder" href="#/folder/${encodeURIComponent(ck)}/${encodeURIComponent(rk)}" data-rig="${esc(rig.name || '')}">
        <img src="${thumbUrl(list[0])}" alt="">
        <div class="meta"><b>📁 ${esc(rig.name || 'No rig')}</b>
          <small>${list.length} photo${list.length === 1 ? '' : 's'} · ${joints} joint${joints === 1 ? '' : 's'} · last ${fmtShort(list[0].createdAt)}</small>
          ${rig.notes ? `<small>${esc(rig.notes)}</small>` : ''}</div>
        <span class="chev">›</span></a>`;
    }).join('');
    return `<h2 class="cust-head">${esc(labelOf('customers', ck) || 'No customer')} <span class="count">${total}</span></h2>${rows}`;
  }).join('');
}

/* ================= folder ================= */
function folderPhotos(ck, rk) { return S.photos.filter((p) => (p.customerId || '') === (ck || '') && (p.rigId || '') === (rk || '')); }
function jointGroups(list) {
  const m = new Map();
  for (const p of list) { const k = p.serialNumber || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  const endOrd = { Box: 0, Pin: 1 };
  const groups = [...m.entries()].map(([sn, ps]) => ({ sn, ps: ps.sort((a, b) => (endOrd[a.end] ?? 2) - (endOrd[b.end] ?? 2) || String(a.bandNumber).localeCompare(String(b.bandNumber)) || a.createdAt - b.createdAt), latest: Math.max(...ps.map((p) => p.createdAt)) }));
  return groups.sort((a, b) => b.latest - a.latest);
}
function renderFolder(ck, rk) {
  const list = folderPhotos(ck, rk);
  const rig = S.rigs.get(rk);
  S.context = { customerId: ck, rigId: rk };
  S.lastListHash = location.hash;
  setChrome({ title: `${labelOf('customers', ck) || 'No customer'} / ${rig ? rig.name : 'No rig'}`, back: '#/', bottom: true });
  const groups = jointGroups(list);
  S.lastList = groups.flatMap((g) => g.ps.map((p) => p.id));
  view.innerHTML = `
    <div class="card">
      <div class="muted small">${esc(labelOf('customers', ck) || 'No customer')}</div>
      <div style="font-size:22px;font-weight:800" id="folderRigName">${esc(rig ? rig.name : 'No rig')}</div>
      ${rig && rig.notes ? `<div class="muted small" style="margin-top:4px">${esc(rig.notes)}</div>` : ''}
      <div class="muted small" style="margin-top:6px">${list.length} photo${list.length === 1 ? '' : 's'} · ${groups.length} joint${groups.length === 1 ? '' : 's'}. New photos taken here go in this folder.</div>
      ${rig ? `<button class="btn ghost block" id="editRigBtn" style="margin-top:10px">✎ Rename / edit rig</button>` : ''}
    </div>
    ${list.length ? groups.map((g) => `<div class="sn-head">${g.sn ? 'SN ' + esc(g.sn) : 'No serial number'} <span class="muted">(${g.ps.length})</span></div>
      <div class="grid">${g.ps.map((p) => tileHTML(p, false)).join('')}</div>`).join('') : '<div class="empty">No photos in this folder.</div>'}`;
  const eb = $('#editRigBtn'); if (eb) eb.onclick = () => editLookupDialog('rigs', rk);
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
        <dt>Customer</dt><dd>${esc(labelOf('customers', p.customerId) || '—')}</dd>
        <dt>Rig</dt><dd>${esc(rig.name || '—')}${rig.notes ? `<div class="muted small">${esc(rig.notes)}</div>` : ''}</dd>
        <dt>Pipe spec</dt><dd>${esc(labelOf('pipeSpecs', p.pipeSpecId) || '—')}</dd>
        <dt>Serial #</dt><dd>${esc(p.serialNumber || '—')}</dd>
        <dt>End</dt><dd>${esc(p.end || '—')}</dd>
        <dt>Band</dt><dd>${p.bandNumber ? (p.bandNumber === 'All' ? 'All / whole connection' : 'Band ' + esc(p.bandNumber)) : '—'}</dd>
        <dt>Condition</dt><dd style="white-space:pre-wrap">${esc(p.notes || '—')}</dd>
        <dt>Taken</dt><dd>${fmtDate(p.createdAt)}${p.dateSource === 'capture' ? ' <span class="muted small">(save time)</span>' : ''}</dd>
        <dt>Size</dt><dd>${p.width || '?'}×${p.height || '?'} · ${Math.round((p.blob ? p.blob.size : 0) / 1024)} KB</dd>
      </dl>
    </div>
    <div class="stack form-actions">
      <a class="btn primary big block" id="editBtn" href="#/edit/${encodeURIComponent(p.id)}">✎ Edit details / move</a>
      ${canShare ? '<button class="btn secondary block" id="shareBtn">⇪ Share / save to Photos</button>' : ''}
      <a class="btn ghost block" href="${folderHash}">📁 Open folder</a>
      <button class="btn danger block" id="delBtn">🗑 Delete photo</button>
    </div>`;
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

/* ================= add / edit form ================= */
// Condition quick-pick buttons (they only add text to the notes box; existing notes are never changed).
const CHIPS = ['Good', 'Rejected wire', 'Excessive porosity', 'Cracks', 'Needs repair', 'Eccentric band'];
function renderForm(mode, id) {
  let p = null, item = null, vals;
  if (mode === 'edit') {
    p = S.photos.find((x) => x.id === id);
    if (!p) { location.hash = '#/'; return; }
    vals = { customerId: p.customerId, rigId: p.rigId, pipeSpecId: p.pipeSpecId, serialNumber: p.serialNumber || '', end: p.end || '', bandNumber: p.bandNumber || '', notes: p.notes || '', createdAt: p.createdAt };
    setChrome({ title: 'Edit photo', back: `#/photo/${encodeURIComponent(id)}`, bottom: false });
  } else {
    item = S.queue[S.qIndex];
    if (!item) { location.hash = '#/'; return; }
    const lu = S.meta.lastUsed || {};
    vals = { customerId: lu.customerId || '', rigId: lu.rigId || '', pipeSpecId: lu.pipeSpecId || '', serialNumber: '', end: '', bandNumber: '', notes: '' };
    if (S.addContext) Object.assign(vals, S.addContext);
    if (S.addKeep && S.lastSaved) Object.assign(vals, { customerId: S.lastSaved.customerId, rigId: S.lastSaved.rigId, pipeSpecId: S.lastSaved.pipeSpecId, serialNumber: S.lastSaved.serialNumber || '', end: S.lastSaved.end || '' });
    if (S.batchValues) Object.assign(vals, { ...S.batchValues, bandNumber: '', notes: '' });
    setChrome({ title: S.queue.length > 1 ? `Add photo ${S.qIndex + 1} of ${S.queue.length}` : 'Add photo', back: discardQueue, bottom: false });
  }
  for (const [k, kind] of [['customerId', 'customers'], ['rigId', 'rigs'], ['pipeSpecId', 'pipeSpecs']]) if (vals[k] && !S[kind].has(vals[k])) vals[k] = '';
  const srcBlob = mode === 'edit' ? (p.blob || p.thumb) : item.blob;
  const src = srcBlob ? viewUrl(srcBlob) : '';
  const remaining = mode === 'add' ? S.queue.length - S.qIndex : 0;
  const serials = [...new Set(S.photos.filter((x) => x.rigId === vals.rigId && x.serialNumber).sort((a, b) => b.createdAt - a.createdAt).map((x) => x.serialNumber))].slice(0, 30);
  const selectHTML = (kind, key, idAttr) => `<select id="${idAttr}" data-kind="${kind}">${vals[key] ? '' : '<option value="">— choose —</option>'}${opts(kind, vals[key])}<option value="__new">＋ New ${KINDS[kind].label.toLowerCase()}…</option></select>`;
  view.innerHTML = `
    <img class="preview" src="${src}" alt="Photo preview">
    <p class="qinfo">${mode === 'add' ? `Taken ${fmtDate(item.createdAt)}${item.dateSource === 'exif' ? ' (from photo)' : ''}` : ''}</p>
    <form id="photoForm" class="card" autocomplete="off">
      <div class="field"><label for="fCustomer">Customer</label>${selectHTML('customers', 'customerId', 'fCustomer')}</div>
      <div class="field"><label for="fRig">Rig</label>${selectHTML('rigs', 'rigId', 'fRig')}</div>
      <div class="field"><label for="fSpec">Pipe spec</label>${selectHTML('pipeSpecs', 'pipeSpecId', 'fSpec')}</div>
      <div class="field"><label for="fSerial">Serial number</label>
        <input id="fSerial" type="text" list="snList" value="${esc(vals.serialNumber)}" placeholder="Stamped serial / joint #" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="done">
        <datalist id="snList">${serials.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
      <div class="field"><span class="lbl">End</span><div class="seg" id="fEnd">
        <button type="button" data-v="Box">Box</button><button type="button" data-v="Pin">Pin</button></div></div>
      <div class="field"><span class="lbl">Band</span><div class="seg band" id="fBand"></div>
        <div class="band-diagram" id="bandHint"></div></div>
      <div class="field"><label for="fNotes">Condition / notes</label>
        <textarea id="fNotes" placeholder="Wear, cracks, height above OD, rebuild needed…">${esc(vals.notes)}</textarea>
        <div class="chips">${CHIPS.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
      ${mode === 'edit' ? `<div class="field"><label for="fDate">Date / time taken</label><input id="fDate" type="datetime-local" value="${dtLocalValue(vals.createdAt)}"></div>` : ''}
      <div class="stack form-actions">
        ${mode === 'edit'
    ? `<button type="submit" class="btn primary big block" id="saveBtn">Save changes</button><a class="btn ghost block" href="#/photo/${encodeURIComponent(id)}">Cancel</a>`
    : `<button type="submit" class="btn primary big block" id="saveBtn">${remaining > 1 ? `Save &amp; next (${remaining - 1} left)` : 'Save photo'}</button>
           ${remaining > 1 ? `<button type="button" class="btn secondary block" id="saveAllBtn">Save all ${remaining} with these details</button>` : ''}
           <button type="button" class="btn danger block" id="discardBtn">Discard this photo</button>`}
      </div>
    </form>`;

  let end = vals.end, band = vals.bandNumber;
  const drawSeg = () => {
    $$('#fEnd button').forEach((b) => b.classList.toggle('on', b.dataset.v === end));
    const choices = end === 'Pin' ? ['1', '2', 'All'] : ['1', '2', '3', 'All'];
    if (band && !choices.includes(band)) band = '';
    $('#fBand').innerHTML = choices.map((c) => `<button type="button" data-v="${c}" class="${c === band ? 'on' : ''}">${c === 'All' ? 'All / whole' : c}</button>`).join('');
    $('#bandHint').textContent = end === 'Pin' ? 'Pin has 2 bands.' : end === 'Box' ? 'Box has 3 bands.' : 'Box has 3 bands, Pin has 2. Pick an end first.';
  };
  drawSeg();
  $('#fEnd').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; end = b.dataset.v; drawSeg(); };
  $('#fBand').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; band = band === b.dataset.v ? '' : b.dataset.v; drawSeg(); };
  $('.chips').onclick = (e) => {
    const c = e.target.closest('[data-chip]'); if (!c) return;
    const ta = $('#fNotes'); const cur = ta.value.trim();
    ta.value = cur ? `${cur}${/[.,;]$/.test(cur) ? '' : ','} ${c.dataset.chip}` : c.dataset.chip;
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
    serialNumber: $('#fSerial').value.trim().toUpperCase(), end, bandNumber: band, notes: $('#fNotes').value.trim(),
  });
  $('#photoForm').onsubmit = async (e) => {
    e.preventDefault();
    const v = collect();
    $('#saveBtn').disabled = true;
    try {
      if (mode === 'edit') {
        const d = $('#fDate').value ? new Date($('#fDate').value).getTime() : p.createdAt;
        Object.assign(p, v, { updatedAt: Date.now() });
        if (!isNaN(d) && d !== new Date(dtLocalValue(vals.createdAt)).getTime()) { p.createdAt = d; p.dateSource = 'manual'; }
        await putPhoto(p); markDirty('photos', p.id);
        toast('Saved');
        S.lastListHash = `#/folder/${encodeURIComponent(p.customerId || '')}/${encodeURIComponent(p.rigId || '')}`;
        history.replaceState(null, '', `#/photo/${encodeURIComponent(p.id)}`); route();
      } else {
        await saveQueued(v);
        advanceQueue();
      }
    } catch (err) { console.error(err); toast('Save failed: ' + err.message, 5000); $('#saveBtn').disabled = false; }
  };
  const sa = $('#saveAllBtn');
  if (sa) sa.onclick = async () => {
    const v = collect(); const b = busy('Saving…'); const n = S.queue.length - S.qIndex;
    try { for (let k = 0; k < n; k++) { b.update(`Saving ${k + 1} of ${n}…`, (k + 1) / n); await saveQueued(v); S.qIndex++; } }
    catch (err) { b.done(); toast('Save failed: ' + err.message, 5000); return; }
    b.done(); finishQueue();
  };
  const db2 = $('#discardBtn');
  if (db2) db2.onclick = async () => { if (await confirmBox({ title: 'Discard this photo?', ok: 'Discard', danger: true })) { S.qIndex++; S.batchValues = S.batchValues || null; S.qIndex < S.queue.length ? route() : finishQueue(); } };
}
async function saveQueued(v) {
  const it = S.queue[S.qIndex];
  const now = Date.now();
  const p = { id: uid(), blob: it.blob, thumb: it.thumb, width: it.width, height: it.height, createdAt: it.createdAt, dateSource: it.dateSource, addedAt: now, updatedAt: now, origName: it.origName, ...v };
  await putPhoto(p);
  S.photos.push(p);
  markDirty('photos', p.id);
  S.lastSaved = p; S.batchValues = { customerId: v.customerId, rigId: v.rigId, pipeSpecId: v.pipeSpecId, serialNumber: v.serialNumber, end: v.end };
  S.savedCount++;
  await setMeta('lastUsed', { customerId: v.customerId, rigId: v.rigId, pipeSpecId: v.pipeSpecId });
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
      <p class="muted">${esc(labelOf('customers', p.customerId) || '—')} / ${esc(labelOf('rigs', p.rigId) || '—')}${p.serialNumber ? ' · SN ' + esc(p.serialNumber) : ''}</p></div>
    <div class="stack">
      ${p.serialNumber ? `<label for="camInput" class="btn primary big block" data-keep="1">📷 Same joint (SN ${esc(p.serialNumber)})</label>` : ''}
      <label for="camInput" class="btn ${p.serialNumber ? 'secondary' : 'primary'} big block" data-keep="0">📷 Next joint</label>
      <label for="libInput" class="btn ghost block" data-keep="0">🖼 Add from library</label>
      <a class="btn ghost block" id="openFolderBtn" href="${folderHash}">📁 Open folder</a>
      <a class="btn ghost block" href="#/">Home</a>
    </div>`;
  $$('[data-keep]').forEach((l) => l.addEventListener('click', () => { S.keepJoint = l.dataset.keep === '1'; }));
}
async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => !f.type || f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  if (!files.length) return;
  const addCtx = S.context ? { ...S.context } : null;
  const keep = S.keepJoint; S.keepJoint = false;
  const b = busy(files.length > 1 ? `Preparing 1 of ${files.length}…` : 'Preparing photo…');
  const q = []; let failed = 0;
  for (let i = 0; i < files.length; i++) {
    b.update(files.length > 1 ? `Preparing ${i + 1} of ${files.length}…` : null, i / files.length);
    try { q.push(await processFile(files[i])); } catch (e) { console.warn(e); failed++; }
  }
  b.done();
  if (failed) toast(`${failed} file${failed === 1 ? '' : 's'} could not be read${q.length ? ' and were skipped' : ''}.`, 4000);
  if (!q.length) return;
  S.queue = q; S.qIndex = 0; S.savedCount = 0; S.batchValues = null; S.addContext = addCtx; S.addKeep = keep;
  if (location.hash === '#/add') route(); else location.hash = '#/add';
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
  return `${isoDay(p.createdAt)}_${safeToken(p.serialNumber) || 'noSN'}_${p.end || 'NoEnd'}-${band}_${p.id}.jpg`;
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
      <p class="muted small">Folders <i>Customer/Rig/</i> with full-size JPEGs, plus metadata.csv (opens in Excel) and metadata.json (for restoring). Save it to Files / iCloud Drive / OneDrive, or email it.</p>
      <button class="btn primary big block" id="exportBtn" ${S.photos.length ? '' : 'disabled'}>⤓ Export ZIP</button>
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
    const rows = [['file', 'id', 'taken', 'customer', 'rig', 'rig_notes', 'pipe_spec', 'serial_number', 'end', 'band', 'condition_notes', 'added']];
    const jsonPhotos = [];
    photos.forEach((p, i) => {
      const rig = S.rigs.get(p.rigId) || {};
      const path = `${safeName(labelOf('customers', p.customerId) || 'No customer')}/${safeName(rig.name || 'No rig')}/${exportFileName(p)}`;
      if (p.blob) zip.file(path, p.blob, { binary: true, date: new Date(p.createdAt) }); else skippedFiles++;
      rows.push([path, p.id, isoLocal(p.createdAt), labelOf('customers', p.customerId), rig.name || '', rig.notes || '', labelOf('pipeSpecs', p.pipeSpecId),
        p.serialNumber || '', p.end || '', p.bandNumber || '', p.notes || '', p.addedAt ? isoLocal(p.addedAt) : '']);
      const { blob, thumb, ...meta } = p;
      jsonPhotos.push({ ...meta, file: path, customer: labelOf('customers', p.customerId), rig: rig.name || '', pipeSpec: labelOf('pipeSpecs', p.pipeSpecId) });
      b.update(`Adding ${i + 1} of ${photos.length}…`, (i + 1) / photos.length * 0.2);
    });
    zip.file('metadata.csv', '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
    zip.file('metadata.json', JSON.stringify({ app: 'hardband-photos', schema: 1, exportedAt: new Date().toISOString(),
      customers: [...S.customers.values()], rigs: [...S.rigs.values()], pipeSpecs: [...S.pipeSpecs.values()], photos: jsonPhotos }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' }, (m) => b.update('Zipping…', 0.2 + m.percent / 125));
    const d = new Date();
    const name = `hardband-photos-backup_${isoDay(d)}_${pad2(d.getHours())}${pad2(d.getMinutes())}.zip`;
    b.done();
    const file = window.File ? new File([blob], name, { type: 'application/zip' }) : null;
    const canShare = !!(file && navigator.canShare && navigator.canShare({ files: [file] }));
    const markDone = () => setMeta('lastExport', { at: Date.now(), count: photos.length }).then(() => { if (location.hash === '#/backup') renderBackup(); });
    const m = openModal(`<h3>Backup ready</h3><p class="muted">${photos.length} photos · ${fmtMB(blob.size)}<br><span class="small">${esc(name)}</span>${skippedFiles ? `<br><span class="small">${skippedFiles} full-size photo(s) not downloaded yet (offline) — only their details are included.</span>` : ''}</p>
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
    b.done();
    toast(`Imported ${added} photo${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already here` : ''}${missing ? `, ${missing} missing` : ''}${addedLk ? `, ${addedLk} rig/customer/spec entries updated` : ''}.`, 5000);
    route();
  } catch (e) { console.error(e); b.done(); toast('Import failed: ' + e.message, 6000); }
}

/* ================= boot ================= */
async function init() {
  $('#backupBtn').onclick = () => { location.hash = '#/backup'; };
  $('#syncBadge').onclick = () => { location.hash = '#/backup'; };
  $('#manageBtn').onclick = () => { location.hash = '#/manage/' + S.manageTab; };
  $('#camBtn').addEventListener('click', () => { S.keepJoint = false; });
  $('#libBtn').addEventListener('click', () => { S.keepJoint = false; });
  for (const id of ['#camInput', '#libInput']) {
    const inp = $(id);
    inp.addEventListener('change', () => { const f = Array.from(inp.files || []); inp.value = ''; handleFiles(f); });
  }
  const imp = $('#importInput');
  imp.addEventListener('change', () => { const f = imp.files && imp.files[0]; imp.value = ''; importZip(f); });
  try {
    await openDB();
    await seedIfNeeded();
    await loadAll();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="card"><b>Storage unavailable.</b><p>${esc(e.message || e)}</p><p class="muted small">Private Browsing can block on-device storage. Open in normal Safari or from the Home Screen icon.</p></div>`;
    return;
  }
  askPersist();
  route();
  Sync.init().catch((e) => console.warn('sync init', e));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}
init();
