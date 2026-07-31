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
      // A new worker appearing while one is already controlling the page means
      // an update was published. Offer the reload instead of waiting for the
      // user's next cold start.
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready.', {
              kind: 'ok',
              duration: 15000,
              action: { label: 'Reload', onClick: () => location.reload() },
            });
          }
        });
      });
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
    window.navigator.standalone === true;
  if (isStandalone) return; // already running as the installed app

  function recentlyDismissed() {
    const t = +(storage.get(DISMISS_KEY) ?? 0);
    return t && Date.now() - t < DISMISS_DAYS * 86400000;
  }
  const banner = document.getElementById('install-banner');
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

  document.getElementById('install-dismiss').addEventListener('click', dismiss);

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  if (isIOS) {
    // No beforeinstallprompt on iOS — show the manual Share-sheet steps.
    document.getElementById('install-title').textContent = 'Add to Home Screen';
    document.getElementById('install-sub').textContent =
      'Tap Share ⬆ then "Add to Home Screen" — opens fullscreen, works offline';
    document.getElementById('install-go').style.display = 'none';
    show();
    return;
  }

  // Chromium path: capture the native prompt, fire it from OUR button (the
  // browser only allows .prompt() from a user gesture on the saved event).
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('install-title').textContent = 'Install this app';
    document.getElementById('install-sub').textContent =
      'Works offline · opens fullscreen like a native app';
    document.getElementById('install-go').style.display = '';
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
    const go = document.getElementById('install-go');
    if (isFirefox || isSafari) {
      // No install path in these browsers — lead with the file.
      document.getElementById('install-title').textContent = 'Keep this app';
      document.getElementById('install-sub').textContent =
        'Download it as one file — opens anywhere, works offline, no install needed';
      if (go) go.style.display = 'none';
    } else {
      document.getElementById('install-title').textContent = 'Install this app';
      document.getElementById('install-sub').textContent =
        'Use your browser menu ⋮ → "Install", or download it as a single file';
      if (go) go.style.display = 'none'; // no saved event; our button can't prompt
    }
    show();
  }, 3000);
  document.getElementById('install-go').addEventListener('click', async () => {
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
