/**
 * PWA plumbing: service-worker registration with update detection, and the
 * install-app banner.
 *
 * The service worker's cache name is derived from the build version (see
 * sw.js + vite.config.js), so shipping a new build automatically invalidates
 * the old cache — no more manual `sdc-psychro-vNN` bumps. When a new worker
 * installs while the app is open, a toast offers a one-tap reload.
 *
 * The logic itself lives in install-offer.js, shared with the home page; this
 * file only supplies the planner's toast, storage and DOM helper.
 */

import { toast } from '../ui/notify.js';
import { storage } from '../platform/index.js';
import { inp } from '../ui/dom.js';
import { registerWorker, offerInstall } from './install-offer.js';

/**
 * The planner's worker registration: the shared one (install-offer.js), with
 * a toast that offers a one-tap reload when a new version is waiting.
 */
export function registerServiceWorker() {
  registerWorker({
    onUpdateReady: () => toast('A new version is ready.', {
      kind: 'ok',
      duration: 0, // stays until acted on: this is the fix for a stale app
      action: { label: 'Reload', onClick: () => location.reload() },
    }),
  });
}

/**
 * The planner's install banner: the shared one (install-offer.js), reading
 * and writing the dismissal through the platform storage layer.
 */
export function initInstallBanner() {
  offerInstall({ byId: inp, store: storage });
}
