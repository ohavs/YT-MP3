/* Offline shell for YT-MP3.

   BUILD is the single thing to bump when shipping: it names the cache and
   tags the asset URLs, so a new release can never be served out of an old
   one. Every shell fetch bypasses the HTTP cache as well — without that, a
   fresh install would happily re-cache the previous build's files. */
const BUILD = '14';
const CACHE = `ytmp3-v${BUILD}`;

const SHELL = [
  './',
  './index.html',
  `./css/app.css?v=${BUILD}`,
  `./js/app.js?v=${BUILD}`,
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never touch the conversion backend or any cross-origin call.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  // Navigations (including share-target hits): network first, shell as fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
