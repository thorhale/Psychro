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

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

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
    show();
  });
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
