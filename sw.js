/* =====================================================================
   Service worker -- makes the app open instantly and work with no signal.

   Strategy:
     * app shell (html/css/js/icons) -> cache first, refreshed in the
       background. The counter opens in under a second even on 2G.
     * everything else (Supabase API, storage) -> network only. We never
       cache API responses; app.js owns all data caching in localStorage
       and serving a stale plate count from an HTTP cache would be wrong.
   Bump CACHE when you deploy so phones pick up the new version.
   ===================================================================== */
const CACHE = 'ganesh-utsav-v1';
const SHELL = [
  './', './index.html', './app.css', './app.js', './config.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))   // one missing file must not abort install
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // never cache the backend
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/rest/v1/') ||
      url.pathname.includes('/auth/v1/') ||
      url.pathname.includes('/storage/v1/')) return;

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit);              // offline: fall back to whatever we have
      return hit || net;                // cache first, network in the background
    })
  );
});
