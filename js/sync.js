/* =============================================================================
   js/sync.js — Supabase cloud sync with an offline queue
   -----------------------------------------------------------------------------
   HOW IT WORKS
   • Every local change (part saved, stock moved, sale made) is also written to
     the `outbox` queue in IndexedDB (see db.js). The queue lives on the phone,
     so nothing is lost when the market has no signal.
   • A loop runs while the app is open:
        1. PUSH – send everything waiting in the outbox to Supabase.
        2. PULL – download rows created by OTHER shop phones.
     It runs every ~20 s, instantly when the browser fires the `online` event,
     and ~0.3 s after every sale. If a request fails it backs off and retries.
   • The Supabase library is loaded from a CDN <script> tag in index.html. If
     the phone was offline when the page opened, this file loads it again later.
   • Ledger rows and sales are immutable and inserted with "ignore duplicates",
     so retrying a push can never double-count stock.
   • Pull uses a server-side `server_ts` column (see supabase-schema.sql) so
     phones with wrong clocks cannot cause rows to be missed.

   Configure the project URL + anon key in Settings (owner), or put them in
   DEFAULT_URL / DEFAULT_KEY below.
   ============================================================================= */
'use strict';

const Sync = (function () {
  const CDN_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  const DEFAULT_URL = '';   // e.g. 'https://abcdxyz.supabase.co'
  const DEFAULT_KEY = '';   // the project's public "anon" key

  const PUSH_BATCH = 200;       // rows per upload request
  const PULL_PAGE = 1000;       // rows per download request
  const IDLE_DELAY = 20000;     // normal gap between sync rounds (ms)
  const MAX_DELAY = 120000;     // longest back-off after repeated failures (ms)
  const PULL_OVERLAP_MS = 120000; // re-read the last 2 minutes (safe: inserts ignore duplicates)
  const EPOCH = '1970-01-01T00:00:00+00:00';

  let cfg = { url: DEFAULT_URL, key: DEFAULT_KEY };
  let client = null;
  let clientSig = '';
  let started = false;
  let running = false;
  let rerun = false;
  let failures = 0;
  let timer = null;
  let libPromise = null;

  const status = { state: 'local', message: 'Cloud sync is not set up', pending: 0, lastSync: null };
  const listeners = new Set();

  /* ---------------------------------------------------------------------------
     Status reporting
     --------------------------------------------------------------------------- */
  function emit() {
    const snap = Object.assign({}, status);
    listeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }

  function setState(state, message) {
    status.state = state;
    status.message = message || '';
    emit();
  }

  function onStatus(fn) {
    listeners.add(fn);
    fn(Object.assign({}, status));
    return () => listeners.delete(fn);
  }

  function getStatus() { return Object.assign({}, status); }

  async function refreshPending() {
    try { status.pending = await DB.outboxCount(); } catch (e) { /* db not ready */ }
    emit();
    return status.pending;
  }

  /* ---------------------------------------------------------------------------
     Errors
     --------------------------------------------------------------------------- */
  function isNetworkMessage(msg) {
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|offline|err_internet|err_name_not_resolved/i
      .test(String(msg || ''));
  }

  function toError(error) {
    const msg = (error && (error.message || error.details)) || String(error);
    const err = new Error(msg);
    err.network = isNetworkMessage(msg) || (error && error.status === 0);
    return err;
  }

  /* ---------------------------------------------------------------------------
     Loading the Supabase library + creating the client
     --------------------------------------------------------------------------- */
  function libReady() {
    return typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // The <script async> tag in index.html may still be downloading; give it a moment,
  // then inject a fresh <script> (used when the page was opened while offline).
  async function loadLibrary() {
    if (libReady()) return true;
    if (libPromise) return libPromise;
    libPromise = (async () => {
      for (let i = 0; i < 8 && !libReady(); i++) await sleep(250);
      if (libReady()) return true;
      if (typeof document === 'undefined') return false;
      await new Promise(resolve => {
        const s = document.createElement('script');
        let finished = false;
        const done = () => { if (!finished) { finished = true; resolve(); } };
        s.src = CDN_URL;
        s.async = true;
        s.onload = done;
        s.onerror = () => { s.remove(); done(); };
        setTimeout(done, 12000);
        document.head.appendChild(s);
      });
      return libReady();
    })().finally(() => { libPromise = null; });
    return libPromise;
  }

  function ensureClient() {
    if (!cfg.url || !cfg.key) return false;
    const sig = cfg.url + '|' + cfg.key;
    if (client && clientSig === sig) return true;
    if (!libReady()) return false;
    client = window.supabase.createClient(cfg.url, cfg.key, {
      // No login session is stored (so nothing is written to localStorage).
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    clientSig = sig;
    return true;
  }

  /* ---------------------------------------------------------------------------
     Field mapping: local camelCase  <->  Supabase snake_case
     --------------------------------------------------------------------------- */
  const iso = v => new Date(v).toISOString();

  const toRemote = {
    part: p => ({
      id: p.id, sku: p.sku, part_number: p.partNumber, name: p.name, brand: p.brand,
      category: p.category, location: p.location, cost_price: p.costPrice,
      sell_price: p.sellPrice, reorder_level: p.reorderLevel, active: p.active !== false,
      updated_at: p.updatedAt
    }),
    ledger: l => ({
      id: l.id, part_id: l.partId, type: l.type, qty: l.qty, unit_cost: l.unitCost,
      unit_price: l.unitPrice, ref_id: l.refId, note: l.note, ts: l.ts, device: l.device
    }),
    sale: s => ({
      id: s.id, receipt_no: s.receiptNo, ts: s.ts, items: s.items, subtotal: s.subtotal,
      total: s.total, cost: s.cost, profit: s.profit, payment: s.payment,
      customer: s.customer || '', role: s.role, device: s.device
    })
  };

  const fromRemote = {
    part: r => ({
      id: r.id, sku: r.sku || '', partNumber: r.part_number || '', name: r.name || '',
      brand: r.brand || 'Other', category: r.category || '', location: r.location || '',
      costPrice: Number(r.cost_price) || 0, sellPrice: Number(r.sell_price) || 0,
      reorderLevel: Number(r.reorder_level) || 0, active: r.active !== false,
      updatedAt: iso(r.updated_at)
    }),
    ledger: r => ({
      id: r.id, partId: r.part_id, type: r.type, qty: Number(r.qty),
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
      refId: r.ref_id || null, note: r.note || '', ts: iso(r.ts), device: r.device || ''
    }),
    sale: r => ({
      id: r.id, receiptNo: r.receipt_no, ts: iso(r.ts),
      items: Array.isArray(r.items) ? r.items : [],
      subtotal: Number(r.subtotal) || 0, total: Number(r.total) || 0,
      cost: Number(r.cost) || 0, profit: Number(r.profit) || 0,
      payment: r.payment || '', customer: r.customer || '', role: r.role || '', device: r.device || ''
    })
  };

  /* ---------------------------------------------------------------------------
     PUSH: outbox → Supabase
     --------------------------------------------------------------------------- */
  async function upsert(table, rows, ignoreDuplicates) {
    for (let i = 0; i < rows.length; i += PUSH_BATCH) {
      const chunk = rows.slice(i, i + PUSH_BATCH);
      const { error } = await client.from(table).upsert(chunk, { onConflict: 'id', ignoreDuplicates });
      if (error) throw toError(error);
    }
  }

  async function push() {
    for (;;) {
      const batch = await DB.outboxBatch(PUSH_BATCH);
      if (!batch.length) return;

      // Parts: only the newest queued version of each part needs to be sent.
      const partsById = new Map();
      const ledger = [];
      const sales = [];
      batch.forEach(entry => {
        if (entry.kind === 'part') partsById.set(entry.refId, toRemote.part(entry.payload));
        else if (entry.kind === 'ledger') ledger.push(toRemote.ledger(entry.payload));
        else if (entry.kind === 'sale') sales.push(toRemote.sale(entry.payload));
      });

      const seqs = batch.map(b => b.seq);
      try {
        await upsert('parts', Array.from(partsById.values()), false);   // newest edit wins
        await upsert('ledger', ledger, true);                           // append-only
        await upsert('sales', sales, true);                             // append-only
      } catch (err) {
        await DB.outboxFail(seqs, err.message);
        throw err;
      }
      await DB.outboxDelete(seqs);
      await refreshPending();
      setState('syncing', 'Uploading… ' + status.pending + ' left');
    }
  }

  /* ---------------------------------------------------------------------------
     PULL: Supabase → this phone
     --------------------------------------------------------------------------- */
  async function pull() {
    const jobs = [
      { table: 'parts', label: 'parts', map: fromRemote.part, save: DB.ingestRemoteParts },
      { table: 'ledger', label: 'stock', map: fromRemote.ledger, save: DB.ingestRemoteLedger },
      { table: 'sales', label: 'sales', map: fromRemote.sale, save: DB.ingestRemoteSales }
    ];
    let changed = 0;

    for (const job of jobs) {
      const metaKey = 'cursor_' + job.table;
      let cursor = await DB.getMeta(metaKey, EPOCH);
      let from = cursor;
      if (cursor !== EPOCH) {
        const t = Date.parse(cursor);
        if (!isNaN(t)) from = new Date(t - PULL_OVERLAP_MS).toISOString();
      }
      let downloaded = 0;

      for (;;) {
        const { data, error } = await client.from(job.table).select('*')
          .gte('server_ts', from)
          .order('server_ts', { ascending: true })
          .order('id', { ascending: true })
          .limit(PULL_PAGE);
        if (error) throw toError(error);
        if (!data || !data.length) break;

        changed += await job.save(data.map(job.map));
        downloaded += data.length;
        if (downloaded > PULL_PAGE) setState('syncing', 'Downloading ' + job.label + '… ' + downloaded);

        const last = data[data.length - 1].server_ts;
        const first = data[0].server_ts;
        cursor = last;
        await DB.setMeta(metaKey, cursor);

        if (data.length < PULL_PAGE) break;       // that was the last page
        if (last === first) break;                // whole page has one timestamp: avoid looping forever
        from = last;
      }
    }
    if (changed > 0) DB.notify({ type: 'remote', changed });
  }

  /* ---------------------------------------------------------------------------
     The sync loop
     --------------------------------------------------------------------------- */
  function schedule(delay) {
    clearTimeout(timer);
    if (!started) return;
    timer = setTimeout(() => { syncNow('timer'); }, delay);
  }

  async function syncNow() {
    if (!started) return;
    if (running) { rerun = true; return; }
    await refreshPending();

    if (!cfg.url || !cfg.key) {
      setState('local', 'Cloud sync is not set up — sales are saved on this phone only');
      schedule(30000);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState('offline', 'No internet — ' + status.pending + ' record(s) waiting to upload');
      schedule(5000);
      return;
    }

    running = true;
    setState('syncing', 'Syncing…');
    try {
      if (!ensureClient()) {
        const ok = await loadLibrary();
        if (!ok || !ensureClient()) {
          const err = new Error('Cloud library could not be loaded (no internet?)');
          err.network = true;
          throw err;
        }
      }
      await push();
      await pull();
      failures = 0;
      status.lastSync = new Date().toISOString();
      await refreshPending();
      setState('synced', 'Up to date');
    } catch (err) {
      failures++;
      await refreshPending();
      const net = err.network !== undefined ? err.network : isNetworkMessage(err.message);
      if (net) setState('offline', 'No internet — ' + status.pending + ' record(s) waiting to upload');
      else setState('error', err.message || 'Sync failed');
    } finally {
      running = false;
      const delay = rerun ? 400
        : failures ? Math.min(MAX_DELAY, 4000 * Math.pow(2, Math.min(failures, 5)))
        : IDLE_DELAY;
      rerun = false;
      schedule(delay);
    }
  }

  // Call after saving anything locally: updates the queue counter and syncs soon.
  function kick() {
    refreshPending();
    if (started && cfg.url && cfg.key) schedule(300);
  }

  /* ---------------------------------------------------------------------------
     Setup
     --------------------------------------------------------------------------- */
  async function init() {
    const saved = await DB.getMeta('supabase', null);
    if (saved && saved.url && saved.key) cfg = { url: saved.url, key: saved.key };
    started = true;

    window.addEventListener('online', () => {
      failures = 0;
      syncNow('online');          // the moment the phone reconnects: push + pull
    });
    window.addEventListener('offline', () => {
      refreshPending().then(() => setState('offline', 'No internet — ' + status.pending + ' record(s) waiting to upload'));
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncNow('visible');
    });

    await refreshPending();
    syncNow('start');
  }

  async function configure(url, key) {
    cfg = { url: String(url || '').trim().replace(/\/+$/, ''), key: String(key || '').trim() };
    await DB.setMeta('supabase', cfg);
    client = null;
    clientSig = '';
    failures = 0;
    if (!cfg.url || !cfg.key) {
      setState('local', 'Cloud sync is not set up — sales are saved on this phone only');
      return;
    }
    syncNow('configure');
  }

  function getConfig() { return Object.assign({}, cfg); }

  async function testConnection() {
    if (!cfg.url || !cfg.key) return { ok: false, message: 'Enter the project URL and anon key first.' };
    try {
      if (!ensureClient()) {
        const ok = await loadLibrary();
        if (!ok || !ensureClient()) return { ok: false, message: 'Cloud library not loaded — check the internet connection.' };
      }
      const { error } = await client.from('parts').select('id').limit(1);
      if (error) return { ok: false, message: error.message };
      return { ok: true, message: 'Connected to Supabase.' };
    } catch (err) {
      return { ok: false, message: err.message || 'Connection failed' };
    }
  }

  return { init, configure, getConfig, kick, syncNow, onStatus, getStatus, testConnection, refreshPending };
})();
