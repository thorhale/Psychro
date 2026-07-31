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
const RAW_VERSION = 'raw-v5-warm-cache';
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

// Warm the cache with the module graph the page actually loaded.
//
// A service worker does not control the page that registers it, so on a first
// visit every module under src/ is fetched BEFORE the worker exists and never
// passes through the handler below. The precache list above names the shell and
// cannot name the modules — the raw deploy loads ~40 of them and the list would
// go stale on the next import anyone adds. The result was an app that reported
// itself installed and offline-ready after one visit while holding none of its
// own code; it only survived a reload because the browser's HTTP cache happened
// to cover for it. `src/app/pwa.js` sends the URLs the page really pulled, which
// stays correct however the module graph changes.
//
// Each URL is fetched independently rather than via `cache.addAll`, which is
// atomic: one failure there would discard every other module with it.
self.addEventListener('message', (e) => {
  const { type, urls } = e.data ?? {};
  if (type !== 'warm' || !Array.isArray(urls)) return;
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(
        urls.map((u) =>
          c.match(u).then(
            (hit) =>
              hit ||
              fetch(u)
                .then((r) => (r.ok ? c.put(u, r) : undefined))
                .catch(() => {
                  /* offline or 404 — the fetch handler will retry on next load */
                }),
          ),
        ),
      ),
    ),
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
            // waitUntil, not fire-and-forget. `respondWith` resolves as soon as
            // the response is in hand, and the browser is free to kill an idle
            // worker the moment its events settle — so an unawaited put can be
            // dropped before it lands. That is invisible when it happens: the
            // page renders fine from the network and only fails LATER, offline,
            // with a module the cache never actually received. The raw deploy
            // pulls ~40 separate modules, so this races on every cold load, and
            // it failed exactly that way in CI.
            e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
          }
          return res;
        }),
    ),
  );
});
