/* =============================================================================
   sw.js — Offline Service Worker
   -----------------------------------------------------------------------------
   • On first load it stores the whole app shell (HTML, CSS, JS) in the cache.
   • After that the app opens instantly and works with zero network.
   • "Stale-while-revalidate": the cached copy is shown immediately and a fresh
     copy is fetched quietly in the background, so edits you make in Termux
     appear on the NEXT open. Change VERSION below to force a clean refresh.
   • The Supabase CDN script is cached too. Calls to your Supabase project
     (api requests) are never touched by this worker — they use the sync queue.
   ============================================================================= */
'use strict';

const VERSION = 'v1';
const CACHE = 'truckparts-pos-' + VERSION;

// Everything needed to start the app with no network.
const APP_SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'js/db.js',
  'js/sync.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg'
];

// Third-party hosts whose scripts we keep a copy of.
const CACHEABLE_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cacheableCdn = CACHEABLE_HOSTS.includes(url.hostname);
  if (!sameOrigin && !cacheableCdn) return;   // e.g. *.supabase.co → leave alone

  event.respondWith(staleWhileRevalidate(event, req));
});

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });

  const refresh = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(refresh);   // keep the worker alive while the background update finishes
    return cached;
  }

  const fresh = await refresh;
  if (fresh) return fresh;

  // Offline and not cached: for page loads fall back to the app shell.
  if (req.mode === 'navigate') {
    const shell = (await cache.match('index.html')) || (await cache.match('./'));
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}
