/**
 * PWA plumbing: service-worker registration with update detection, and the
 * install-app banner.
 *
 * The service worker's cache name is derived from the build version (see
 * sw.js + vite.config.js), so shipping a new build automatically invalidates
 * the old cache — no more manual `sdc-psychro-vNN` bumps. When a new worker
 * installs while the app is open, a toast offers a one-tap reload.
 */

import { toast } from '../ui/notify.js';
import { storage } from '../platform/index.js';
import { inp } from '../ui/dom.js';

/**
 * Tell the active worker which same-origin URLs this page actually loaded, so
 * it can cache them.
 *
 * The worker cannot discover them itself: it does not control the page that
 * registers it, so a first visit's module fetches never reach its fetch
 * handler, and its precache list can only name the shell. Without this, an app
 * that says it is installed and offline-ready holds none of its own code until
 * the user happens to load it a second time while online.
 *
 * `performance.getEntriesByType('resource')` is the honest source: it is what
 * the browser really fetched, so it cannot drift from the module graph the way
 * a hand-maintained list does.
 */
function warmCache(worker) {
  if (!worker) return;
  const urls = [
    location.href,
    ...performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter((u) => u.startsWith(location.origin)),
  ];
  worker.postMessage({ type: 'warm', urls: [...new Set(urls)] });
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  // Warm only once the page has finished loading, so late resources (icons,
  // lazily-imported modules) are in the resource timeline before it is read.
  navigator.serviceWorker.ready.then((reg) => {
    const worker = reg.active;
    if (document.readyState === 'complete') warmCache(worker);
    else window.addEventListener('load', () => warmCache(worker), { once: true });
  });

  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // Announce at most once per page life. Without this an operator who
      // leaves the tab open all shift could collect a toast per update check.
      let told = false;
      const offerReload = () => {
        if (told) return;
        told = true;
        toast('A new version is ready.', {
          kind: 'ok',
          duration: 0, // stays until acted on: this is the fix for a stale app
          action: { label: 'Reload', onClick: () => location.reload() },
        });
      };

      // A worker can already be sitting in `waiting` by the time this runs —
      // the browser checks sw.js on navigation, and that check can finish
      // before our listener is attached. Only `updatefound` was handled, so
      // that race showed up as an app that stayed stale until a hard refresh.
      if (reg.waiting && navigator.serviceWorker.controller) offerReload();

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) offerReload();
        });
      });

      // Nothing ever asked whether a new version existed. Registration checks
      // once, at load, and that was it: a tab open across a deploy — which is
      // exactly how this app is used, left open on a hall — never found out.
      const checkForUpdate = () => {
        if (document.visibilityState !== 'visible') return;
        reg.update().catch(() => {
          /* offline, or the check failed; the next one will do */
        });
      };
      // Coming back to the tab is the moment worth checking: it is when
      // someone is about to act on what the app says.
      document.addEventListener('visibilitychange', checkForUpdate);
      window.addEventListener('focus', checkForUpdate);
      // And a slow heartbeat for a tab that is simply left open.
      setInterval(checkForUpdate, 30 * 60 * 1000);
    })
    .catch(() => {
      /* offline-first is a progressive enhancement — the app runs without it */
    });
}

/**
 * Install banner — surfaces the PWA install prompt instead of relying on the
 * browser's easy-to-miss address-bar icon. Chrome/Edge/Android fire
 * `beforeinstallprompt`; iOS Safari never does (no programmatic install API),
 * so it gets its own instructions. Dismissal is remembered for 30 days.
 */
export function initInstallBanner() {
  if (!location.protocol.startsWith('http')) return; // file:// dev preview
  const DISMISS_KEY = 'sdc_psychro_install_dismissed_v1';
  const DISMISS_DAYS = 30;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    /** @type {any} */ (window.navigator).standalone === true;
  if (isStandalone) return; // already running as the installed app

  function recentlyDismissed() {
    const t = +(storage.get(DISMISS_KEY) ?? 0);
    return t && Date.now() - t < DISMISS_DAYS * 86400000;
  }
  const banner = inp('install-banner');
  function show() {
    if (banner) banner.classList.add('show');
  }
  function hide() {
    if (banner) banner.classList.remove('show');
  }
  function dismiss() {
    storage.set(DISMISS_KEY, String(Date.now()));
    hide();
  }
  if (!banner || recentlyDismissed()) return;

  inp('install-dismiss').addEventListener('click', dismiss);

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/** @type {any} */ (window).MSStream;
  if (isIOS) {
    // No beforeinstallprompt on iOS — show the manual Share-sheet steps.
    inp('install-title').textContent = 'Add to Home Screen';
    inp('install-sub').textContent =
      'Tap Share ⬆ then "Add to Home Screen" — opens fullscreen, works offline';
    inp('install-go').style.display = 'none';
    show();
    return;
  }

  // Chromium path: capture the native prompt, fire it from OUR button (the
  // browser only allows .prompt() from a user gesture on the saved event).
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    inp('install-title').textContent = 'Install this app';
    inp('install-sub').textContent =
      'Works offline · opens fullscreen like a native app';
    inp('install-go').style.display = '';
    show();
  });

  // Fallback. `beforeinstallprompt` is not guaranteed: Firefox and desktop
  // Safari never fire it, and Chromium withholds it until its own engagement
  // heuristics are satisfied — so waiting for it alone means many visitors see
  // no install affordance at all and no way to get the file either. If nothing
  // has armed the prompt shortly after load, show the banner anyway with
  // instructions this browser can actually follow, keeping the download action
  // (which always works) alongside it.
  setTimeout(() => {
    if (deferredPrompt || !banner || recentlyDismissed()) return;
    const ua = navigator.userAgent;
    const isFirefox = /firefox/i.test(ua);
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    const go = inp('install-go');
    if (isFirefox || isSafari) {
      // No install path in these browsers — lead with the file.
      inp('install-title').textContent = 'Keep this app';
      inp('install-sub').textContent =
        'Download it as one file — opens anywhere, works offline, no install needed';
      if (go) go.style.display = 'none';
    } else {
      inp('install-title').textContent = 'Install this app';
      inp('install-sub').textContent =
        'Use your browser menu ⋮ → "Install", or download it as a single file';
      if (go) go.style.display = 'none'; // no saved event; our button can't prompt
    }
    show();
  }, 3000);
  inp('install-go').addEventListener('click', async () => {
    if (!deferredPrompt) {
      hide();
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    hide();
  });
  window.addEventListener('appinstalled', hide);
}
