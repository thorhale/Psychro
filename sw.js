// Stream Hall Environment Planner — offline cache.
// Cache-first: after the first visit, the app works with no network at all.
//
// The cache name is stamped with the build version at build time (see
// vite.config.js). Every published build therefore gets a fresh cache and the
// activate handler below deletes the old one — no manual version bumps, no
// stale installs. `__BUILD_VERSION__` survives verbatim in dev, which is fine:
// dev serves from Vite, not from this worker.
// Cache identity. Vite stamps __BUILD_VERSION__ at build time (vite.config.js)
// so built releases version themselves. GitHub Pages currently serves this
// repo RAW — no build runs, the placeholder survives verbatim, and without
// the fallback below every deploy would reuse one cache name and cache-first
// clients would never see an update. Bump RAW_VERSION on every push to main.
const BUILD = '__BUILD_VERSION__';
const RAW_VERSION = 'raw-v4-install-download';
const CACHE = 'sdc-psychro-' + (BUILD.charAt(0) === '_' ? RAW_VERSION : BUILD);
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
  if (e.request.method !== 'GET') return;
  // Cache-first, then network — and cache what the network returns. The
  // precache list above can't name every module under src/, so without the
  // runtime fill an installed app would load its shell offline and then fail
  // fetching the modules the shell imports.
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok && new URL(e.request.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
