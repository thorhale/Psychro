// Stream Hall Environment Planner — offline cache.
// Cache-first: after the first visit, the app works with no network at all.
//
// The cache name is stamped with the build version at build time (see
// vite.config.js). Every published build therefore gets a fresh cache and the
// activate handler below deletes the old one — no manual version bumps, no
// stale installs. `__BUILD_VERSION__` survives verbatim in dev, which is fine:
// dev serves from Vite, not from this worker.
const CACHE = 'sdc-psychro-__BUILD_VERSION__';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
