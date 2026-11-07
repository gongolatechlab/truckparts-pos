/* =============================================================================
   js/app.js — Interface, instant search engine and PIN security
   -----------------------------------------------------------------------------
   SECTIONS
     1. Helpers                      7. Stock tab, part sheet and forms
     2. State                        8. Sales tab
     3. Toast + bottom sheet         9. Owner dashboard
     4. PIN security + roles        10. Settings, CSV, sample data
     5. Parts + SEARCH ENGINE       11. Sync status chip
     6. Sell tab, cart, receipts    12. Events + boot

   SECURITY MODEL (read this)
   • Staff PIN (0000):  cost prices, profits and the dashboard are never loaded
     into the screen. The owner-only buttons/sections are physically removed
     from the page and the part objects used by the interface have NO cost field.
   • Owner PIN (1234):  everything is available.
   • A 4-digit PIN is a convenience lock for a shared shop phone, not strong
     security. Change both PINs in Settings before real use.
   ============================================================================= */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  const BRANDS = ['Mack', 'Volvo', 'Scania', 'DAF'];
  const PAGE_SIZE = 40;          // rows drawn at once in a result list
  const MAX_ATTEMPTS = 5;        // wrong PINs before a short lock-out
  const LOCKOUT_MS = 30000;

  const TYPE_LABEL = {
    OPENING: 'Opening stock', PURCHASE: 'Stock received', SALE: 'Sold',
    RETURN: 'Customer return', ADJUST: 'Adjustment'
  };

  /* ===========================================================================
     1. HELPERS
     =========================================================================== */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const nf = new Intl.NumberFormat('en-NG', { maximumFractionDigits: 2 });
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const money = n => '₦' + nf.format(Number(n) || 0);

  function compact(n) {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(Math.round(n));
  }

  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }

  function parseNum(v) {
    const n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function friendlyError(err) {
    if (err && err.name === 'QuotaExceededError') return 'Phone storage is full — free some space and try again.';
    return (err && err.message) || 'Something went wrong';
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function dayKey(iso) {
    const d = new Date(iso);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Local-day based ranges → ISO strings for the IndexedDB `ts` index.
  function rangeBounds(range) {
    const now = new Date();
    const start = startOfDay(now);
    if (range === '7d') start.setDate(start.getDate() - 6);
    if (range === '30d') start.setDate(start.getDate() - 29);
    return { from: start.toISOString(), to: new Date(now.getTime() + 60000).toISOString() };
  }

  function download(filename, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;   // stop spreadsheet formulas
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows) { return rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

  // Minimal CSV reader (handles quoted fields, commas and line breaks in quotes).
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  /* ===========================================================================
     2. STATE
     =========================================================================== */
  const state = {
    role: null,                 // 'staff' | 'owner' | null (locked)
    lastRole: null,
    tab: 'sell',
    parts: [],                  // part view-models (cost only present for the owner)
    partsById: new Map(),
    index: [],                  // search index built from `parts`
    cart: [],                   // [{ partId, qty, price }]
    busy: false,
    lastSale: null,
    settings: { shopName: 'De Sunny Daf', address: '', phone: '', autoLockMin: 5 },
    salesRange: 'today',
    dashRange: '7d',
    persist: null,
    syncStatus: { state: 'local', message: '', pending: 0, lastSync: null },
    ready: false
  };

  const isOwner = () => state.role === 'owner';

  /* ===========================================================================
     3. TOAST + BOTTOM SHEET
     =========================================================================== */
  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 4500 : 2400);
  }

  let sheetOnClose = null;

  // Opens the sheet, or swaps its content if it is already open.
  function openSheet(opts) {
    const sheet = $('#sheet');
    const backdrop = $('#sheet-backdrop');
    const wasOpen = !sheet.hidden;
    $('#sheet-title').textContent = opts.title || '';
    $('#sheet-body').innerHTML = opts.body || '';
    const foot = $('#sheet-foot');
    foot.innerHTML = opts.foot || '';
    foot.hidden = !opts.foot;
    sheetOnClose = opts.onClose || null;
    sheet.hidden = false;
    backdrop.hidden = false;
    void sheet.offsetHeight;                // restart the slide-up animation
    sheet.classList.add('open');
    backdrop.classList.add('open');
    $('#sheet-body').scrollTop = 0;
    // One history entry per open sheet so the Android Back button closes it.
    if (!wasOpen) { try { history.pushState({ sheet: true }, ''); } catch (e) { /* ignore */ } }
  }

  function closeSheet(fromPopState) {
    const sheet = $('#sheet');
    if (sheet.hidden) return;
    sheet.classList.remove('open');
    $('#sheet-backdrop').classList.remove('open');
    sheet.hidden = true;
    $('#sheet-backdrop').hidden = true;
    const cb = sheetOnClose;
    sheetOnClose = null;
    if (!fromPopState) {
      try { if (history.state && history.state.sheet) history.back(); } catch (e) { /* ignore */ }
    }
    if (cb) cb();
  }

  /* ===========================================================================
     4. PIN SECURITY + ROLES
     =========================================================================== */

  // Small deterministic string hash so PINs are not stored as plain text.
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function hashPin(pin, salt) {
    return cyrb53(salt + ':' + pin, 7).toString(36) + '.' + cyrb53(pin + ':' + salt, 13).toString(36);
  }

  let pinStore = null;   // { salt, staff, owner } (hashes)

  async function ensurePins() {
    pinStore = await DB.getMeta('pins', null);
    if (!pinStore) {
      const salt = DB.uuid().slice(0, 8);
      pinStore = { salt, staff: hashPin('0000', salt), owner: hashPin('1234', salt) };
      await DB.setMeta('pins', pinStore);
    }
  }

  function roleForPin(pin) {
    const h = hashPin(pin, pinStore.salt);
    if (h === pinStore.owner) return 'owner';
    if (h === pinStore.staff) return 'staff';
    return null;
  }

  /* ---- Owner-only elements: really removed from the page for Staff ---- */
  const ownerNodes = [];   // [{ node, marker }]

  function captureOwnerNodes() {
    $$('[data-owner-only]').forEach(node => {
      const marker = document.createComment('owner-only');
      node.parentNode.insertBefore(marker, node);
      ownerNodes.push({ node, marker });
    });
  }

  function applyRole(role) {
    ownerNodes.forEach(({ node, marker }) => {
      if (role === 'owner') {
        if (!node.parentNode && marker.parentNode) marker.parentNode.insertBefore(node, marker.nextSibling);
      } else if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    document.body.dataset.role = role || 'none';
  }

  /* ---- Lock screen ---- */
  const lock = { buf: '', fails: 0, until: 0 };

  function setLockMsg(text, isError) {
    const m = $('#lock-msg');
    m.textContent = text;
    m.classList.toggle('error', !!isError);
  }

  function renderDots() {
    $$('#pin-dots i').forEach((d, i) => d.classList.toggle('on', i < lock.buf.length));
  }

  function pinKey(k) {
    if (!state.ready) return;
    if (Date.now() < lock.until) {
      setLockMsg('Too many wrong PINs. Wait ' + Math.ceil((lock.until - Date.now()) / 1000) + ' s.', true);
      return;
    }
    if (k === 'back') lock.buf = lock.buf.slice(0, -1);
    else if (k === 'clear') lock.buf = '';
    else if (/^\d$/.test(k) && lock.buf.length < 4) lock.buf += k;
    renderDots();
    if (lock.buf.length === 4) submitPin();
  }

  async function submitPin() {
    const pin = lock.buf;
    const role = roleForPin(pin);
    lock.buf = '';
    if (role) {
      lock.fails = 0;
      renderDots();
      setLockMsg('');
      try { await login(role); } catch (err) { console.error(err); setLockMsg(friendlyError(err), true); }
      return;
    }
    lock.fails++;
    renderDots();
    const dots = $('#pin-dots');
    dots.classList.remove('shake');
    void dots.offsetWidth;
    dots.classList.add('shake');
    if (navigator.vibrate) navigator.vibrate(120);
    if (lock.fails >= MAX_ATTEMPTS) {
      lock.until = Date.now() + LOCKOUT_MS;
      lock.fails = 0;
      setLockMsg('Too many wrong PINs. Try again in 30 seconds.', true);
    } else {
      setLockMsg('Wrong PIN — ' + (MAX_ATTEMPTS - lock.fails) + ' tries left.', true);
    }
  }

  async function login(role) {
    if (state.lastRole && state.lastRole !== role) state.cart = [];
    state.role = role;
    state.lastRole = role;
    applyRole(role);
    const badge = $('#role-badge');
    badge.textContent = role === 'owner' ? 'OWNER' : 'STAFF';
    await loadParts();                       // builds staff/owner view-models
    $('#lock-screen').hidden = true;
    $('#app').hidden = false;
    DB.requestPersistence().then(info => { state.persist = info; });   // (a tap is a good moment to ask)
    resetIdleTimer();
    showTab('sell');
    Sync.refreshPending();
  }

  function lockApp(message) {
    closeSheet();
    state.role = null;
    ['sell-results', 'stock-results', 'sales-list', 'sales-summary', 'dash-body', 'sell-info', 'stock-info'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    });
    ['set-sb-key', 'set-cur-owner', 'set-new-staff', 'set-new-owner', 'wipe-confirm'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    state.parts = [];
    state.partsById = new Map();
    state.index = [];
    applyRole(null);
    clearTimeout(idleTimer);
    lock.buf = '';
    renderDots();
    $('#app').hidden = true;
    $('#lock-screen').hidden = false;
    setLockMsg(message || 'Enter your PIN');
  }

  /* ---- Auto-lock after inactivity ---- */
  let idleTimer = null;
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!state.role || !state.settings.autoLockMin) return;
    idleTimer = setTimeout(() => lockApp('Locked after inactivity'), state.settings.autoLockMin * 60000);
  }

  /* ===========================================================================
     5. PARTS + SEARCH ENGINE
     =========================================================================== */

  // The interface only ever sees this view-model. For Staff it has NO cost field.
  function toView(p) {
    const v = {
      id: p.id, sku: p.sku || '', partNumber: p.partNumber || '', name: p.name || '',
      brand: p.brand || 'Other', category: p.category || '', location: p.location || '',
      sellPrice: Number(p.sellPrice) || 0, reorderLevel: Number(p.reorderLevel) || 0,
      updatedAt: p.updatedAt
    };
    if (isOwner()) v.costPrice = Number(p.costPrice) || 0;
    return v;
  }

  async function loadParts() {
    const raw = await DB.getAllParts();
    state.parts = raw.filter(p => p.active !== false).map(toView);
    state.parts.sort((a, b) => collator.compare(a.name, b.name));
    state.partsById = new Map(state.parts.map(p => [p.id, p]));
    buildIndex();
  }

  const stripNonAlnum = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  // One pre-lowercased entry per part so a search is just fast substring checks.
  function buildIndex() {
    state.index = state.parts.map(p => ({
      p,
      hay: (p.name + ' ' + p.sku + ' ' + p.partNumber + ' ' + p.brand + ' ' + p.category + ' ' + p.location).toLowerCase(),
      norm: stripNonAlnum(p.sku + p.partNumber + p.name),     // "21-083 345" still finds "21083345"
      skuN: stripNonAlnum(p.sku),
      pnN: stripNonAlnum(p.partNumber),
      nameL: p.name.toLowerCase()
    }));
  }

  /* Search works through the index in slices of 3,000 parts and hands control
     back to the browser between slices, so typing and scrolling stay smooth even
     with tens of thousands of parts. A newer keystroke cancels an older search. */
  function searchParts(query, brand, lowOnly, isCurrent) {
    return new Promise(resolve => {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const normTokens = tokens.map(stripNonAlnum);
      const qNorm = normTokens.join('');
      const idx = state.index;
      const total = idx.length;
      const out = [];
      const SLICE = 3000;
      let i = 0;

      (function step() {
        if (!isCurrent()) { resolve(null); return; }       // superseded by a newer search
        const end = Math.min(i + SLICE, total);
        for (; i < end; i++) {
          const e = idx[i];
          const p = e.p;
          if (brand !== 'All' && p.brand !== brand) continue;
          if (lowOnly && DB.getStock(p.id) > p.reorderLevel) continue;

          let ok = true;
          for (let t = 0; t < tokens.length; t++) {
            if (e.hay.indexOf(tokens[t]) === -1 &&
                !(normTokens[t].length > 1 && e.norm.indexOf(normTokens[t]) !== -1)) { ok = false; break; }
          }
          if (!ok) continue;

          let score = 0;
          if (tokens.length) {
            if (qNorm && (e.skuN === qNorm || e.pnN === qNorm)) score = 100;        // exact SKU / part no.
            else if (qNorm && (e.skuN.startsWith(qNorm) || e.pnN.startsWith(qNorm))) score = 70;
            else if (e.nameL.startsWith(tokens[0])) score = 40;
            else score = 10;
            if (DB.getStock(p.id) > 0) score += 5;                                  // in-stock first
          }
          out.push({ p, score });
        }
        if (i < total) { setTimeout(step, 0); return; }
        if (tokens.length) out.sort((a, b) => b.score - a.score);   // stable: ties stay A→Z
        resolve(out.map(x => x.p));
      })();
    });
  }

  // Search UI state for the two list screens.
  const S = {
    sell: { input: '#sell-search', list: '#sell-results', info: '#sell-info', chips: '#sell-brands', brand: 'All', low: false, token: 0, results: [], shown: PAGE_SIZE, timer: null },
    stock: { input: '#stock-search', list: '#stock-results', info: '#stock-info', chips: '#stock-brands', brand: 'All', low: false, token: 0, results: [], shown: PAGE_SIZE, timer: null }
  };

  async function runSearchFor(key) {
    const s = S[key];
    const token = ++s.token;
    const res = await searchParts($(s.input).value, s.brand, s.low, () => token === s.token);
    if (res === null) return;
    s.results = res;
    s.shown = PAGE_SIZE;
    renderResults(key);
  }

  function brandBadge(brand) {
    return '<span class="brand b-' + esc(String(brand).toLowerCase().replace(/[^a-z]/g, '')) + '">' + esc(brand) + '</span>';
  }

  function stockInfo(p) {
    const n = DB.getStock(p.id);
    if (n <= 0) return { cls: 'out', text: 'Out of stock', n };
    if (n <= p.reorderLevel) return { cls: 'low', text: n + ' left (low)', n };
    return { cls: 'ok', text: n + ' in stock', n };
  }

  function partRow(p, key) {
    const st = stockInfo(p);
    const costLine = (key === 'stock' && isOwner()) ? '<div class="cost">Cost ' + money(p.costPrice) + '</div>' : '';
    return '<button type="button" class="part" data-action="' + (key === 'sell' ? 'add' : 'open-part') + '" data-id="' + esc(p.id) + '">' +
      '<div class="part-main"><div class="part-name">' + esc(p.name) + '</div>' +
      '<div class="part-meta">' + brandBadge(p.brand) + '<span>SKU ' + esc(p.sku) + '</span>' +
      (p.partNumber ? '<span>PN ' + esc(p.partNumber) + '</span>' : '') +
      (p.location ? '<span>Shelf ' + esc(p.location) + '</span>' : '') + '</div></div>' +
      '<div class="part-side"><div class="price">' + money(p.sellPrice) + '</div>' +
      '<div class="stock ' + st.cls + '">' + st.text + '</div>' + costLine + '</div></button>';
  }

  function renderResults(key) {
    const s = S[key];
    const list = $(s.list);
    const info = $(s.info);
    if (!list) return;
    const q = $(s.input).value.trim();
    const total = state.parts.length;

    if (!total) {
      info.textContent = '';
      list.innerHTML = '<div class="empty">No parts yet.' +
        (isOwner() ? '<br>Add one in <b>Stock → ＋ New part</b>, or use <b>Settings → Import / sample parts</b>.' : '<br>Ask the owner to add parts.') + '</div>';
      return;
    }
    const n = s.results.length;
    info.textContent = (q || s.brand !== 'All' || s.low)
      ? n + (n === 1 ? ' match' : ' matches') + ' (of ' + nf.format(total) + ' parts)'
      : nf.format(total) + ' parts';
    if (!n) { list.innerHTML = '<div class="empty">No parts match your search.</div>'; return; }

    const slice = s.results.slice(0, s.shown);
    list.innerHTML = slice.map(p => partRow(p, key)).join('') +
      (n > s.shown ? '<button type="button" class="btn ghost block" data-action="more" data-key="' + key + '">Show more (' + (n - s.shown) + ' left)</button>' : '');
  }

  /* ===========================================================================
     6. SELL TAB — cart, checkout, receipts
     =========================================================================== */
  function renderSell() { runSearchFor('sell'); updateCartBar(); }

  function cartCount() { return state.cart.reduce((a, l) => a + l.qty, 0); }
  function cartSubtotal() { return state.cart.reduce((a, l) => a + l.qty * l.price, 0); }

  function updateCartBar() {
    const n = cartCount();
    $('#cart-bar').hidden = !(n > 0 && state.role && state.tab === 'sell');
    $('#cart-count').textContent = n;
    $('#cart-total').textContent = money(cartSubtotal());
  }

  function addToCart(id) {
    const p = state.partsById.get(id);
    if (!p) return;
    const stock = DB.getStock(id);
    const line = state.cart.find(l => l.partId === id);
    const have = line ? line.qty : 0;
    if (have + 1 > stock) { toast(stock <= 0 ? 'Out of stock' : 'Only ' + stock + ' in stock', 'warn'); return; }
    if (line) line.qty++; else state.cart.push({ partId: id, qty: 1, price: p.sellPrice });
    if (navigator.vibrate) navigator.vibrate(12);
    updateCartBar();
    toast('Added: ' + p.name);
  }

  function cartLinesHTML() {
    return state.cart.map(l => {
      const p = state.partsById.get(l.partId);
      if (!p) return '';
      const id = esc(l.partId);
      const priceCell = isOwner()
        ? '<div class="cl-price"><input type="number" inputmode="decimal" min="0" step="any" value="' + esc(l.price) + '" data-role="price" data-id="' + id + '" aria-label="Unit price"></div>'
        : '<div class="muted">' + money(l.price) + ' each</div>';
      return '<div class="cart-line">' +
        '<div class="cl-top"><div class="cl-main"><div class="cl-name">' + esc(p.name) + '</div>' +
        '<div class="cl-sub">SKU ' + esc(p.sku) + ' · ' + DB.getStock(p.id) + ' in stock</div></div>' +
        '<button type="button" class="icon-btn" data-action="cart-remove" data-id="' + id + '" aria-label="Remove">✕</button></div>' +
        '<div class="cl-ctl"><div class="stepper">' +
        '<button type="button" data-action="qty-dec" data-id="' + id + '" aria-label="Less">−</button>' +
        '<input type="number" inputmode="numeric" min="1" value="' + l.qty + '" data-role="qty" data-id="' + id + '" aria-label="Quantity">' +
        '<button type="button" data-action="qty-inc" data-id="' + id + '" aria-label="More">+</button></div>' +
        priceCell + '<div class="cl-total" data-total-for="' + id + '">' + money(l.qty * l.price) + '</div></div></div>';
    }).join('');
  }

  function cartTotalsHTML() {
    const total = cartSubtotal();
    let html = '<div class="kv-row"><span>Items</span><b>' + cartCount() + '</b></div>';
    if (isOwner()) {
      const cost = state.cart.reduce((a, l) => {
        const p = state.partsById.get(l.partId);
        return a + l.qty * (p ? p.costPrice : 0);
      }, 0);
      html += '<div class="kv-row"><span>Cost</span><span>' + money(cost) + '</span></div>' +
        '<div class="kv-row"><span>Profit</span><b class="' + (total - cost >= 0 ? 'pos' : 'neg') + '">' + money(total - cost) + '</b></div>';
    }
    return html + '<div class="kv-row grand"><span>Total</span><b>' + money(total) + '</b></div>';
  }

  function refreshCartTotals() {
    const el = $('#cart-totals');
    if (el) el.innerHTML = cartTotalsHTML();
    $$('[data-total-for]').forEach(t => {
      const l = state.cart.find(x => x.partId === t.dataset.totalFor);
      if (l) t.textContent = money(l.qty * l.price);
    });
    updateCartBar();
  }

  function openCartSheet() {
    if (!state.cart.length) return;
    openSheet({
      title: 'Cart',
      body: '<div id="cart-lines">' + cartLinesHTML() + '</div>' +
        '<div class="field" style="margin-top:12px"><label for="cart-customer">Customer (optional)</label>' +
        '<input id="cart-customer" type="text" maxlength="60" autocomplete="off"></div>' +
        '<div class="field"><label for="cart-pay">Payment method</label><select id="cart-pay">' +
        '<option>Cash</option><option>Transfer</option><option>POS</option><option>Credit</option></select></div>' +
        '<div class="totals" id="cart-totals">' + cartTotalsHTML() + '</div>',
      foot: '<button type="button" class="btn ghost" data-action="cart-clear">Clear</button>' +
        '<button type="button" class="btn primary grow" id="btn-checkout" data-action="checkout">Complete sale</button>'
    });
  }

  function redrawCartLines() {
    if (!state.cart.length) { closeSheet(); updateCartBar(); return; }
    const box = $('#cart-lines');
    if (box) box.innerHTML = cartLinesHTML();
    refreshCartTotals();
  }

  function setQty(id, qty) {
    const line = state.cart.find(l => l.partId === id);
    if (!line) return;
    const stock = DB.getStock(id);
    if (qty > stock) { toast('Only ' + stock + ' in stock', 'warn'); qty = stock; }
    if (qty < 1) qty = 1;
    line.qty = qty;
    redrawCartLines();
  }

  async function completeSale() {
    if (state.busy || !state.cart.length) return;
    const btn = $('#btn-checkout');
    state.busy = true;
    if (btn) btn.disabled = true;
    try {
      for (const l of state.cart) {
        const p = state.partsById.get(l.partId);
        if (!Number.isInteger(l.qty) || l.qty < 1) throw new Error('Check the quantities.');
        if (!(l.price >= 0)) throw new Error('Check the prices.');
        if (l.qty > DB.getStock(l.partId)) throw new Error('Not enough stock for ' + (p ? p.name : 'a part') + '.');
      }
      // Cost comes straight from storage, so a Staff sale still records its true profit
      // without cost ever being shown on a Staff screen.
      const raws = await Promise.all(state.cart.map(l => DB.getPart(l.partId)));
      const items = state.cart.map((l, i) => {
        const r = raws[i];
        if (!r) throw new Error('A part in the cart no longer exists.');
        return { partId: l.partId, sku: r.sku, partNumber: r.partNumber, name: r.name, brand: r.brand, qty: l.qty, price: l.price, cost: r.costPrice };
      });
      const subtotal = items.reduce((a, it) => a + it.qty * it.price, 0);
      const cost = items.reduce((a, it) => a + it.qty * it.cost, 0);
      const sale = {
        id: DB.uuid(), receiptNo: '', ts: DB.nowISO(), items, subtotal, total: subtotal, cost,
        profit: subtotal - cost,
        payment: ($('#cart-pay') || {}).value || 'Cash',
        customer: (($('#cart-customer') || {}).value || '').trim().slice(0, 60),
        role: state.role, device: DB.getDeviceId()
      };
      const ledger = items.map(it => ({ partId: it.partId, type: 'SALE', qty: -it.qty, unitPrice: it.price, unitCost: it.cost }));
      await DB.recordSale(sale, ledger);          // one atomic write: sale + ledger rows + upload queue
      state.cart = [];
      updateCartBar();
      showReceipt(sale, true);
      renderSell();
      Sync.kick();
    } catch (err) {
      console.error(err);
      toast(friendlyError(err), 'error');
    } finally {
      state.busy = false;
      const b = $('#btn-checkout');
      if (b) b.disabled = false;
    }
  }

  /* ---- Receipts ---- */
  function receiptHTML(sale, forPrint) {
    const s = state.settings;
    const items = sale.items.map(it =>
      '<div class="r-item"><div class="r-line"><span>' + esc(it.name) + '</span><b>' + money(it.qty * it.price) + '</b></div>' +
      '<small>' + it.qty + ' × ' + money(it.price) + ' · SKU ' + esc(it.sku) + '</small></div>').join('');
    const ownerNote = (!forPrint && isOwner())
      ? '<div class="owner-note"><div class="r-line"><span>Cost</span><span>' + money(sale.cost) + '</span></div>' +
        '<div class="r-line"><span>Profit</span><b class="' + (sale.profit >= 0 ? 'pos' : 'neg') + '">' + money(sale.profit) + '</b></div></div>'
      : '';
    return '<div class="r-head"><div class="r-shop">' + esc(s.shopName) + '</div>' +
      (s.address ? '<div>' + esc(s.address) + '</div>' : '') + (s.phone ? '<div>Tel: ' + esc(s.phone) + '</div>' : '') + '</div>' +
      '<div class="r-line"><span>Receipt</span><b>' + esc(sale.receiptNo) + '</b></div>' +
      '<div class="r-line"><span>Date</span><span>' + esc(new Date(sale.ts).toLocaleString('en-NG')) + '</span></div>' +
      (sale.customer ? '<div class="r-line"><span>Customer</span><span>' + esc(sale.customer) + '</span></div>' : '') +
      '<div class="r-line"><span>Payment</span><span>' + esc(sale.payment) + '</span></div>' +
      '<div style="margin-top:8px">' + items + '</div>' +
      '<div class="r-line r-total"><span>TOTAL</span><span>' + money(sale.total) + '</span></div>' +
      ownerNote + '<div class="r-thanks">Thank you for your patronage!</div>';
  }

  function receiptText(sale) {
    const s = state.settings;
    const lines = ['*' + s.shopName + '*'];
    if (s.address) lines.push(s.address);
    if (s.phone) lines.push('Tel: ' + s.phone);
    lines.push('Receipt: ' + sale.receiptNo, new Date(sale.ts).toLocaleString('en-NG'), '------------------------');
    sale.items.forEach(it => lines.push(it.qty + ' x ' + it.name + ' @ ' + money(it.price) + ' = ' + money(it.qty * it.price)));
    lines.push('------------------------', 'TOTAL: ' + money(sale.total), 'Paid by: ' + sale.payment, 'Thank you!');
    return lines.join('\n');
  }

  function showReceipt(sale, justSold) {
    state.lastSale = sale;
    openSheet({
      title: justSold ? 'Sale complete ✓' : 'Receipt',
      body: '<div class="receipt">' + receiptHTML(sale, false) + '</div>',
      foot: '<button type="button" class="btn ghost" data-action="receipt-print">Print</button>' +
        '<button type="button" class="btn ghost" data-action="receipt-share">Share</button>' +
        '<button type="button" class="btn primary" data-action="sheet-close">Done</button>'
    });
  }

  function printReceipt() {
    if (!state.lastSale) return;
    $('#print-area').innerHTML = '<div class="receipt">' + receiptHTML(state.lastSale, true) + '</div>';
    window.print();
  }

  async function shareReceipt() {
    if (!state.lastSale) return;
    const text = receiptText(state.lastSale);
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }

  /* ===========================================================================
     7. STOCK TAB — list, part sheet, forms
     =========================================================================== */
  function renderStock() { runSearchFor('stock'); }

  async function openPartSheet(id) {
    const p = state.partsById.get(id);
    if (!p) return;
    const owner = isOwner();
    const st = stockInfo(p);
    const hist = await DB.ledgerForPart(id, 15);
    const histHTML = hist.length ? hist.map(r =>
      '<li><div>' + esc(TYPE_LABEL[r.type] || r.type) + '<small>' + esc(fmtDateTime(r.ts)) +
      (r.note ? ' · ' + esc(r.note) : '') +
      (owner && r.type === 'PURCHASE' && r.unitCost != null ? ' · cost ' + money(r.unitCost) : '') + '</small></div>' +
      '<div class="' + (r.qty > 0 ? 'qty-in' : 'qty-out') + '">' + (r.qty > 0 ? '+' : '−') + Math.abs(r.qty) + '</div></li>').join('')
      : '<li class="muted">No stock movements yet.</li>';
    const margin = owner && p.sellPrice > 0 ? Math.round(((p.sellPrice - p.costPrice) / p.sellPrice) * 100) : 0;
    const sid = esc(id);

    openSheet({
      title: p.name,
      body: '<div>' + brandBadge(p.brand) + ' <span class="muted">' + esc(p.category) + '</span></div>' +
        '<div class="stock-big ' + st.cls + '">' + st.n + ' <small>in stock' + (st.cls === 'low' ? ' · low' : '') + '</small></div>' +
        '<dl class="kv">' +
        '<div><dt>SKU</dt><dd>' + esc(p.sku) + '</dd></div>' +
        '<div><dt>Part number</dt><dd>' + (esc(p.partNumber) || '—') + '</dd></div>' +
        '<div><dt>Shelf</dt><dd>' + (esc(p.location) || '—') + '</dd></div>' +
        '<div><dt>Selling price</dt><dd>' + money(p.sellPrice) + '</dd></div>' +
        (owner ? '<div><dt>Cost price</dt><dd>' + money(p.costPrice) + '</dd></div><div><dt>Margin</dt><dd>' + margin + '%</dd></div>' : '') +
        '<div><dt>Reorder level</dt><dd>' + p.reorderLevel + '</dd></div></dl>' +
        '<h3>Recent movement</h3><ul class="hist">' + histHTML + '</ul>',
      foot: '<button type="button" class="btn primary" data-action="part-to-cart" data-id="' + sid + '"' + (st.n <= 0 ? ' disabled' : '') + '>Add to cart</button>' +
        (owner ? '<button type="button" class="btn ghost" data-action="part-receive" data-id="' + sid + '">Receive</button>' +
          '<button type="button" class="btn ghost" data-action="part-adjust" data-id="' + sid + '">Adjust</button>' +
          '<button type="button" class="btn ghost" data-action="part-edit" data-id="' + sid + '">Edit</button>' : '')
    });
  }

  function categoriesDatalist() {
    const cats = Array.from(new Set(state.parts.map(p => p.category).filter(Boolean))).sort(collator.compare);
    return '<datalist id="cat-list">' + cats.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist>';
  }

  function openPartForm(id) {
    if (!isOwner()) return;
    const p = id ? state.partsById.get(id) : null;
    const v = p || { name: '', sku: '', partNumber: '', brand: 'Volvo', category: '', location: '', costPrice: '', sellPrice: '', reorderLevel: 2 };
    const brandOpts = BRANDS.concat(['Other']).map(b => '<option' + (b === v.brand ? ' selected' : '') + '>' + b + '</option>').join('');
    openSheet({
      title: p ? 'Edit part' : 'New part',
      body: '<div class="field"><label for="pf-name">Part name *</label><input id="pf-name" type="text" maxlength="120" value="' + esc(v.name) + '"></div>' +
        '<div class="row2"><div class="field"><label for="pf-sku">SKU *</label><input id="pf-sku" type="text" maxlength="40" autocapitalize="characters" value="' + esc(v.sku) + '"></div>' +
        '<div class="field"><label for="pf-pn">Part number (OEM)</label><input id="pf-pn" type="text" maxlength="40" value="' + esc(v.partNumber) + '"></div></div>' +
        '<div class="row2"><div class="field"><label for="pf-brand">Truck brand</label><select id="pf-brand">' + brandOpts + '</select></div>' +
        '<div class="field"><label for="pf-cat">Category</label><input id="pf-cat" type="text" list="cat-list" maxlength="40" value="' + esc(v.category) + '"></div></div>' +
        categoriesDatalist() +
        '<div class="row2"><div class="field"><label for="pf-cost">Cost price (₦)</label><input id="pf-cost" type="number" inputmode="decimal" min="0" step="any" value="' + esc(v.costPrice) + '"></div>' +
        '<div class="field"><label for="pf-price">Selling price (₦)</label><input id="pf-price" type="number" inputmode="decimal" min="0" step="any" value="' + esc(v.sellPrice) + '"></div></div>' +
        '<div class="row2"><div class="field"><label for="pf-loc">Shelf / bin</label><input id="pf-loc" type="text" maxlength="30" value="' + esc(v.location) + '"></div>' +
        '<div class="field"><label for="pf-reorder">Reorder level</label><input id="pf-reorder" type="number" inputmode="numeric" min="0" value="' + esc(v.reorderLevel) + '"></div></div>' +
        (p ? '' : '<div class="field"><label for="pf-open">Opening stock (quantity on the shelf now)</label><input id="pf-open" type="number" inputmode="numeric" min="0" value="0"></div>'),
      foot: (p ? '<button type="button" class="btn ghost" data-action="part-archive" data-id="' + esc(id) + '">Archive</button>' : '') +
        '<button type="button" class="btn ghost" data-action="' + (p ? 'part-open' : 'sheet-close') + '" data-id="' + esc(id || '') + '">Cancel</button>' +
        '<button type="button" class="btn primary grow" data-action="part-save" data-id="' + esc(id || '') + '">Save part</button>'
    });
  }

  async function savePartForm(id) {
    if (!isOwner() || state.busy) return;
    const name = $('#pf-name').value.trim();
    const sku = $('#pf-sku').value.trim();
    if (!name) return toast('Enter the part name', 'warn');
    if (!sku) return toast('Enter a SKU', 'warn');
    if (state.parts.some(x => x.id !== id && x.sku.toLowerCase() === sku.toLowerCase())) {
      return toast('That SKU already exists', 'error');
    }
    const cost = parseNum($('#pf-cost').value);
    const price = parseNum($('#pf-price').value);
    if (cost < 0 || price < 0) return toast('Prices cannot be negative', 'error');

    state.busy = true;
    try {
      const existing = id ? await DB.getPart(id) : null;
      const part = Object.assign({}, existing || { id: DB.uuid() }, {
        name, sku, partNumber: $('#pf-pn').value.trim(), brand: $('#pf-brand').value,
        category: $('#pf-cat').value.trim(), location: $('#pf-loc').value.trim(),
        costPrice: cost, sellPrice: price,
        reorderLevel: Math.max(0, parseInt($('#pf-reorder').value, 10) || 0), active: true
      });
      const ledger = [];
      if (!existing) {
        const opening = Math.max(0, parseInt($('#pf-open').value, 10) || 0);
        if (opening > 0) ledger.push({ type: 'OPENING', qty: opening, unitCost: cost, note: 'Opening stock' });
      }
      await DB.savePartBatch([{ part, ledger }]);
      await loadParts();
      Sync.kick();
      toast(existing ? 'Part updated' : 'Part added', 'ok');
      renderCurrent();
      await openPartSheet(part.id);
    } finally {
      state.busy = false;
    }
  }

  async function archivePart(id) {
    if (!isOwner() || !window.confirm('Archive this part? It disappears from lists. Its stock history is kept.')) return;
    const raw = await DB.getPart(id);
    if (!raw) return;
    raw.active = false;
    await DB.savePartBatch([{ part: raw }]);
    await loadParts();
    Sync.kick();
    closeSheet();
    renderCurrent();
    toast('Part archived');
  }

  function openReceiveForm(id) {
    const p = state.partsById.get(id);
    if (!p || !isOwner()) return;
    openSheet({
      title: 'Receive stock',
      body: '<p class="hint"><b>' + esc(p.name) + '</b><br>Now in stock: ' + DB.getStock(id) + '</p>' +
        '<div class="row2"><div class="field"><label for="rc-qty">Quantity received</label><input id="rc-qty" type="number" inputmode="numeric" min="1" value=""></div>' +
        '<div class="field"><label for="rc-cost">Unit cost (₦)</label><input id="rc-cost" type="number" inputmode="decimal" min="0" step="any" value="' + esc(p.costPrice) + '"></div></div>' +
        '<div class="field"><label for="rc-note">Supplier / invoice note</label><input id="rc-note" type="text" maxlength="100"></div>' +
        '<p class="hint">The part\'s cost price becomes the weighted average of old and new stock.</p>',
      foot: '<button type="button" class="btn ghost" data-action="part-open" data-id="' + esc(id) + '">Cancel</button>' +
        '<button type="button" class="btn primary grow" data-action="receive-save" data-id="' + esc(id) + '">Add to stock</button>'
    });
  }

  async function saveReceive(id) {
    if (!isOwner() || state.busy) return;
    const qty = parseInt($('#rc-qty').value, 10);
    const unitCost = parseNum($('#rc-cost').value);
    if (!(qty >= 1)) return toast('Enter how many were received', 'warn');
    state.busy = true;
    try {
      const raw = await DB.getPart(id);
      const cur = DB.getStock(id);
      let newCost = unitCost;
      if (cur > 0) newCost = (cur * raw.costPrice + qty * unitCost) / (cur + qty);   // weighted average
      raw.costPrice = Math.round(newCost * 100) / 100;
      await DB.savePartBatch([{ part: raw, ledger: [{ type: 'PURCHASE', qty, unitCost, note: $('#rc-note').value.trim() }] }]);
      await loadParts();
      Sync.kick();
      toast('Added ' + qty + ' to stock', 'ok');
      renderCurrent();
      await openPartSheet(id);
    } finally {
      state.busy = false;
    }
  }

  const ADJUST_MODES = {
    count: { label: 'Counted quantity on the shelf', hint: 'Type the number you physically counted. Stock is corrected to match.' },
    return: { label: 'Quantity returned by customer', hint: 'Adds the returned parts back to stock.' },
    damaged: { label: 'Quantity damaged / expired', hint: 'Removes these parts from stock.' },
    lost: { label: 'Quantity lost / stolen', hint: 'Removes these parts from stock.' }
  };

  function openAdjustForm(id) {
    const p = state.partsById.get(id);
    if (!p || !isOwner()) return;
    openSheet({
      title: 'Adjust stock',
      body: '<p class="hint"><b>' + esc(p.name) + '</b><br>System stock now: <b>' + DB.getStock(id) + '</b></p>' +
        '<div class="field"><label for="adj-mode">What happened?</label><select id="adj-mode">' +
        '<option value="count">Stocktake — set counted quantity</option><option value="return">Customer return (+)</option>' +
        '<option value="damaged">Damaged / expired (−)</option><option value="lost">Lost / stolen (−)</option></select></div>' +
        '<div class="field"><label for="adj-qty" id="adj-qty-label">' + ADJUST_MODES.count.label + '</label><input id="adj-qty" type="number" inputmode="numeric" min="0"></div>' +
        '<p class="hint" id="adj-hint">' + ADJUST_MODES.count.hint + '</p>' +
        '<div class="field"><label for="adj-note">Note (optional)</label><input id="adj-note" type="text" maxlength="100"></div>' +
        '<p class="hint">Corrections are added as new ledger lines — old history is never changed.</p>',
      foot: '<button type="button" class="btn ghost" data-action="part-open" data-id="' + esc(id) + '">Cancel</button>' +
        '<button type="button" class="btn primary grow" data-action="adjust-save" data-id="' + esc(id) + '">Save adjustment</button>'
    });
  }

  async function saveAdjust(id) {
    if (!isOwner() || state.busy) return;
    const mode = $('#adj-mode').value;
    const q = parseInt($('#adj-qty').value, 10);
    const note = $('#adj-note').value.trim();
    const cur = DB.getStock(id);
    let spec;
    if (mode === 'count') {
      if (!(q >= 0)) return toast('Enter the counted quantity', 'warn');
      const delta = q - cur;
      if (delta === 0) return toast('The count matches — nothing to change');
      spec = { type: 'ADJUST', qty: delta, note: 'Stocktake: counted ' + q + (note ? ' · ' + note : '') };
    } else if (mode === 'return') {
      if (!(q >= 1)) return toast('Enter the quantity', 'warn');
      spec = { type: 'RETURN', qty: q, note: note || 'Customer return' };
    } else {
      if (!(q >= 1)) return toast('Enter the quantity', 'warn');
      if (q > cur) return toast('Only ' + cur + ' in stock', 'error');
      spec = { type: 'ADJUST', qty: -q, note: (mode === 'damaged' ? 'Damaged / expired' : 'Lost / stolen') + (note ? ' · ' + note : '') };
    }
    state.busy = true;
    try {
      await DB.appendLedger([Object.assign({ partId: id }, spec)]);
      Sync.kick();
      toast('Stock updated', 'ok');
      renderCurrent();
      await openPartSheet(id);
    } finally {
      state.busy = false;
    }
  }

  /* ===========================================================================
     8. SALES TAB
     =========================================================================== */
  async function renderSales() {
    const owner = isOwner();
    const range = owner ? state.salesRange : 'today';
    $$('#sales-range .chip-btn').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    const { from, to } = rangeBounds(range);
    const sales = await DB.getSalesBetween(from, to);
    if (state.tab !== 'sales') return;

    const total = sales.reduce((a, s) => a + s.total, 0);
    const profit = sales.reduce((a, s) => a + s.profit, 0);
    $('#sales-summary').innerHTML = owner
      ? '<span><b>' + sales.length + '</b> sales</span><span>Revenue <b>' + money(total) + '</b></span><span>Profit <b class="pos">' + money(profit) + '</b></span>'
      : '<span><b>' + sales.length + '</b> receipt' + (sales.length === 1 ? '' : 's') + ' today</span>';

    if (!sales.length) { $('#sales-list').innerHTML = '<div class="empty">No sales in this period.</div>'; return; }
    $('#sales-list').innerHTML = sales.slice(0, 200).map(s => {
      const units = s.items.reduce((a, it) => a + it.qty, 0);
      const first = s.items[0] ? s.items[0].name : '';
      return '<button type="button" class="sale" data-action="open-sale" data-id="' + esc(s.id) + '">' +
        '<div><div class="sale-no">' + esc(s.receiptNo) + '</div>' +
        '<div class="sale-sub">' + esc(fmtDateTime(s.ts)) + ' · ' + esc(s.payment) + ' · ' + units + ' item' + (units === 1 ? '' : 's') + '</div>' +
        '<div class="sale-sub">' + esc(first) + (s.items.length > 1 ? ' +' + (s.items.length - 1) + ' more' : '') + '</div></div>' +
        '<div><div class="sale-total">' + money(s.total) + '</div>' + (owner ? '<div class="sale-profit">+' + money(s.profit) + '</div>' : '') + '</div></button>';
    }).join('') + (sales.length > 200 ? '<div class="result-info">Showing the latest 200 of ' + sales.length + '.</div>' : '');
  }

  /* ===========================================================================
     9. OWNER DASHBOARD
     =========================================================================== */
  function aggregate(sales) {
    const a = { count: sales.length, revenue: 0, cost: 0, profit: 0, units: 0, byPay: new Map(), byBrand: new Map(), top: new Map() };
    sales.forEach(s => {
      a.revenue += s.total; a.cost += s.cost; a.profit += s.profit;
      const pay = s.payment || 'Other';
      a.byPay.set(pay, (a.byPay.get(pay) || 0) + s.total);
      s.items.forEach(it => {
        a.units += it.qty;
        a.byBrand.set(it.brand, (a.byBrand.get(it.brand) || 0) + it.qty * it.price);
        const t = a.top.get(it.partId) || { name: it.name, sku: it.sku, qty: 0, revenue: 0 };
        t.qty += it.qty; t.revenue += it.qty * it.price;
        a.top.set(it.partId, t);
      });
    });
    return a;
  }

  function hbarRows(map, total) {
    const rows = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class="muted">No data yet.</div>';
    return rows.map(([name, val]) =>
      '<div style="margin:8px 0"><div class="kv-row" style="border:0;padding:0"><span style="color:var(--ink)">' + esc(name) + '</span><b>' + money(val) + '</b></div>' +
      '<div class="hbar"><i style="width:' + (total ? Math.max(2, Math.round(val / total * 100)) : 0) + '%"></i></div></div>').join('');
  }

  async function renderDashboard() {
    if (!isOwner()) return;
    $$('#dash-range .chip-btn').forEach(b => b.classList.toggle('active', b.dataset.range === state.dashRange));
    const r = rangeBounds(state.dashRange);
    const w = rangeBounds('7d');
    const [sales, week] = await Promise.all([DB.getSalesBetween(r.from, r.to), DB.getSalesBetween(w.from, w.to)]);
    if (state.tab !== 'dashboard') return;
    const a = aggregate(sales);

    // last 7 days bars
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = startOfDay(new Date());
      d.setDate(d.getDate() - i);
      days.push({ key: dayKey(d.toISOString()), label: d.toLocaleDateString('en-NG', { weekday: 'short' }), rev: 0 });
    }
    week.forEach(s => { const d = days.find(x => x.key === dayKey(s.ts)); if (d) d.rev += s.total; });
    const max = Math.max(1, ...days.map(d => d.rev));

    // inventory value
    let invCost = 0, invRetail = 0, low = [], out = 0;
    state.parts.forEach(p => {
      const n = DB.getStock(p.id);
      if (n > 0) { invCost += n * p.costPrice; invRetail += n * p.sellPrice; }
      if (n <= 0) out++; else if (n <= p.reorderLevel) low.push({ p, n });
    });
    low.sort((x, y) => (x.n - x.p.reorderLevel) - (y.n - y.p.reorderLevel));
    const top = Array.from(a.top.values()).sort((x, y) => y.qty - x.qty).slice(0, 5);
    const margin = a.revenue ? Math.round(a.profit / a.revenue * 100) : 0;

    $('#dash-body').innerHTML =
      '<div class="kpis">' +
      '<div class="kpi"><span>Revenue</span><b>' + money(a.revenue) + '</b></div>' +
      '<div class="kpi"><span>Cost of goods</span><b>' + money(a.cost) + '</b></div>' +
      '<div class="kpi accent"><span>Net profit</span><b>' + money(a.profit) + '</b><small>' + margin + '% margin</small></div>' +
      '<div class="kpi"><span>Sales</span><b>' + a.count + '</b><small>' + a.units + ' units sold</small></div></div>' +

      '<div class="card"><h3>Revenue — last 7 days</h3><div class="bars">' + days.map(d =>
        '<div class="bar-col"><span class="bar-val">' + (d.rev ? compact(d.rev) : '') + '</span><div class="bar" style="height:' + Math.round(d.rev / max * 100) + '%"></div><span class="bar-lab">' + esc(d.label) + '</span></div>').join('') + '</div></div>' +

      '<div class="card"><h3>Stock value</h3>' +
      '<div class="kv-row"><span>At cost</span><b>' + money(invCost) + '</b></div>' +
      '<div class="kv-row"><span>At selling price</span><b>' + money(invRetail) + '</b></div>' +
      '<div class="kv-row"><span>Potential gross profit</span><b class="pos">' + money(invRetail - invCost) + '</b></div>' +
      '<div class="kv-row"><span>Low-stock parts</span><b class="' + (low.length ? 'neg' : '') + '">' + low.length + '</b></div>' +
      '<div class="kv-row"><span>Out of stock</span><b>' + out + '</b></div></div>' +

      '<div class="card"><h3>Top sellers</h3>' + (top.length ? top.map((t, i) =>
        '<div class="rank-row"><span class="rank-n">' + (i + 1) + '</span><div class="rank-main"><div>' + esc(t.name) + '</div><small>SKU ' + esc(t.sku) + '</small></div><div><b>' + t.qty + '</b> <small>sold</small></div></div>').join('') : '<div class="muted">No sales in this period.</div>') + '</div>' +

      '<div class="card"><h3>Needs restocking</h3>' + (low.length ? low.slice(0, 8).map(x =>
        '<button type="button" class="rank-row" data-action="open-part" data-id="' + esc(x.p.id) + '"><div class="rank-main"><div>' + esc(x.p.name) + '</div><small>' + esc(x.p.brand) + ' · SKU ' + esc(x.p.sku) + '</small></div><b class="neg">' + x.n + ' left</b></button>').join('') : '<div class="muted">Nothing is below its reorder level.</div>') + '</div>' +

      '<div class="card"><h3>Revenue by brand</h3>' + hbarRows(a.byBrand, a.revenue) + '</div>' +
      '<div class="card"><h3>Payment methods</h3>' + hbarRows(a.byPay, a.revenue) + '</div>';
  }

  /* ===========================================================================
     10. SETTINGS, CSV, SAMPLE DATA
     =========================================================================== */
  async function loadSettings() {
    const saved = await DB.getMeta('shop', null);
    if (saved) Object.assign(state.settings, saved);
    $('#shop-name').textContent = state.settings.shopName;
    $('#lock-shop').textContent = state.settings.shopName;
  }

  function renderSettings() {
    if (!isOwner()) return;
    const s = state.settings;
    $('#set-shop-name').value = s.shopName;
    $('#set-shop-address').value = s.address;
    $('#set-shop-phone').value = s.phone;
    $('#set-autolock').value = String(s.autoLockMin);
    const cfg = Sync.getConfig();
    $('#set-sb-url').value = cfg.url;
    $('#set-sb-key').value = cfg.key;
    updateSyncDetail();
    renderStorage();
    $('#about-detail').textContent = 'De Sunny Daf POS v' + APP_VERSION + ' · Device ' + DB.getDeviceId();
  }

  function updateSyncDetail() {
    const el = $('#sync-detail');
    if (!el) return;
    const st = state.syncStatus;
    el.textContent = 'Status: ' + st.message + '\nWaiting to upload: ' + st.pending +
      '\nLast sync: ' + (st.lastSync ? new Date(st.lastSync).toLocaleString('en-NG') : 'never');
  }

  function renderStorage() {
    const el = $('#storage-detail');
    if (!el) return;
    const p = state.persist;
    if (!p) { el.textContent = 'Checking…'; return; }
    const mb = v => (v / 1048576).toFixed(1) + ' MB';
    el.textContent = 'Protected from auto-clean: ' + (p.persisted ? 'YES ✓' : p.supported ? 'not yet' : 'not supported by this browser') +
      (p.usage != null ? '\nUsed: ' + mb(p.usage) + ' of ' + mb(p.quota) : '');
  }

  async function saveShop() {
    const s = state.settings;
    s.shopName = $('#set-shop-name').value.trim() || 'De Sunny Daf';
    s.address = $('#set-shop-address').value.trim();
    s.phone = $('#set-shop-phone').value.trim();
    s.autoLockMin = parseInt($('#set-autolock').value, 10) || 0;
    await DB.setMeta('shop', s);
    $('#shop-name').textContent = s.shopName;
    $('#lock-shop').textContent = s.shopName;
    resetIdleTimer();
    toast('Shop details saved', 'ok');
  }

  async function savePins() {
    const cur = $('#set-cur-owner').value;
    const ns = $('#set-new-staff').value;
    const no = $('#set-new-owner').value;
    if (roleForPin(cur) !== 'owner') return toast('Current Owner PIN is wrong', 'error');
    if (!ns && !no) return toast('Type a new PIN first', 'warn');
    if ((ns && !/^\d{4}$/.test(ns)) || (no && !/^\d{4}$/.test(no))) return toast('PINs must be exactly 4 digits', 'error');
    const next = Object.assign({}, pinStore);
    if (ns) next.staff = hashPin(ns, next.salt);
    if (no) next.owner = hashPin(no, next.salt);
    if (next.staff === next.owner) return toast('Staff and Owner PINs must be different', 'error');
    await DB.setMeta('pins', next);
    pinStore = next;
    ['set-cur-owner', 'set-new-staff', 'set-new-owner'].forEach(id => { $('#' + id).value = ''; });
    toast('PIN codes changed', 'ok');
  }

  async function saveSync() {
    await Sync.configure($('#set-sb-url').value, $('#set-sb-key').value);
    const res = await Sync.testConnection();
    toast(res.message, res.ok ? 'ok' : 'error');
  }

  /* ---- CSV import ---- */
  function normBrand(s) {
    const t = String(s || '').toLowerCase();
    const hit = BRANDS.find(b => t.indexOf(b.toLowerCase()) !== -1);
    return hit || (String(s || '').trim() || 'Other');
  }

  async function importCSV(file) {
    const btn = $('#btn-import');
    btn.disabled = true;
    try {
      const rows = parseCSV((await file.text()).replace(/^﻿/, ''));
      if (rows.length < 2) throw new Error('The file has no data rows.');
      const head = rows[0].map(h => h.trim().toLowerCase());
      const col = names => head.findIndex(h => names.indexOf(h) !== -1);
      const c = {
        sku: col(['sku', 'code', 'item code']),
        pn: col(['part number', 'partnumber', 'part no', 'part no.', 'pn', 'oem', 'oem number']),
        name: col(['name', 'description', 'part name', 'item']),
        brand: col(['brand', 'make', 'truck', 'truck brand']),
        cat: col(['category', 'group', 'type']),
        loc: col(['location', 'shelf', 'bin']),
        cost: col(['cost', 'cost price', 'buying price', 'buy price']),
        price: col(['price', 'sell price', 'selling price', 'sale price', 'retail']),
        qty: col(['qty', 'quantity', 'stock', 'on hand', 'opening stock']),
        reorder: col(['reorder', 'reorder level', 'min', 'min stock', 'minimum'])
      };
      if (c.name < 0) throw new Error('Could not find a "name" or "description" column in the first row.');

      const bySku = new Map();
      (await DB.getAllParts()).forEach(p => bySku.set(p.sku.toLowerCase(), p));
      const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
      const items = [];
      let seq = bySku.size;
      let skipped = 0;

      rows.slice(1).forEach(r => {
        const name = get(r, c.name);
        if (!name) { skipped++; return; }
        const pn = get(r, c.pn);
        const sku = get(r, c.sku) || pn || ('AUTO-' + String(++seq).padStart(5, '0'));
        const existing = bySku.get(sku.toLowerCase());
        const qtyText = get(r, c.qty);
        const part = Object.assign({}, existing || { id: DB.uuid() }, {
          sku, partNumber: pn || (existing ? existing.partNumber : ''), name,
          brand: c.brand >= 0 ? normBrand(get(r, c.brand)) : (existing ? existing.brand : 'Other'),
          category: c.cat >= 0 ? get(r, c.cat) : (existing ? existing.category : ''),
          location: c.loc >= 0 ? get(r, c.loc) : (existing ? existing.location : ''),
          costPrice: c.cost >= 0 ? parseNum(get(r, c.cost)) : (existing ? existing.costPrice : 0),
          sellPrice: c.price >= 0 ? parseNum(get(r, c.price)) : (existing ? existing.sellPrice : 0),
          reorderLevel: c.reorder >= 0 ? Math.max(0, Math.trunc(parseNum(get(r, c.reorder)))) : (existing ? existing.reorderLevel : 2),
          active: true
        });
        const ledger = [];
        if (qtyText !== '') {
          const qty = Math.max(0, Math.trunc(parseNum(qtyText)));
          if (existing) {
            const delta = qty - DB.getStock(existing.id);       // CSV acts as a stock-take
            if (delta !== 0) ledger.push({ type: 'ADJUST', qty: delta, note: 'CSV stock take' });
          } else if (qty > 0) {
            ledger.push({ type: 'OPENING', qty, unitCost: part.costPrice, note: 'CSV import' });
          }
        }
        bySku.set(sku.toLowerCase(), part);
        items.push({ part, ledger });
      });

      await DB.bulkImport(items, {
        queue: true,
        onProgress: (done, total) => { btn.textContent = 'Importing… ' + done + ' / ' + total; }
      });
      await loadParts();
      Sync.kick();
      toast('Imported ' + items.length + ' parts' + (skipped ? ' (' + skipped + ' rows skipped)' : ''), 'ok');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import parts from CSV';
      $('#csv-file').value = '';
    }
  }

  async function exportStock() {
    const raw = (await DB.getAllParts()).filter(p => p.active !== false);
    raw.sort((a, b) => collator.compare(a.name, b.name));
    const rows = [['sku', 'part number', 'name', 'brand', 'category', 'location', 'cost price', 'selling price', 'stock', 'reorder level']];
    raw.forEach(p => rows.push([p.sku, p.partNumber, p.name, p.brand, p.category, p.location, p.costPrice, p.sellPrice, DB.getStock(p.id), p.reorderLevel]));
    download('stock-' + dayKey(new Date().toISOString()) + '.csv', toCSV(rows));
    toast('Stock exported', 'ok');
  }

  async function exportSales() {
    const sales = (await DB.getAllSales()).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    const rows = [['receipt', 'date', 'items', 'total', 'cost', 'profit', 'payment', 'customer', 'sold by']];
    sales.forEach(s => rows.push([
      s.receiptNo, new Date(s.ts).toLocaleString('en-NG'),
      s.items.map(i => i.qty + 'x ' + i.name).join('; '), s.total, s.cost, s.profit, s.payment, s.customer, s.role
    ]));
    download('sales-' + dayKey(new Date().toISOString()) + '.csv', toCSV(rows));
    toast('Sales exported', 'ok');
  }

  /* ---- Sample data (made-up part numbers, for testing the search speed) ---- */
  const SAMPLE_CATS = [
    ['Brake Pad Set', 'BPD', 28000, 95000], ['Brake Disc', 'BDC', 45000, 160000], ['Brake Drum', 'BDR', 60000, 210000],
    ['Brake Chamber', 'BCH', 35000, 120000], ['Slack Adjuster', 'SLK', 22000, 70000], ['Air Dryer Cartridge', 'ADR', 30000, 110000],
    ['Oil Filter', 'OFL', 6000, 28000], ['Fuel Filter', 'FFL', 7000, 32000], ['Air Filter', 'AFL', 12000, 55000],
    ['Cabin Filter', 'CFL', 5000, 18000], ['Clutch Kit', 'CLK', 180000, 520000], ['Clutch Release Bearing', 'CRB', 25000, 90000],
    ['Turbocharger', 'TRB', 650000, 2400000], ['Water Pump', 'WPM', 55000, 220000], ['Fuel Injector', 'INJ', 90000, 380000],
    ['Alternator', 'ALT', 120000, 450000], ['Starter Motor', 'STR', 130000, 480000], ['Wheel Hub', 'WHB', 85000, 310000],
    ['Wheel Bearing Kit', 'WBK', 30000, 130000], ['Leaf Spring', 'LSP', 70000, 260000], ['Shock Absorber', 'SHK', 40000, 160000],
    ['Air Spring Bellows', 'ASB', 38000, 150000], ['Universal Joint', 'UJT', 20000, 85000], ['Propeller Shaft', 'PRS', 250000, 900000],
    ['Tie Rod End', 'TRE', 18000, 75000], ['King Pin Kit', 'KPK', 45000, 170000], ['Radiator', 'RAD', 210000, 780000],
    ['Thermostat', 'THM', 9000, 40000], ['Fan Belt', 'FBT', 6000, 30000], ['Headlamp Assembly', 'HLP', 55000, 230000],
    ['Wiper Blade', 'WPR', 3000, 14000], ['Cylinder Head Gasket', 'CHG', 25000, 110000], ['Piston Ring Set', 'PRG', 60000, 240000],
    ['Cylinder Liner', 'CLN', 22000, 90000], ['Oil Pump', 'OPM', 70000, 280000], ['EGR Valve', 'EGR', 95000, 360000],
    ['Wheel Stud and Nut Set', 'WNS', 4000, 22000], ['Gearbox Oil Cooler', 'GOC', 80000, 300000],
    ['Steering Pump', 'SPM', 100000, 400000], ['Compressor Repair Kit', 'CRK', 35000, 140000]
  ];
  const SAMPLE_MODELS = {
    Mack: ['Granite', 'Anthem', 'Pinnacle', 'Titan'], Volvo: ['FH', 'FM', 'FMX', 'FL'],
    Scania: ['R-Series', 'S-Series', 'P-Series', 'G-Series'], DAF: ['XF', 'CF', 'LF', 'XG']
  };
  const SAMPLE_POS = ['Front', 'Rear', 'Left', 'Right', 'Standard', 'Heavy-Duty'];

  async function loadSample() {
    if (!window.confirm('Add 3,000 made-up sample parts for testing? They stay on this phone only (not uploaded). You can erase them later from "Erase this phone\'s data".')) return;
    const btn = $('#btn-sample');
    btn.disabled = true;
    try {
      let seed = (Date.now() & 0xffffffff) >>> 0;
      const rng = () => {                         // small seeded random generator
        seed = (seed + 0x6D2B79F5) >>> 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = arr => arr[Math.floor(rng() * arr.length)];
      const digits = n => { let s = String(1 + Math.floor(rng() * 9)); while (s.length < n) s += Math.floor(rng() * 10); return s; };

      const start = (await DB.getAllParts()).length;
      const items = [];
      for (let i = 0; i < 3000; i++) {
        const brand = BRANDS[i % 4];
        const cat = pick(SAMPLE_CATS);
        const price = Math.round((cat[2] + rng() * (cat[3] - cat[2])) / 500) * 500;
        const qty = rng() < 0.12 ? 0 : Math.floor(rng() * 40);
        const cost = Math.round(price * (0.68 + rng() * 0.14) / 100) * 100;
        items.push({
          part: {
            name: cat[0] + ' – ' + brand + ' ' + pick(SAMPLE_MODELS[brand]) + ' · ' + pick(SAMPLE_POS),
            sku: brand.slice(0, 3).toUpperCase() + '-' + cat[1] + '-' + String(start + i + 1).padStart(5, '0'),
            partNumber: digits(brand === 'Volvo' || brand === 'Mack' ? 8 : 7),
            brand, category: cat[0], costPrice: cost, sellPrice: price,
            location: String.fromCharCode(65 + Math.floor(rng() * 12)) + (1 + Math.floor(rng() * 30)) + '-' + (1 + Math.floor(rng() * 6)),
            reorderLevel: 2 + Math.floor(rng() * 5)
          },
          ledger: qty > 0 ? [{ type: 'OPENING', qty, unitCost: cost, note: 'Sample data' }] : []
        });
      }
      await DB.bulkImport(items, {
        queue: false,                              // sample data is never uploaded
        onProgress: (done, total) => { btn.textContent = 'Creating… ' + done + ' / ' + total; }
      });
      await loadParts();
      toast('Added 3,000 sample parts', 'ok');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Load 3,000 sample parts (testing)';
    }
  }

  async function wipeEverything() {
    if ($('#wipe-confirm').value.trim() !== 'DELETE') return toast('Type DELETE in the box first', 'warn');
    await DB.wipeAll();
    location.reload();
  }

  async function protectStorage() {
    state.persist = await DB.requestPersistence();
    renderStorage();
    toast(state.persist.persisted ? 'Data is protected from auto-clean' : 'Not granted yet — adding the app to the home screen helps',
      state.persist.persisted ? 'ok' : 'warn');
  }

  /* ===========================================================================
     11. SYNC STATUS CHIP
     =========================================================================== */
  function renderSyncChip(st) {
    state.syncStatus = st;
    const chip = $('#sync-chip');
    if (!chip) return;
    chip.className = 'chip sync ' + st.state;
    const label = { local: 'Local', offline: 'Offline', syncing: 'Syncing', synced: 'Synced', error: 'Sync error' }[st.state] || 'Local';
    $('#sync-text').textContent = label + (st.pending ? ' · ' + st.pending : '');
    if (isOwner() && state.tab === 'settings') updateSyncDetail();
  }

  function onSyncChip() {
    const st = state.syncStatus;
    toast(st.message + (st.pending ? ' (' + st.pending + ' waiting)' : ''), st.state === 'error' ? 'error' : '');
  }

  /* ===========================================================================
     12. NAVIGATION, EVENTS AND START-UP
     =========================================================================== */
  function renderCurrent() {
    const fn = { sell: renderSell, stock: renderStock, sales: renderSales, dashboard: renderDashboard, settings: renderSettings }[state.tab];
    if (fn) { const r = fn(); if (r && r.catch) r.catch(err => console.error(err)); }
  }

  function showTab(tab) {
    if ((tab === 'dashboard' || tab === 'settings') && !isOwner()) tab = 'sell';
    state.tab = tab;
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
    $$('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    window.scrollTo(0, 0);
    renderCurrent();
    updateCartBar();
  }

  const actions = {
    'sheet-close': () => closeSheet(),
    brand: el => {
      const s = S[el.dataset.key];
      s.brand = el.dataset.brand;
      $$('[data-action="brand"]', $(s.chips)).forEach(b => b.classList.toggle('active', b === el));
      runSearchFor(el.dataset.key);
    },
    'low-toggle': el => {
      S.stock.low = !S.stock.low;
      el.classList.toggle('active', S.stock.low);
      runSearchFor('stock');
    },
    more: el => { S[el.dataset.key].shown += PAGE_SIZE; renderResults(el.dataset.key); },
    add: el => addToCart(el.dataset.id),
    'open-part': el => openPartSheet(el.dataset.id),
    'part-open': el => openPartSheet(el.dataset.id),
    'part-to-cart': el => { addToCart(el.dataset.id); },
    'part-new': () => openPartForm(null),
    'part-edit': el => openPartForm(el.dataset.id),
    'part-save': el => savePartForm(el.dataset.id || null),
    'part-archive': el => archivePart(el.dataset.id),
    'part-receive': el => openReceiveForm(el.dataset.id),
    'receive-save': el => saveReceive(el.dataset.id),
    'part-adjust': el => openAdjustForm(el.dataset.id),
    'adjust-save': el => saveAdjust(el.dataset.id),
    'cart-open': () => openCartSheet(),
    'cart-clear': () => { state.cart = []; closeSheet(); updateCartBar(); },
    'cart-remove': el => { state.cart = state.cart.filter(l => l.partId !== el.dataset.id); redrawCartLines(); },
    'qty-inc': el => { const l = state.cart.find(x => x.partId === el.dataset.id); if (l) setQty(l.partId, l.qty + 1); },
    'qty-dec': el => { const l = state.cart.find(x => x.partId === el.dataset.id); if (l) setQty(l.partId, l.qty - 1); },
    checkout: () => completeSale(),
    'receipt-print': () => printReceipt(),
    'receipt-share': () => shareReceipt(),
    'open-sale': async el => { const s = await DB.getSale(el.dataset.id); if (s) showReceipt(s, false); },
    'sales-range': el => { state.salesRange = el.dataset.range; renderSales(); },
    'dash-range': el => { state.dashRange = el.dataset.range; renderDashboard(); },
    'save-shop': () => saveShop(),
    'save-pins': () => savePins(),
    'save-sync': () => saveSync(),
    'sync-now': () => { Sync.syncNow(); toast('Syncing…'); },
    'import-csv': () => $('#csv-file').click(),
    'export-stock': () => exportStock(),
    'export-sales': () => exportSales(),
    'load-sample': () => loadSample(),
    'persist-storage': () => protectStorage(),
    wipe: () => wipeEverything()
  };

  function onClick(e) {
    const t = e.target;
    const tabBtn = t.closest('#bottom-nav [data-tab]');
    if (tabBtn) { showTab(tabBtn.dataset.tab); return; }
    const key = t.closest('#keypad [data-key]');
    if (key) { pinKey(key.dataset.key); return; }
    if (t.closest('#sheet-close') || t.id === 'sheet-backdrop') { closeSheet(); return; }
    if (t.closest('#btn-lock')) { lockApp(); return; }
    if (t.closest('#sync-chip')) { onSyncChip(); return; }
    const el = t.closest('[data-action]');
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    const result = fn(el, e);
    if (result && typeof result.catch === 'function') {
      result.catch(err => { console.error(err); toast(friendlyError(err), 'error'); });
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.id === 'sell-search' || t.id === 'stock-search') {
      const k = t.id === 'sell-search' ? 'sell' : 'stock';
      clearTimeout(S[k].timer);
      S[k].timer = setTimeout(() => runSearchFor(k), 90);        // debounce keystrokes
      return;
    }
    if (t.dataset && t.dataset.role === 'qty') {                  // typing a quantity in the cart
      const line = state.cart.find(l => l.partId === t.dataset.id);
      const q = parseInt(t.value, 10);
      if (line && q >= 1 && q <= DB.getStock(line.partId)) { line.qty = q; refreshCartTotals(); }
    } else if (t.dataset && t.dataset.role === 'price') {         // owner editing a unit price
      const line = state.cart.find(l => l.partId === t.dataset.id);
      const v = parseFloat(t.value);
      if (line && v >= 0) { line.price = v; refreshCartTotals(); }
    }
  }

  function onChange(e) {
    const t = e.target;
    if (t.id === 'csv-file' && t.files && t.files[0]) {
      importCSV(t.files[0]).catch(err => { console.error(err); toast(friendlyError(err), 'error'); });
      return;
    }
    if (t.id === 'adj-mode') {
      const m = ADJUST_MODES[t.value];
      $('#adj-qty-label').textContent = m.label;
      $('#adj-hint').textContent = m.hint;
      $('#adj-qty').min = t.value === 'count' ? '0' : '1';
      return;
    }
    if (t.dataset && (t.dataset.role === 'qty')) {                // finished typing: tidy invalid values
      const line = state.cart.find(l => l.partId === t.dataset.id);
      if (line) { const q = parseInt(t.value, 10); setQty(line.partId, q >= 1 ? q : 1); }
    } else if (t.dataset && t.dataset.role === 'price') {
      const line = state.cart.find(l => l.partId === t.dataset.id);
      if (line && !(parseFloat(t.value) >= 0)) { t.value = line.price; }
    }
  }

  const refreshAfterRemote = debounce(async () => {
    if (!state.role) return;
    await loadParts();
    renderCurrent();
  }, 400);

  function wireEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    window.addEventListener('popstate', () => closeSheet(true));

    // Physical keyboard on the lock screen (handy when testing on a computer).
    document.addEventListener('keydown', e => {
      if (!$('#lock-screen').hidden) {
        if (/^\d$/.test(e.key)) pinKey(e.key);
        else if (e.key === 'Backspace') pinKey('back');
        else if (e.key === 'Escape') pinKey('clear');
      } else if (e.key === 'Escape') closeSheet();
    });

    // Any touch or key press restarts the auto-lock timer.
    ['pointerdown', 'keydown', 'scroll'].forEach(ev =>
      document.addEventListener(ev, () => { if (state.role) resetIdleTimer(); }, { passive: true, capture: true }));

    DB.subscribe(evt => { if (evt.type === 'remote') refreshAfterRemote(); });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('Offline mode unavailable:', err));
    });
  }

  async function boot() {
    registerServiceWorker();
    wireEvents();
    captureOwnerNodes();
    applyRole(null);                         // nothing owner-only exists until the Owner PIN is used
    setLockMsg('Starting…');
    try {
      await DB.open();
      await DB.rebuildStock();               // add up the ledger once
      await loadSettings();
      await ensurePins();
      Sync.onStatus(renderSyncChip);
      await Sync.init();
      DB.requestPersistence().then(info => { state.persist = info; });
      state.ready = true;
      setLockMsg('Enter your PIN');
    } catch (err) {
      console.error(err);
      setLockMsg('Cannot start: ' + friendlyError(err), true);
    }
  }

  boot();
})();
