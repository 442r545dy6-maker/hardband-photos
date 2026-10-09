/* Hardband Photos — optional shared team library (Supabase), plain fetch, no SDK.
   Loaded before app.js. Does NOTHING unless config.js has a project URL + key AND the phone is signed in.
   Model: IndexedDB stays the source the UI reads. Local changes go into an "outbox" and are uploaded when
   online; remote changes are pulled by server updated_at. Last-write-wins per record by the phone's edit time
   (client_updated_at), enforced on the server by a trigger. Deletes are soft (deleted_at). */
'use strict';

const HB_CFG = (() => {
  const c = window.HB_CONFIG || {};
  const url = String(c.supabaseUrl || '').trim().replace(/\/+$/, '');
  const key = String(c.supabaseKey || '').trim();
  return { url, key, bucket: c.bucket || 'hardband', on: !!(url && key && /^https?:\/\/[^/]+/.test(url)) };
})();

const SYNC_TABLES = [
  { store: 'customers', table: 'customers', kind: 'customers' },
  { store: 'rigs', table: 'rigs', kind: 'rigs' },
  { store: 'pipeSpecs', table: 'pipe_specs', kind: 'pipeSpecs' },
  { store: 'photos', table: 'photos', kind: null },
];
const SEED_IDS = new Set(['c_eog', 'r_six', 's_45r3_450duo']);
const tsIso = (ms) => (ms ? new Date(ms).toISOString() : null);
// Postgres returns microseconds ("...:00.123456+00:00"); trim to ms so every browser parses it.
const tsMs = (s) => { if (!s) return 0; const t = Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1')); return isNaN(t) ? 0 : t; };
const stampOf = (store, r) => (r ? (store === 'photos' ? (r.updatedAt || r.addedAt || r.createdAt || 0) : (r.updatedAt || 0)) : -1);
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/* ---------- outbox (records waiting to upload) ---------- */
async function markDirty(store, id) {
  if (!HB_CFG.on || !id) return;
  Sync.pending++; // show it right away; recounted below
  await db.put('outbox', { key: `${store}:${id}`, store, id, at: Date.now() + Math.random() });
  Sync.pending = await outboxCount();
  Sync.badge();
  Sync.soon();
}
const outboxCount = () => tx('outbox', 'readonly', (st) => st.count());
async function outboxDone(entry) {
  const cur = await db.get('outbox', entry.key);
  if (cur && cur.at === entry.at) await db.del('outbox', entry.key); // only if not changed again meanwhile
}

/* ---------- row <-> local record ---------- */
function lookupToRow(t, it) {
  const K = KINDS[t.kind];
  const row = { id: it.id, [K.field]: it[K.field] || '', merged_into: it.mergedInto || null, client_updated_at: Math.round(stampOf(t.store, it)) || 0,
    deleted_at: tsIso(it.deletedAt), updated_by_name: S.meta.syncName || null };
  if (t.kind === 'rigs') { row.notes = it.notes || ''; row.closed_at = tsIso(it.closedAt); } // closed_at: Complete job (migration 009)
  return row;
}
function rowToLookup(t, r, local) {
  const K = KINDS[t.kind];
  const it = { id: r.id, [K.field]: r[K.field] || '', updatedAt: Number(r.client_updated_at) || 0 };
  if (t.kind === 'rigs') it.notes = r.notes || '';
  // Completed job (rigs.closed_at, 009_rigs_closed_at.sql). No key = server not migrated yet: keep this phone's value;
  // null while this phone still has to fill it in (meta.rigClosedBacklog): keep it too.
  if (t.kind === 'rigs') {
    const mine = local && local.closedAt;
    if (!('closed_at' in r)) { if (mine) it.closedAt = mine; }
    else if (r.closed_at) it.closedAt = tsMs(r.closed_at);
    else if (mine && (S.meta.rigClosedBacklog || []).includes(r.id)) it.closedAt = mine;
  }
  if (r.deleted_at) it.deletedAt = tsMs(r.deleted_at);
  if (r.merged_into) it.mergedInto = r.merged_into;
  return it;
}
function photoToRow(p) {
  return {
    id: p.id, customer_id: p.customerId || '', rig_id: p.rigId || '', pipe_spec_id: p.pipeSpecId || '',
    serial_number: p.serialNumber || '', pipe_end: p.end || '', band_number: p.bandNumber || '', notes: p.notes || '',
    taken_at: tsIso(p.createdAt), date_source: p.dateSource || null, added_at: tsIso(p.addedAt),
    width: p.width || null, height: p.height || null, orig_name: p.origName || null,
    image_path: p.remoteImage ? `photos/${p.id}.jpg` : null, thumb_path: p.remoteThumb ? `thumbs/${p.id}.jpg` : null,
    client_updated_at: Math.round(stampOf('photos', p)) || 0, deleted_at: tsIso(p.deletedAt), updated_by_name: S.meta.syncName || null,
    stage: (p.stage === 'pre' || p.stage === 'repair' || p.stage === 'plasma' || p.stage === 'inlay' || p.stage === 'post' || p.stage === 'preheat') ? p.stage : 'post', // known keys pass through; missing/unknown → post
    operator: String(p.operator || '').trim().replace(/\s+/g, ' ') || null, // "Name Number", e.g. "Dusty 104" (migration 003)
    work_order: String(p.workOrder || '').trim() || null, // Work order # from Start inspection (migration 006)
    wire: String(p.wire || '').trim().replace(/\s+/g, ' ') || null, // hardband wire, e.g. "Duraband NC" (migration 008)
    starred: p.starred ? true : null, // ⭐ star (migration 010_photo_starred.sql); unstarred = null
  };
}
function applyPhotoRow(p, r) {
  Object.assign(p, {
    id: r.id, customerId: r.customer_id || '', rigId: r.rig_id || '', pipeSpecId: r.pipe_spec_id || '',
    serialNumber: r.serial_number || '', end: r.pipe_end || '', bandNumber: r.band_number || '', notes: r.notes || '',
    createdAt: tsMs(r.taken_at) || p.createdAt || tsMs(r.created_at) || Date.now(), dateSource: r.date_source || p.dateSource || '',
    width: r.width || p.width, height: r.height || p.height, origName: r.orig_name || p.origName || '',
    updatedAt: Number(r.client_updated_at) || 0, remoteImage: !!r.image_path || !!p.remoteImage, remoteThumb: !!r.thumb_path || !!p.remoteThumb,
  });
  if (r.added_at) p.addedAt = tsMs(r.added_at);
  // Only a real value changes the stage. A missing/null stage (server not migrated yet, or a row written by an
  // older app version) keeps whatever this phone already has; photos with no stage at all count as 'post'.
  if (r.stage === 'pre' || r.stage === 'repair' || r.stage === 'plasma' || r.stage === 'inlay' || r.stage === 'post' || r.stage === 'preheat') p.stage = r.stage;
  // Operator: a real value always wins. An empty one clears it, except while this phone still has to upload its
  // operator (it was saved before the server had the column) — then the local value is kept until the catch-up.
  // No 'operator' key at all = server not migrated yet: keep what this phone has.
  if ('operator' in r) {
    if (r.operator) p.operator = String(r.operator);
    else if (!(S.meta.operatorBacklog || []).includes(r.id)) p.operator = '';
  }
  // Work order (migration 006): same rule as the operator.
  if ('work_order' in r) {
    if (r.work_order) p.workOrder = String(r.work_order);
    else if (!(S.meta.photoWorkOrderBacklog || []).includes(r.id)) p.workOrder = '';
  }
  // Wire (migration 008_wire.sql): same rule as the operator.
  if ('wire' in r) {
    if (r.wire) p.wire = String(r.wire);
    else if (!(S.meta.wireBacklog || []).includes(r.id)) p.wire = '';
  }
  // Star (migration 010_photo_starred.sql): same rule — a null only clears it when this phone has no star still to upload.
  if ('starred' in r) {
    if (r.starred) p.starred = true;
    else if (!(S.meta.starredBacklog || []).includes(r.id)) delete p.starred;
  }
  if (r.deleted_at) p.deletedAt = tsMs(r.deleted_at); else delete p.deletedAt;
  if (!('blob' in p)) p.blob = null;
  if (!('thumb' in p)) p.thumb = null;
  return p;
}
// Rejected-wire log (table public.rejects, migration 004_rejects.sql; work_order added by 005_reject_work_order.sql).
function rejectToRow(r) {
  return {
    id: r.id, operator: String(r.operator || '').trim().replace(/\s+/g, ' ') || null, rejected_at: tsIso(r.rejectedAt),
    rig_id: r.rigId || '', rig_name: r.rigName || null, serial_number: r.serialNumber || '', note: r.note || '',
    work_order: String(r.workOrder || '').trim() || null,
    client_updated_at: Math.round(r.updatedAt || r.rejectedAt || 0) || 0, deleted_at: tsIso(r.deletedAt),
    created_by_name: r.loggedBy || null, updated_by_name: S.meta.syncName || null,
  };
}
function rowToReject(r, local) {
  const it = { id: r.id, operator: r.operator || '', rejectedAt: tsMs(r.rejected_at) || tsMs(r.created_at) || Date.now(), rigId: r.rig_id || '',
    rigName: r.rig_name || '', serialNumber: r.serial_number || '', note: r.note || '', loggedBy: r.created_by_name || '', updatedAt: Number(r.client_updated_at) || 0 };
  // Work order (same rule as the photo operator): a real value always wins. An empty one clears it, except while this
  // phone still has to upload its work order (saved before the server had the column) — then the local value is kept
  // until the catch-up. No 'work_order' key at all = server not migrated yet (005): keep what this phone has.
  const mine = (local && local.workOrder) || '';
  if ('work_order' in r) it.workOrder = r.work_order ? String(r.work_order) : ((S.meta.workOrderBacklog || []).includes(r.id) ? mine : '');
  else it.workOrder = mine;
  if (r.deleted_at) it.deletedAt = tsMs(r.deleted_at);
  return it;
}
async function photoRecord(id) {
  const live = S.photos.find((x) => x.id === id);
  if (live) return live;
  const raw = await db.get('photos', id);
  return raw ? { ...raw, blob: storedToBlob(raw.blob), thumb: storedToBlob(raw.thumb) } : null;
}

/* ---------- HTTP ---------- */
class SyncError extends Error { constructor(msg, kind, status) { super(msg); this.kind = kind; this.status = status; } }
async function rawFetch(path, opts = {}, timeoutMs = 30000) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try { return await fetch(HB_CFG.url + path, { cache: 'no-store', ...opts, signal: ac ? ac.signal : undefined }); }
  catch (e) { throw new SyncError('No connection to the team library', 'offline'); }
  finally { if (timer) clearTimeout(timer); }
}
async function errText(res) {
  try { const j = await res.clone().json(); return j.msg || j.error_description || j.message || j.error || `HTTP ${res.status}`; }
  catch (e) { return `HTTP ${res.status}`; }
}
async function errCode(res) {
  try { const j = await res.clone().json(); return j.code || j.error_code || ''; } catch (e) { return ''; }
}
async function sbFetch(path, { method = 'GET', headers = {}, body, timeout } = {}, retried = false) {
  const tok = await Sync.token();
  const res = await rawFetch(path, { method, body, headers: { apikey: HB_CFG.key, Authorization: 'Bearer ' + tok, ...headers } }, timeout);
  if (res.status === 401 && !retried) { await Sync.refresh(true); return sbFetch(path, { method, headers, body, timeout }, true); }
  if (!res.ok) { const err = new SyncError(await errText(res), res.status >= 500 ? 'server' : 'http', res.status); err.code = await errCode(res); throw err; }
  return res;
}
// Photo columns added by later migrations: stage (002_stage.sql), operator (003_operator.sql), work_order
// (006_photo_work_order.sql). Until a migration is
// run, PostgREST answers 400 PGRST204 "Could not find the 'stage' column of 'photos' in the schema cache"
// (42703 "column photos.stage does not exist" on a select). missingCol() tells which column the server lacks.
const OPT_COLS = ['stage', 'operator', 'work_order', 'wire', 'starred']; // + wire (008_wire.sql), starred (010_photo_starred.sql)
// Name used for each column's Sync flags (<name>Col / <name>CheckedAt) and its meta.<name>Backlog list.
const COL_KEY = { stage: 'stage', operator: 'operator', work_order: 'photoWorkOrder', wire: 'wire', starred: 'starred' };
// Reject columns added by later migrations: work_order (005_reject_work_order.sql). Same detection as for photos.
const REJECT_OPT_COLS = ['work_order'];
const missingCol = (e, cols = OPT_COLS) => {
  if (!e || e.status !== 400) return '';
  const msg = e.message || '';
  return cols.find((c) => new RegExp(`'${c}' column|column [\\w."]*\\b${c}\\b`, 'i').test(msg)) || '';
};
const isNoStageCol = (e) => missingCol(e) === 'stage';
// Table public.rejects not created yet (migration 004_rejects.sql not run): PostgREST answers 404 PGRST205 "Could not
// find the table 'public.rejects' in the schema cache" (older versions: 404 / 42P01 "relation does not exist");
// missing grants give 42501 "permission denied". Rejects then stay on the phone and upload once the table exists.
const isNoTable = (e) => !!e && (e.status === 404 || ['PGRST205', '42P01', '42501'].includes(e.code));
const upsertRows = (table, rows) => sbFetch(`/rest/v1/${table}?on_conflict=id`, {
  method: 'POST', body: JSON.stringify(rows),
  headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' } });
const objPath = (path) => `/storage/v1/object/${encodeURIComponent(HB_CFG.bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;
const uploadObj = (path, blob) => sbFetch(objPath(path), { method: 'POST', body: blob, timeout: 180000,
  headers: { 'Content-Type': blob.type || 'image/jpeg', 'cache-control': 'max-age=31536000', 'x-upsert': 'true' } });
const downloadObj = async (path) => { const res = await sbFetch(objPath(path), { timeout: 180000 }); const b = await res.blob(); return b.type ? b : new Blob([b], { type: 'image/jpeg' }); };

/* ---------- the engine ---------- */
const Sync = {
  on: HB_CFG.on, stageCol: null, stageCheckedAt: 0, operatorCol: null, operatorCheckedAt: 0, photoWorkOrderCol: null, photoWorkOrderCheckedAt: 0, wireCol: null, wireCheckedAt: 0, starredCol: null, starredCheckedAt: 0, workOrderCol: null, workOrderCheckedAt: 0, rejectsTable: null, rejectsCheckedAt: 0, running: false, again: false, pending: 0, phase: '', lastError: null, lastOk: 0, timer: null, changed: false,
  get session() { return S.meta.syncSession || null; },
  get signedIn() { return !!(HB_CFG.on && this.session && this.session.refresh_token); },

  async init() {
    if (!HB_CFG.on) return;
    this.pending = await outboxCount();
    this.badge();
    window.addEventListener('online', () => this.run('online'));
    window.addEventListener('offline', () => this.badge());
    window.addEventListener('focus', () => this.run('focus'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.run('visible'); });
    setInterval(() => { if (document.visibilityState !== 'hidden') this.run('timer'); }, 60000);
    this.run('open');
  },
  soon(ms = 1200) {
    if (!this.signedIn) return;
    clearTimeout(this.timer); this.scheduled = true;
    this.timer = setTimeout(() => { this.scheduled = false; this.run('change'); }, ms);
  },

  /* ----- auth ----- */
  async signIn(email, password, name) {
    const res = await rawFetch('/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: HB_CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!res.ok) throw new SyncError(res.status === 400 ? 'Wrong email or password.' : await errText(res), 'auth', res.status);
    await this.saveSession(await res.json());
    await setMeta('syncName', (name || '').trim());
    if (S.meta.syncProject !== HB_CFG.url) {
      // First sign-in on this phone (or a different project): upload everything, re-check every photo file.
      await setMeta('syncCursor', {});
      for (const p of S.photos) if (p.remoteImage || p.remoteThumb) { p.remoteImage = false; p.remoteThumb = false; await putPhoto(p); }
      await setMeta('syncProject', HB_CFG.url);
    }
    await this.enqueueAll(); // migration: every local record + photo goes up; the server keeps whichever edit is newer
    this.lastError = null;
    this.run('signin');
  },
  async saveSession(j) {
    const expires_at = j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600);
    const prev = this.session || {};
    await setMeta('syncSession', { access_token: j.access_token, refresh_token: j.refresh_token || prev.refresh_token, expires_at,
      email: (j.user && j.user.email) || prev.email || '', userId: (j.user && j.user.id) || prev.userId || '' });
  },
  async token() {
    const s = this.session;
    if (!s) throw new SyncError('Signed out', 'signedout');
    if (s.expires_at * 1000 - Date.now() < 60000) await this.refresh();
    return this.session.access_token;
  },
  async refresh(force) {
    const s = this.session;
    if (!s || !s.refresh_token) throw new SyncError('Signed out', 'signedout');
    if (!force && s.expires_at * 1000 - Date.now() > 60000) return;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const res = await rawFetch('/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: HB_CFG.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await setMeta('syncSession', null);
        throw new SyncError('Team sign-in expired — sign in again (photos on this phone are safe).', 'signedout', res.status);
      }
      if (!res.ok) throw new SyncError(await errText(res), 'server', res.status);
      await this.saveSession(await res.json());
    })().finally(() => { this._refreshing = null; });
    return this._refreshing;
  },
  async signOut() {
    const s = this.session;
    if (s) { try { await rawFetch('/auth/v1/logout', { method: 'POST', headers: { apikey: HB_CFG.key, Authorization: 'Bearer ' + s.access_token } }, 8000); } catch (e) { /* offline is fine */ } }
    await setMeta('syncSession', null);
    this.lastError = null; this.badge();
  },
  async enqueueAll() {
    const now = Date.now();
    const put = (store, id, i) => db.put('outbox', { key: `${store}:${id}`, store, id, at: now + i / 1e6 });
    let i = 0;
    for (const t of SYNC_TABLES) for (const r of await db.all(t.store)) await put(t.store, r.id, i++);
    for (const r of await db.all('rejects')) await put('rejects', r.id, i++);
    this.pending = await outboxCount();
  },

  /* ----- one sync pass ----- */
  async run(reason) {
    if (!this.signedIn) { this.badge(); return; }
    if (typeof navigator.onLine === 'boolean' && !navigator.onLine) { this.lastError = new SyncError('Offline', 'offline'); this.badge(); return; }
    if (this.running) { this.again = true; return; }
    this.running = true; this.changed = false; this.badge();
    try {
      do {
        this.again = false;
        await this.push();
        await this.pull();
        if (await this.reconcile()) await this.push();
        // map / rename the four inspection pipe specs to what the team just brought in, and upload that in this same run
        if (this.changed && typeof ensurePipeSpecs === 'function') { await ensurePipeSpecs(); if (await outboxCount()) await this.push(); }
      } while (this.again);
      this.lastError = null; this.lastOk = Date.now();
      await setMeta('syncLast', { at: this.lastOk });
      this.running = false; this.badge();
      await this.fetchThumbs();
    } catch (e) {
      console.warn('sync:', e);
      this.lastError = e instanceof SyncError ? e : new SyncError(e.message || String(e), 'error');
    } finally {
      const again = this.again; this.again = false;
      this.running = false;
      this.pending = await outboxCount();
      this.badge();
      if (this.changed) { this.changed = false; softRefresh(); }
      // A Sync.run during this pass only set again; if we threw (e.g. 503) the do-while never saw it — retry now.
      if (again) this.run('again');
    }
  },

  async push() {
    await this.stageCatchUp();
    await this.operatorCatchUp();
    await this.photoWorkOrderCatchUp();
    await this.wireCatchUp();
    await this.starredCatchUp();
    await this.rigClosedCatchUp();
    await this.rejectsCatchUp();
    await this.workOrderCatchUp();
    const entries = (await db.all('outbox')).sort((a, b) => a.at - b.at);
    if (!entries.length) return;
    const order = { customers: 0, rigs: 1, pipeSpecs: 2, photos: 3, rejects: 4 };
    entries.sort((a, b) => order[a.store] - order[b.store] || a.at - b.at);
    for (const t of SYNC_TABLES.filter((x) => x.kind)) {
      const es = entries.filter((e) => e.store === t.store);
      for (let i = 0; i < es.length; i += 200) {
        const chunk = es.slice(i, i + 200), rows = [], used = [];
        for (const e of chunk) {
          const it = S[t.kind].get(e.id) || await db.get(t.store, e.id);
          if (!it) { await db.del('outbox', e.key); continue; }
          rows.push(lookupToRow(t, it)); used.push(e);
        }
        if (rows.length) await (t.kind === 'rigs' ? this.upsertRigs(rows) : upsertRows(t.table, rows));
        for (const e of used) await outboxDone(e);
      }
    }
    const photoEntries = entries.filter((e) => e.store === 'photos');
    for (let i = 0; i < photoEntries.length; i++) {
      const e = photoEntries[i];
      this.phase = photoEntries.length > 1 ? `Uploading ${i + 1} of ${photoEntries.length}` : 'Uploading';
      this.badge();
      const p = await photoRecord(e.id);
      if (!p) { await db.del('outbox', e.key); continue; }
      let flags = false;
      if (p.blob && !p.remoteImage) { await uploadObj(`photos/${p.id}.jpg`, p.blob); p.remoteImage = true; flags = true; }
      if (p.thumb && !p.remoteThumb) { await uploadObj(`thumbs/${p.id}.jpg`, p.thumb); p.remoteThumb = true; flags = true; }
      if (flags) await putPhoto(p);
      await this.upsertPhoto(p);
      if (p.deletedAt && (p.blob || p.thumb) && p.remoteImage) { p.blob = null; p.thumb = null; await putPhoto(p); } // the server keeps the file
      await outboxDone(e);
      this.pending = await outboxCount();
    }
    this.phase = '';
    await this.pushRejects(entries.filter((e) => e.store === 'rejects'));
  },

  /* ----- rejects (table public.rejects, migration 004_rejects.sql) ----- */
  // While the server has no rejects table the phone keeps them (the outbox entries move to a small "backlog" list, so
  // the pill still shows Synced and operators never see an error). Checked again at most every 5 minutes.
  rejectsParked() { return this.rejectsTable === false && Date.now() - (this.rejectsCheckedAt || 0) < 300000; },
  async noRejectsTable(ids) {
    if (this.rejectsTable !== false) console.warn('sync: server has no rejects table yet (run 004_rejects.sql) — rejects stay on this phone for now');
    this.rejectsTable = false; this.rejectsCheckedAt = Date.now();
    const backlog = S.meta.rejectBacklog || [], add = ids.filter((id) => !backlog.includes(id));
    if (add.length) await setMeta('rejectBacklog', backlog.concat(add));
  },
  // Until the server has the 'work_order' column (005_reject_work_order.sql), PostgREST answers 400 PGRST204 (or
  // 42703): the rows are sent again without it (so sync never breaks and the pill stays ✓ Synced), the phone keeps the
  // value, and rejects that have one are remembered (meta.workOrderBacklog) and filled in once the column exists.
  async upsertRejects(recs) {
    for (let i = 0; i < recs.length; i += 200) {
      const chunk = recs.slice(i, i + 200), rows = chunk.map(rejectToRow);
      const drop = () => rows.forEach((x) => { delete x.work_order; });
      if (this.workOrderCol === false) drop();
      for (;;) {
        try { await upsertRows('rejects', rows); break; }
        catch (e) {
          if (missingCol(e, REJECT_OPT_COLS) !== 'work_order' || !('work_order' in rows[0])) throw e;
          if (this.workOrderCol !== false) console.warn('sync: server has no rejects.work_order column yet (run 005_reject_work_order.sql) — uploading without it');
          this.workOrderCol = false; this.workOrderCheckedAt = Date.now();
          drop();
        }
      }
      if ('work_order' in rows[0]) { this.workOrderCol = true; continue; }
      const backlog = S.meta.workOrderBacklog || [];
      const add = chunk.filter((r) => rejectToRow(r).work_order && !backlog.includes(r.id)).map((r) => r.id);
      if (add.length) await setMeta('workOrderBacklog', backlog.concat(add));
    }
  },
  // Records uploaded while a text column was missing get that value filled in once it exists (checked at most every
  // 5 min): a one-column PATCH, and only where the server's value is still empty (like the operator catch-up), so it
  // keeps the row's edit time and never overwrites a value set since by another phone.
  // flag = name of the Sync flags (<flag>Col / <flag>CheckedAt); valueOf(id) = the value this phone has (or empty).
  async fillInLater({ table, col, flag, backlogKey, valueOf }) {
    const backlog = S.meta[backlogKey] || [];
    if (!backlog.length) return false;
    if (this[flag + 'Col'] === false && Date.now() - (this[flag + 'CheckedAt'] || 0) < 300000) return false;
    this[flag + 'CheckedAt'] = Date.now();
    try { await sbFetch(`/rest/v1/${table}?select=id,${col}&limit=1`); }
    catch (e) {
      if (missingCol(e, [col]) === col) { this[flag + 'Col'] = false; return false; }
      if (table === 'rejects' && isNoTable(e)) return false;
      throw e;
    }
    this[flag + 'Col'] = true;
    const by = new Map();
    for (const id of backlog) {
      const v = await valueOf(id);
      if (v) { if (!by.has(v)) by.set(v, []); by.get(v).push(id); }
    }
    for (const [v, list] of by) {
      for (let i = 0; i < list.length; i += 100) {
        const ids = list.slice(i, i + 100).map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',');
        await sbFetch(`/rest/v1/${table}?id=in.(${encodeURIComponent(ids)})&${col}=is.null`, { method: 'PATCH', body: JSON.stringify({ [col]: v }),
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
      }
    }
    const left = (S.meta[backlogKey] || []).filter((id) => !backlog.includes(id)); // added while uploading
    await setMeta(backlogKey, left);
    return true;
  },
  // Rejects uploaded while rejects.work_order was missing (005_reject_work_order.sql).
  async workOrderCatchUp() {
    if (this.rejectsParked()) return false;
    return this.fillInLater({ table: 'rejects', col: 'work_order', flag: 'workOrder', backlogKey: 'workOrderBacklog',
      valueOf: async (id) => { const r = await db.get('rejects', id); return r && rejectToRow(r).work_order; } });
  },
  // Photos uploaded while photos.work_order was missing (006_photo_work_order.sql).
  photoWorkOrderCatchUp() {
    return this.fillInLater({ table: 'photos', col: 'work_order', flag: 'photoWorkOrder', backlogKey: 'photoWorkOrderBacklog',
      valueOf: async (id) => { const p = await photoRecord(id); return p && photoToRow(p).work_order; } });
  },
  // Starred photos uploaded while photos.starred was missing (010_photo_starred.sql). An unstar since then has no value → skipped.
  starredCatchUp() {
    return this.fillInLater({ table: 'photos', col: 'starred', flag: 'starred', backlogKey: 'starredBacklog',
      valueOf: async (id) => { const p = await photoRecord(id); return p && photoToRow(p).starred; } });
  },
  // Photos uploaded while photos.wire was missing (008_wire.sql).
  wireCatchUp() {
    return this.fillInLater({ table: 'photos', col: 'wire', flag: 'wire', backlogKey: 'wireBacklog',
      valueOf: async (id) => { const p = await photoRecord(id); return p && photoToRow(p).wire; } });
  },
  // rigs.closed_at (009_rigs_closed_at.sql) missing on the server: PostgREST answers 400 PGRST204. Upload the rigs without
  // it (sync never breaks), keep the value on the phone and remember completed rigs (meta.rigClosedBacklog) so the
  // value is filled in by a closed_at-only PATCH once the column exists (rigClosedCatchUp).
  async upsertRigs(rows) {
    const drop = () => rows.forEach((x) => { delete x.closed_at; });
    if (this.rigClosedCol === false && Date.now() - (this.rigClosedCheckedAt || 0) < 300000) drop();
    for (;;) {
      try { await upsertRows('rigs', rows); break; }
      catch (e) {
        if (missingCol(e, ['closed_at']) !== 'closed_at' || !('closed_at' in rows[0])) throw e;
        if (this.rigClosedCol !== false) console.warn('sync: server has no rigs.closed_at column yet (run 009_rigs_closed_at.sql) — uploading rigs without it');
        this.rigClosedCol = false; this.rigClosedCheckedAt = Date.now();
        drop();
      }
    }
    if ('closed_at' in rows[0]) { this.rigClosedCol = true; return; }
    const backlog = S.meta.rigClosedBacklog || [];
    const add = rows.filter((r) => { const it = S.rigs.get(r.id) || S.gone.rigs.get(r.id); return it && it.closedAt && !backlog.includes(r.id); }).map((r) => r.id);
    if (add.length) await setMeta('rigClosedBacklog', backlog.concat(add));
  },
  // Rigs completed while rigs.closed_at was missing (009_rigs_closed_at.sql).
  rigClosedCatchUp() {
    return this.fillInLater({ table: 'rigs', col: 'closed_at', flag: 'rigClosed', backlogKey: 'rigClosedBacklog',
      valueOf: async (id) => { const it = S.rigs.get(id) || S.gone.rigs.get(id) || await db.get('rigs', id); return it && it.closedAt ? tsIso(it.closedAt) : null; } });
  },
  async pushRejects(entries) {
    if (!entries.length) return;
    const recs = [], used = [];
    for (const e of entries) {
      const r = await db.get('rejects', e.id);
      if (!r) { await db.del('outbox', e.key); continue; }
      recs.push(r); used.push(e);
    }
    if (!recs.length) return;
    if (this.rejectsParked()) await this.noRejectsTable(recs.map((r) => r.id));
    else {
      try { await this.upsertRejects(recs); this.rejectsTable = true; }
      catch (e) { if (!isNoTable(e)) throw e; await this.noRejectsTable(recs.map((r) => r.id)); }
    }
    for (const e of used) await outboxDone(e);
    this.pending = await outboxCount();
  },
  // Once the table exists, everything kept on the phone goes up (last-write-wins like any other record).
  async rejectsCatchUp() {
    const backlog = S.meta.rejectBacklog || [];
    if (!backlog.length || this.rejectsParked()) return false;
    this.rejectsCheckedAt = Date.now();
    const recs = [];
    for (const id of backlog) { const r = await db.get('rejects', id); if (r) recs.push(r); }
    try { if (recs.length) await this.upsertRejects(recs); }
    catch (e) { if (isNoTable(e)) { this.rejectsTable = false; return false; } throw e; }
    this.rejectsTable = true;
    const left = (S.meta.rejectBacklog || []).filter((id) => !backlog.includes(id)); // added while uploading
    await setMeta('rejectBacklog', left);
    return true;
  },
  async pullRejects(cursors) {
    if (this.rejectsParked()) return;
    const cur = cursors.rejects;
    const since = cur ? new Date(tsMs(cur) - 60000).toISOString() : null;
    let offset = 0, maxTs = cur || null;
    for (;;) {
      let q = `/rest/v1/rejects?select=*&order=updated_at.asc,id.asc&limit=500&offset=${offset}`;
      if (since) q += `&updated_at=gte.${encodeURIComponent(since)}`;
      let rows;
      try { rows = await (await sbFetch(q)).json(); }
      catch (e) { if (isNoTable(e)) { await this.noRejectsTable([]); return; } throw e; }
      this.rejectsTable = true;
      await this.applyRemoteRejects(rows);
      for (const r of rows) if (!maxTs || tsMs(r.updated_at) > tsMs(maxTs)) maxTs = r.updated_at;
      if (rows.length < 500) break;
      offset += 500;
    }
    if (maxTs) cursors.rejects = maxTs;
  },
  async applyRemoteRejects(rows) {
    if (!rows.length) return;
    const outbox = new Map((await db.all('outbox')).map((e) => [e.key, e]));
    const backlog = new Set(S.meta.rejectBacklog || []);
    for (const r of rows) {
      const dirty = outbox.get(`rejects:${r.id}`), local = await db.get('rejects', r.id);
      const lts = local ? (local.updatedAt || 0) : -1, rts = Number(r.client_updated_at) || 0;
      if (local && (dirty || backlog.has(r.id)) && lts > rts) continue;                        // our newer edit wins; it will upload
      // (a work order filled in later by another phone's catch-up PATCH keeps the edit time, so compare it too)
      const sameExtra = local && (!r.work_order || r.work_order === local.workOrder);
      if (local && lts === rts && sameExtra && !!local.deletedAt === !!r.deleted_at) { if (dirty) await outboxDone(dirty); continue; } // already have it
      const it = rowToReject(r, local);
      await db.put('rejects', it);
      S.rejects = S.rejects.filter((x) => x.id !== it.id);
      if (!it.deletedAt) S.rejects.push(it);
      if (dirty) await outboxDone(dirty);
      this.changed = true;
    }
  },

  // Upload one photo row. Until the server has the 'stage' / 'operator' / 'work_order' column, send the row without
  // it (so sync never breaks) and remember the photo, so that value is uploaded once the column exists.
  async upsertPhoto(p) {
    const row = photoToRow(p), dropped = [];
    for (const c of OPT_COLS) if (this[COL_KEY[c] + 'Col'] === false) { delete row[c]; dropped.push(c); }
    for (;;) {
      try { await upsertRows('photos', [row]); break; }
      catch (e) {
        const c = missingCol(e);
        if (!c || !(c in row)) throw e;
        this[COL_KEY[c] + 'Col'] = false; this[COL_KEY[c] + 'CheckedAt'] = Date.now();
        console.warn(`sync: server has no photos.${c} column yet — uploading without it`);
        delete row[c]; dropped.push(c);
      }
    }
    for (const c of OPT_COLS) if (c in row) this[COL_KEY[c] + 'Col'] = true;
    for (const c of dropped) {
      if (c !== 'stage' && !photoToRow(p)[c]) continue; // no operator / work order on this photo: nothing to fill in later
      const key = COL_KEY[c] + 'Backlog', backlog = S.meta[key] || [];
      if (!backlog.includes(p.id)) await setMeta(key, backlog.concat(p.id));
    }
  },
  // Same idea for the operator (migration 003_operator.sql): an operator-only PATCH where the server's operator is
  // still empty, so it never overwrites an operator set since by another phone and keeps the row's edit time.
  async operatorCatchUp() {
    const backlog = S.meta.operatorBacklog || [];
    if (!backlog.length) return false;
    if (this.operatorCol === false && Date.now() - (this.operatorCheckedAt || 0) < 300000) return false;
    this.operatorCheckedAt = Date.now();
    try { await sbFetch('/rest/v1/photos?select=id,operator&limit=1'); }
    catch (e) { if (missingCol(e) === 'operator') { this.operatorCol = false; return false; } throw e; }
    this.operatorCol = true;
    const by = new Map();
    for (const id of backlog) {
      const p = await photoRecord(id), v = p && photoToRow(p).operator;
      if (v) { if (!by.has(v)) by.set(v, []); by.get(v).push(id); }
    }
    for (const [v, list] of by) {
      for (let i = 0; i < list.length; i += 100) {
        const ids = list.slice(i, i + 100).map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',');
        await sbFetch(`/rest/v1/photos?id=in.(${encodeURIComponent(ids)})&operator=is.null`, { method: 'PATCH', body: JSON.stringify({ operator: v }),
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
      }
    }
    await setMeta('operatorBacklog', []);
    return true;
  },
  // Photos uploaded while the column was missing get their stage filled in once it exists (checked at most every
  // 5 min). A stage-only PATCH, and only where the server's stage is still empty: it keeps the row's edit time,
  // so it can't overwrite (or be blocked by) a newer edit from another phone, and never replaces a stage set since.
  async stageCatchUp() {
    const backlog = S.meta.stageBacklog || [];
    if (!backlog.length) return false;
    if (this.stageCol === false && Date.now() - (this.stageCheckedAt || 0) < 300000) return false;
    this.stageCheckedAt = Date.now();
    try { await sbFetch('/rest/v1/photos?select=id,stage&limit=1'); }
    catch (e) { if (isNoStageCol(e)) { this.stageCol = false; return false; } throw e; }
    this.stageCol = true;
    const by = { pre: [], repair: [], plasma: [], inlay: [], post: [], preheat: [] };
    for (const id of backlog) {
      const p = await photoRecord(id); if (!p) continue;
      const st = (p.stage === 'pre' || p.stage === 'repair' || p.stage === 'plasma' || p.stage === 'inlay' || p.stage === 'preheat') ? p.stage : 'post';
      by[st].push(id);
    }
    for (const st of ['pre', 'repair', 'plasma', 'inlay', 'post', 'preheat']) {
      for (let i = 0; i < by[st].length; i += 100) {
        const ids = by[st].slice(i, i + 100).map((x) => `"${String(x).replace(/["\\]/g, '')}"`).join(',');
        await sbFetch(`/rest/v1/photos?id=in.(${encodeURIComponent(ids)})&stage=is.null`, { method: 'PATCH', body: JSON.stringify({ stage: st }),
          headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' } });
      }
    }
    await setMeta('stageBacklog', []);
    return true;
  },

  async pull() {
    const cursors = { ...(S.meta.syncCursor || {}) };
    for (const t of SYNC_TABLES) {
      const cur = cursors[t.table];
      // Re-read the last minute each time: cheap, and covers writes that committed slightly out of order.
      const since = cur ? new Date(tsMs(cur) - 60000).toISOString() : null;
      let offset = 0, maxTs = cur || null;
      for (;;) {
        let q = `/rest/v1/${t.table}?select=*&order=updated_at.asc,id.asc&limit=500&offset=${offset}`;
        if (since) q += `&updated_at=gte.${encodeURIComponent(since)}`;
        const rows = await (await sbFetch(q)).json();
        await this.applyRemote(t, rows);
        for (const r of rows) if (!maxTs || tsMs(r.updated_at) > tsMs(maxTs)) maxTs = r.updated_at;
        if (rows.length < 500) break;
        offset += 500;
      }
      if (maxTs) cursors[t.table] = maxTs;
    }
    await this.pullRejects(cursors);
    await setMeta('syncCursor', cursors);
  },

  async applyRemote(t, rows) {
    if (!rows.length) return;
    const outbox = new Map((await db.all('outbox')).map((e) => [e.key, e]));
    const live = t.store === 'photos' ? new Map(S.photos.map((p) => [p.id, p])) : null;
    for (const r of rows) {
      const key = `${t.store}:${r.id}`, dirty = outbox.get(key);
      const rts = Number(r.client_updated_at) || 0;
      if (t.kind) {
        const local = S[t.kind].get(r.id) || S.gone[t.kind].get(r.id) || await db.get(t.store, r.id);
        const lts = stampOf(t.store, local);
        if (local && dirty && lts > rts) continue;                                   // our newer edit wins; it will upload
        // (a closed_at filled in later by another phone's catch-up PATCH keeps the edit time, so compare it too)
        const sameClosed = t.kind !== 'rigs' || !('closed_at' in r) || !!r.closed_at === !!(local && local.closedAt);
        if (local && !dirty && lts === rts && !!local.deletedAt === !!r.deleted_at && sameClosed) continue; // already have it
        const it = rowToLookup(t, r, local);
        await db.put(t.store, it);
        if (it.deletedAt) { S[t.kind].delete(it.id); S.gone[t.kind].set(it.id, it); }
        else { S[t.kind].set(it.id, it); S.gone[t.kind].delete(it.id); }
        if (dirty) await outboxDone(dirty);
        this.changed = true;
      } else {
        let p = live.get(r.id);
        if (!p) p = await photoRecord(r.id);
        const lts = stampOf('photos', p);
        if (p && dirty && lts > rts) continue;
        // (an operator filled in later by another phone's catch-up PATCH keeps the edit time, so compare it too)
        const sameExtra = p && (!r.operator || r.operator === p.operator) && (!r.work_order || r.work_order === p.workOrder) && (!r.wire || r.wire === p.wire) && (!r.starred || !!p.starred);
        if (p && !dirty && lts === rts && sameExtra && !!p.deletedAt === !!r.deleted_at && (p.remoteImage || !r.image_path)) continue;
        p = applyPhotoRow(p || { blob: null, thumb: null }, r);
        if (p.deletedAt) { p.blob = null; p.thumb = null; } // someone deleted it; a copy stays on the server
        await putPhoto(p);
        if (p.deletedAt) { if (live.has(p.id)) { S.photos = S.photos.filter((x) => x.id !== p.id); live.delete(p.id); dropThumb(p.id); } }
        else if (!live.has(p.id)) { S.photos.push(p); live.set(p.id, p); }
        if (dirty) await outboxDone(dirty);
        this.changed = true;
      }
    }
  },

  // Fix references to merged entries, and merge duplicate names (e.g. two phones both added "Patterson 801").
  // Photos are reassigned to the surviving entry; the duplicate becomes a tombstone. Nothing is deleted.
  async reconcile() {
    let changed = false;
    const now = Date.now();
    for (const kind of Object.keys(KINDS)) {
      const K = KINDS[kind];
      const groups = new Map();
      for (const it of S[kind].values()) { const k = normName(it[K.field]); if (!k) continue; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => (SEED_IDS.has(a.id) ? 0 : 1) - (SEED_IDS.has(b.id) ? 0 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const keep = list[0];
        for (const dup of list.slice(1)) {
          if (K.notes && !keep.notes && dup.notes) { keep.notes = dup.notes; keep.updatedAt = now; await db.put(K.store, keep); await markDirty(K.store, keep.id); }
          const tomb = { ...dup, deletedAt: now, updatedAt: now, mergedInto: keep.id };
          await db.put(K.store, tomb); S[kind].delete(dup.id); S.gone[kind].set(dup.id, tomb);
          await markDirty(K.store, dup.id);
          changed = true;
        }
      }
      // Photos still pointing at a merged-away entry follow it to the survivor.
      const target = (id) => { let x = id, n = 0; while (S.gone[kind].has(x) && S.gone[kind].get(x).mergedInto && n++ < 10) x = S.gone[kind].get(x).mergedInto; return x; };
      for (const p of S.photos) {
        const cur = p[K.ref];
        if (!cur || !S.gone[kind].has(cur)) continue;
        const to = target(cur);
        if (to !== cur && S[kind].has(to)) { p[K.ref] = to; p.updatedAt = now; await putPhoto(p); await markDirty('photos', p.id); changed = true; }
      }
      const lu = S.meta.lastUsed || {};
      if (lu[K.ref] && S.gone[kind].has(lu[K.ref])) { const to = target(lu[K.ref]); lu[K.ref] = S[kind].has(to) ? to : ''; await setMeta('lastUsed', lu); }
    }
    if (changed) this.changed = true;
    return changed;
  },

  async fetchThumbs() {
    const need = S.photos.filter((p) => !p.thumb && p.remoteThumb);
    let got = 0;
    const worker = async () => {
      while (need.length) {
        const p = need.shift();
        try { p.thumb = await downloadObj(`thumbs/${p.id}.jpg`); await putPhoto(p); dropThumb(p.id); got++; }
        catch (e) { if (e.kind === 'offline' || e.kind === 'signedout') { need.length = 0; } }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (got) this.changed = true;
  },

  // Full-size photo: downloaded when opened, then kept on the phone.
  async ensureBlob(p) {
    if (p.blob) return p.blob;
    if (!p.remoteImage || !this.signedIn) return null;
    p.blob = await downloadObj(`photos/${p.id}.jpg`);
    await putPhoto(p);
    return p.blob;
  },

  /* ----- status ----- */
  status() {
    if (!HB_CFG.on) return { state: 'off', text: '' };
    const n = this.pending;
    if (!this.signedIn) return { state: 'signedout', text: 'Signed out', long: this.lastError && this.lastError.kind === 'signedout' ? this.lastError.message : 'Not signed in — photos stay on this phone only.' };
    if ((typeof navigator.onLine === 'boolean' && !navigator.onLine) || (this.lastError && this.lastError.kind === 'offline'))
      return { state: 'offline', text: n ? `Offline · ${n}` : 'Offline', long: `Offline${n ? ` — ${n} change${n === 1 ? '' : 's'} will upload when you have signal` : ''}.` };
    if (this.running) return { state: 'syncing', text: this.phase || 'Syncing…', long: (this.phase || 'Syncing') + '…' };
    if (this.lastError) return { state: 'error', text: n ? `⚠ ${n} pending` : '⚠ Sync', long: `Can't sync right now: ${this.lastError.message}${n ? ` (${n} change${n === 1 ? '' : 's'} waiting)` : ''}. Your photos are safe on this phone.` };
    if (n) return { state: 'pending', text: `↑ ${n} pending`, long: `${n} change${n === 1 ? '' : 's'} waiting to upload.` };
    return { state: 'synced', text: '✓ Synced', long: `Up to date${this.lastOk ? ' · last synced ' + fmtDate(this.lastOk) : ''}.` };
  },
  badge() {
    const b = document.getElementById('syncBadge');
    if (!b) return;
    const st = this.status();
    b.hidden = st.state === 'off';
    b.textContent = st.text; b.dataset.state = st.state; b.title = st.long || st.text;
    const t = document.getElementById('syncStatusText');
    if (t) t.textContent = st.long || st.text;
  },
};
