// Stream Hall Environment Planner — offline cache.
// Stale-while-revalidate: after the first visit the app works with no network
// at all, and every ONLINE visit refreshes the cache in the background, so a
// returning visitor is at most one load behind the deployed code.
//
// Why not plain cache-first: the built artifact gets a fresh cache name every
// build (Vite stamps __BUILD_VERSION__ below), but GitHub Pages serves this
// repo RAW — no build runs, the placeholder survives verbatim, and the raw
// fallback name only changes when a human remembers to bump it. Under
// cache-first that forgotten bump means returning visitors run last month's
// physics forever, silently — the one failure an accuracy tool cannot have.
// Background revalidation makes freshness automatic instead of manual;
// RAW_VERSION is now just a cache namespace, bumped only when the caching
// strategy itself changes and old cache contents should be discarded.
const BUILD = '__BUILD_VERSION__';
const RAW_VERSION = 'raw-v6-stale-while-revalidate';
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
  // Stale-while-revalidate. A cache hit is served immediately — that is the
  // offline guarantee and the fast path — while the same request goes to the
  // network in the background and overwrites the cached copy, so the next load
  // runs the current deploy. On a miss the network response is the answer.
  //
  // The cache writes ride on `e.waitUntil`, never fire-and-forget: `respondWith`
  // settles as soon as a response is in hand and the browser may kill an idle
  // worker the moment its events do — an unawaited put can be dropped before it
  // lands. That is invisible when it happens (the page renders fine from the
  // network) and only fails LATER, offline, with a module the cache never
  // actually received. It failed exactly that way in CI once.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request).then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        }
        return res;
      });
      if (hit) {
        // Offline, the background refresh rejects — that must stay background:
        // swallow it so a rejected revalidation can never surface anywhere.
        e.waitUntil(refresh.then(() => undefined, () => undefined));
        return hit;
      }
      return refresh;
    }),
  );
});
