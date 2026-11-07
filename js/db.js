/* =============================================================================
   js/db.js — Local phone storage (native IndexedDB) with an APPEND-ONLY ledger
   -----------------------------------------------------------------------------
   HOW STOCK WORKS
   • The `ledger` store is append-only. Every purchase, sale, return or stock
     correction is written as a NEW row with a precise timestamp. Ledger rows
     are never edited and never deleted.
   • A part has NO quantity column. Current stock = the sum of every ledger
     `qty` for that part (purchases are +, sales are −).
   • For speed, the sums are kept in an in-memory Map that is rebuilt from the
     ledger when the app starts and updated whenever a row is appended.
     `getStockFromLedger()` re-adds the rows straight from IndexedDB if you ever
     want to double-check the Map.

   STORES
     parts   – part catalogue (name, SKU, part number, prices, shelf ...)
     ledger  – append-only stock movements (+ / −)
     sales   – one record per receipt (also never edited)
     outbox  – queue of records waiting to be pushed to Supabase (js/sync.js)
     meta    – small key/value settings (device id, receipt counter, PIN hashes)

   NOTHING in this file touches localStorage.
   ============================================================================= */
'use strict';

const DB = (function () {
  const DB_NAME = 'truckparts_pos';
  const DB_VERSION = 1;

  // Allowed ledger types and the sign their quantity must have:
  //   +1 → qty must be positive, −1 → qty must be negative, 0 → either sign.
  const LEDGER_TYPES = Object.freeze({
    OPENING: 1,   // opening stock when a part is first created / imported
    PURCHASE: 1,  // stock received from a supplier
    RETURN: 1,    // customer return put back on the shelf
    SALE: -1,     // sold over the counter
    ADJUST: 0     // stock-take correction, damage, loss ...
  });

  let dbPromise = null;
  let db = null;
  let deviceId = 'D000000';
  const stockMap = new Map();   // partId → current stock (derived from ledger)
  const listeners = new Set();

  /* ---------------------------------------------------------------------------
     Small utilities
     --------------------------------------------------------------------------- */
  function nowISO() { return new Date().toISOString(); }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // Wrap a single IDBRequest in a Promise.
  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // Resolve when a transaction has fully committed, reject if it aborts.
  function txDone(t) {
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onabort = () => reject(t.error || new Error('Database transaction aborted'));
      t.onerror = () => { /* the abort handler reports it */ };
    });
  }

  function tx(stores, mode) {
    if (!db) throw new Error('Database is not open yet');
    return db.transaction(stores, mode || 'readonly');
  }

  // Walk a cursor; return false from `fn` to stop early.
  function cursorEach(source, range, direction, fn) {
    return new Promise((resolve, reject) => {
      const req = source.openCursor(range, direction || 'next');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(); return; }
        if (fn(cur.value, cur) === false) { resolve(); return; }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  function notify(evt) {
    listeners.forEach(fn => { try { fn(evt); } catch (e) { console.error(e); } });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ---------------------------------------------------------------------------
     Opening the database + schema
     --------------------------------------------------------------------------- */
  function createSchema(d) {
    if (!d.objectStoreNames.contains('parts')) {
      const s = d.createObjectStore('parts', { keyPath: 'id' });
      s.createIndex('sku', 'sku');
      s.createIndex('partNumber', 'partNumber');
      s.createIndex('brand', 'brand');
      s.createIndex('updatedAt', 'updatedAt');
    }
    if (!d.objectStoreNames.contains('ledger')) {
      const s = d.createObjectStore('ledger', { keyPath: 'id' });
      s.createIndex('partId', 'partId');
      s.createIndex('partTs', ['partId', 'ts']);   // history of one part, in time order
      s.createIndex('ts', 'ts');
      s.createIndex('type', 'type');
    }
    if (!d.objectStoreNames.contains('sales')) {
      const s = d.createObjectStore('sales', { keyPath: 'id' });
      s.createIndex('ts', 'ts');
      s.createIndex('receiptNo', 'receiptNo');
    }
    if (!d.objectStoreNames.contains('outbox')) {
      const s = d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      s.createIndex('kind', 'kind');
    }
    if (!d.objectStoreNames.contains('meta')) {
      d.createObjectStore('meta', { keyPath: 'key' });
    }
  }

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('This browser does not support IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => createSchema(req.result);
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => { db.close(); };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database is blocked by another tab. Close other copies of the app.'));
    }).then(async (d) => {
      await loadDeviceId();
      return d;
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  /* ---------------------------------------------------------------------------
     Meta (key/value)
     --------------------------------------------------------------------------- */
  async function getMeta(key, fallback) {
    const rec = await request(tx('meta').objectStore('meta').get(key));
    return rec ? rec.value : fallback;
  }

  async function setMeta(key, value) {
    const t = tx('meta', 'readwrite');
    t.objectStore('meta').put({ key, value });
    await txDone(t);
  }

  async function loadDeviceId() {
    let id = await getMeta('deviceId', null);
    if (!id) {
      id = 'D' + uuid().replace(/-/g, '').slice(0, 5).toUpperCase();
      await setMeta('deviceId', id);
    }
    deviceId = id;
  }

  function getDeviceId() { return deviceId; }

  /* ---------------------------------------------------------------------------
     Persistent storage — ask the phone never to evict our data
     --------------------------------------------------------------------------- */
  async function requestPersistence() {
    const info = { supported: false, persisted: false, usage: null, quota: null };
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
        info.supported = true;
        info.persisted = await navigator.storage.persisted();
        if (!info.persisted) info.persisted = await navigator.storage.persist();
      }
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        info.usage = est.usage;
        info.quota = est.quota;
      }
    } catch (err) {
      console.warn('Persistent storage request failed:', err);
    }
    return info;
  }

  /* ---------------------------------------------------------------------------
     Parts
     --------------------------------------------------------------------------- */
  function normalizePart(p) {
    return {
      id: p.id || uuid(),
      sku: String(p.sku || '').trim(),
      partNumber: String(p.partNumber || '').trim(),
      name: String(p.name || '').trim(),
      brand: String(p.brand || 'Other').trim() || 'Other',
      category: String(p.category || '').trim(),
      location: String(p.location || '').trim(),
      costPrice: Math.max(0, num(p.costPrice)),
      sellPrice: Math.max(0, num(p.sellPrice)),
      reorderLevel: Math.max(0, Math.trunc(num(p.reorderLevel))),
      active: p.active !== false,
      updatedAt: p.updatedAt || nowISO()
    };
  }

  async function getAllParts() {
    return request(tx('parts').objectStore('parts').getAll());
  }

  async function getPart(id) {
    return request(tx('parts').objectStore('parts').get(id));
  }

  /* ---------------------------------------------------------------------------
     Ledger
     --------------------------------------------------------------------------- */
  function validateLedgerRow(r) {
    if (!r.partId) throw new Error('Ledger row needs a part');
    if (!Object.prototype.hasOwnProperty.call(LEDGER_TYPES, r.type)) {
      throw new Error('Unknown ledger type: ' + r.type);
    }
    if (!Number.isInteger(r.qty) || r.qty === 0) {
      throw new Error('Quantity must be a whole number, not zero');
    }
    const sign = LEDGER_TYPES[r.type];
    if (sign > 0 && r.qty < 0) throw new Error(r.type + ' quantity must be positive');
    if (sign < 0 && r.qty > 0) throw new Error(r.type + ' quantity must be negative');
  }

  // Build one validated, immutable ledger row.
  function makeLedgerRow(spec) {
    const row = {
      id: spec.id || uuid(),
      partId: spec.partId,
      type: spec.type,
      qty: Math.trunc(num(spec.qty)),
      unitCost: spec.unitCost == null ? null : num(spec.unitCost),
      unitPrice: spec.unitPrice == null ? null : num(spec.unitPrice),
      refId: spec.refId || null,
      note: spec.note ? String(spec.note).slice(0, 200) : '',
      ts: spec.ts || nowISO(),
      device: deviceId
    };
    validateLedgerRow(row);
    return row;
  }

  function outboxEntry(kind, refId, payload) {
    return { kind, refId, payload, ts: nowISO(), attempts: 0, lastError: '' };
  }

  function applyToStock(row) {
    stockMap.set(row.partId, (stockMap.get(row.partId) || 0) + row.qty);
  }

  // Append rows to the ledger (append-only: `add`, never `put`).
  async function appendLedger(specs, opts) {
    const queue = !opts || opts.queue !== false;
    const rows = specs.map(s => (s && s.id && s.device ? s : makeLedgerRow(s)));
    rows.forEach(validateLedgerRow);
    const t = tx(['ledger', 'outbox'], 'readwrite');
    const ledger = t.objectStore('ledger');
    const outbox = t.objectStore('outbox');
    rows.forEach(r => {
      ledger.add(r);
      if (queue) outbox.add(outboxEntry('ledger', r.id, r));
    });
    await txDone(t);
    rows.forEach(applyToStock);
    notify({ type: 'stock' });
    return rows;
  }

  // Rebuild the stock map by adding up the whole ledger.
  async function rebuildStock() {
    stockMap.clear();
    const t = tx('ledger');
    await cursorEach(t.objectStore('ledger'), null, 'next', row => { applyToStock(row); });
  }

  function getStock(partId) { return stockMap.get(partId) || 0; }

  function getStockMap() { return stockMap; }

  // Authoritative sum straight from the ledger rows of one part.
  async function getStockFromLedger(partId) {
    let total = 0;
    const t = tx('ledger');
    await cursorEach(t.objectStore('ledger').index('partId'), IDBKeyRange.only(partId), 'next', row => {
      total += row.qty;
    });
    return total;
  }

  // Movement history of one part, newest first.
  async function ledgerForPart(partId, limit) {
    const out = [];
    const t = tx('ledger');
    const range = IDBKeyRange.bound([partId, ''], [partId, '￿']);
    await cursorEach(t.objectStore('ledger').index('partTs'), range, 'prev', row => {
      out.push(row);
      if (limit && out.length >= limit) return false;
    });
    return out;
  }

  async function ledgerCount() {
    return request(tx('ledger').objectStore('ledger').count());
  }

  /* ---------------------------------------------------------------------------
     Writing parts (+ optional ledger rows) atomically
     items: [{ part: {...}, ledger: [ {type, qty, unitCost, note}, ... ] }]
     --------------------------------------------------------------------------- */
  async function savePartBatch(items, opts) {
    const queue = !opts || opts.queue !== false;
    const prepared = items.map(it => {
      const part = normalizePart(it.part);
      part.updatedAt = nowISO();
      const rows = (it.ledger || []).map(spec => makeLedgerRow(Object.assign({}, spec, { partId: part.id })));
      return { part, rows };
    });
    const t = tx(['parts', 'ledger', 'outbox'], 'readwrite');
    const parts = t.objectStore('parts');
    const ledger = t.objectStore('ledger');
    const outbox = t.objectStore('outbox');
    prepared.forEach(({ part, rows }) => {
      parts.put(part);
      if (queue) outbox.add(outboxEntry('part', part.id, part));
      rows.forEach(r => {
        ledger.add(r);
        if (queue) outbox.add(outboxEntry('ledger', r.id, r));
      });
    });
    await txDone(t);
    prepared.forEach(({ rows }) => rows.forEach(applyToStock));
    notify({ type: 'parts' });
    return prepared.map(x => x.part);
  }

  // Import / generate many parts without freezing: small transactions in a row.
  async function bulkImport(items, opts) {
    const chunk = (opts && opts.chunk) || 250;
    const onProgress = opts && opts.onProgress;
    for (let i = 0; i < items.length; i += chunk) {
      await savePartBatch(items.slice(i, i + chunk), opts);
      if (onProgress) onProgress(Math.min(i + chunk, items.length), items.length);
      await new Promise(r => setTimeout(r, 0));   // let the screen breathe
    }
  }

  /* ---------------------------------------------------------------------------
     Sales — one atomic transaction: sale + ledger rows + outbox + receipt counter
     --------------------------------------------------------------------------- */
  function receiptNumber(isoTs, seq) {
    const d = new Date(isoTs);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${deviceId}-${yy}${mm}${dd}-${String(seq).padStart(4, '0')}`;
  }

  function recordSale(sale, ledgerSpecs, opts) {
    const queue = !opts || opts.queue !== false;
    return new Promise((resolve, reject) => {
      let rows;
      try {
        rows = ledgerSpecs.map(s => makeLedgerRow(Object.assign({}, s, { refId: sale.id })));
      } catch (err) { reject(err); return; }

      const t = tx(['sales', 'ledger', 'outbox', 'meta'], 'readwrite');
      const meta = t.objectStore('meta');
      const seqReq = meta.get('receiptSeq');
      seqReq.onsuccess = () => {
        const seq = (seqReq.result ? seqReq.result.value : 0) + 1;
        meta.put({ key: 'receiptSeq', value: seq });
        sale.receiptNo = receiptNumber(sale.ts, seq);
        sale.device = deviceId;
        t.objectStore('sales').add(sale);
        rows.forEach(r => t.objectStore('ledger').add(r));
        if (queue) {
          const outbox = t.objectStore('outbox');
          outbox.add(outboxEntry('sale', sale.id, sale));
          rows.forEach(r => outbox.add(outboxEntry('ledger', r.id, r)));
        }
      };
      t.oncomplete = () => {
        rows.forEach(applyToStock);
        notify({ type: 'sales' });
        resolve(sale);
      };
      t.onabort = () => reject(t.error || new Error('The sale could not be saved'));
    });
  }

  async function getSale(id) {
    return request(tx('sales').objectStore('sales').get(id));
  }

  // Sales between two ISO timestamps, newest first.
  async function getSalesBetween(fromISO, toISO, limit) {
    const out = [];
    const t = tx('sales');
    const range = IDBKeyRange.bound(fromISO, toISO);
    await cursorEach(t.objectStore('sales').index('ts'), range, 'prev', s => {
      out.push(s);
      if (limit && out.length >= limit) return false;
    });
    return out;
  }

  async function getAllSales() {
    return request(tx('sales').objectStore('sales').getAll());
  }

  /* ---------------------------------------------------------------------------
     Outbox — queue of local changes waiting to be sent to Supabase
     --------------------------------------------------------------------------- */
  async function outboxCount() {
    return request(tx('outbox').objectStore('outbox').count());
  }

  async function outboxBatch(limit) {
    const out = [];
    const t = tx('outbox');
    await cursorEach(t.objectStore('outbox'), null, 'next', entry => {
      out.push(entry);
      if (out.length >= limit) return false;
    });
    return out;
  }

  async function outboxDelete(seqs) {
    if (!seqs.length) return;
    const t = tx('outbox', 'readwrite');
    const store = t.objectStore('outbox');
    seqs.forEach(s => store.delete(s));
    await txDone(t);
  }

  async function outboxFail(seqs, message) {
    if (!seqs.length) return;
    const t = tx('outbox', 'readwrite');
    const store = t.objectStore('outbox');
    seqs.forEach(seq => {
      const r = store.get(seq);
      r.onsuccess = () => {
        if (!r.result) return;
        r.result.attempts = (r.result.attempts || 0) + 1;
        r.result.lastError = String(message || '').slice(0, 300);
        store.put(r.result);
      };
    });
    await txDone(t);
  }

  /* ---------------------------------------------------------------------------
     Ingesting records pulled from other phones (never re-queued for upload)
     --------------------------------------------------------------------------- */
  // Insert rows that may already exist; duplicates (same id) are silently skipped.
  function addIgnoringDuplicates(storeName, rows) {
    return new Promise((resolve, reject) => {
      if (!rows.length) { resolve([]); return; }
      const inserted = [];
      const t = tx(storeName, 'readwrite');
      const store = t.objectStore(storeName);
      rows.forEach(row => {
        const req = store.add(row);
        req.onsuccess = () => inserted.push(row);
        req.onerror = (ev) => {
          if (req.error && req.error.name === 'ConstraintError') {
            ev.preventDefault();      // keep the transaction alive
            ev.stopPropagation();
          }
        };
      });
      t.oncomplete = () => resolve(inserted);
      t.onabort = () => reject(t.error || new Error('Could not save downloaded records'));
    });
  }

  async function ingestRemoteLedger(rows) {
    rows.forEach(validateLedgerRow);
    const inserted = await addIgnoringDuplicates('ledger', rows);
    inserted.forEach(applyToStock);
    return inserted.length;
  }

  async function ingestRemoteSales(rows) {
    const inserted = await addIgnoringDuplicates('sales', rows);
    return inserted.length;
  }

  // Parts use "newest edit wins" (compared by updatedAt).
  function ingestRemoteParts(rows) {
    return new Promise((resolve, reject) => {
      if (!rows.length) { resolve(0); return; }
      let changed = 0;
      const t = tx('parts', 'readwrite');
      const store = t.objectStore('parts');
      rows.forEach(remote => {
        const req = store.get(remote.id);
        req.onsuccess = () => {
          const local = req.result;
          if (!local || remote.updatedAt > local.updatedAt) {
            store.put(normalizePartKeepTime(remote));
            changed++;
          }
        };
      });
      t.oncomplete = () => resolve(changed);
      t.onabort = () => reject(t.error || new Error('Could not save downloaded parts'));
    });
  }

  function normalizePartKeepTime(p) {
    const n = normalizePart(p);
    n.updatedAt = p.updatedAt;
    return n;
  }

  /* ---------------------------------------------------------------------------
     Danger zone — delete this phone's database completely
     --------------------------------------------------------------------------- */
  async function wipeAll() {
    if (db) { db.close(); db = null; }
    dbPromise = null;
    stockMap.clear();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  return {
    LEDGER_TYPES, open, uuid, nowISO, getDeviceId, getMeta, setMeta, requestPersistence,
    getAllParts, getPart, savePartBatch, bulkImport,
    makeLedgerRow, appendLedger, rebuildStock, getStock, getStockMap, getStockFromLedger,
    ledgerForPart, ledgerCount,
    recordSale, getSale, getSalesBetween, getAllSales,
    outboxCount, outboxBatch, outboxDelete, outboxFail,
    ingestRemoteLedger, ingestRemoteSales, ingestRemoteParts,
    subscribe, notify, wipeAll
  };
})();
