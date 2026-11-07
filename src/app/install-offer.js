/**
 * Installing the app, and keeping it current — for any page.
 *
 * This lived in pwa.js, wired to the planner's toast, storage and DOM helper.
 * That meant only the planner offered to install, while the link people are
 * actually sent opens the home page, which offered nothing and did not even
 * register the service worker. Someone who installed from there got an app
 * that was not offline-ready until they happened to open the planner.
 *
 * Everything here takes what it needs as arguments, so the home page can use
 * it without pulling in the platform layer and its native-plugin loaders
 * (the same reason logo-kit.js takes a store). pwa.js wraps it for the
 * planner with exactly the behaviour it had before.
 */

/**
 * Is this page already running as the installed app?
 * @param {Window} win
 */
export function isStandalone(win = window) {
  return win.matchMedia('(display-mode: standalone)').matches
    || /** @type {any} */ (win.navigator).standalone === true;
}

/**
 * iPhone, iPod or iPad, which have no install API and need Share-sheet steps.
 *
 * iPadOS has reported a Mac user agent since iPadOS 13, so a user-agent test
 * alone sent every iPad down the desktop-Safari path ("download the file")
 * instead of telling it how to add the app to its home screen. A Mac with a
 * multi-touch screen is how an iPad gives itself away.
 *
 * @param {{userAgent:string, maxTouchPoints?:number}} nav
 */
export function isIOS(nav) {
  const ua = nav.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return /macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1;
}

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
function warmCache(worker, win) {
  if (!worker) return;
  const { location, performance } = win;
  const urls = [
    location.href,
    ...performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .filter((u) => u.startsWith(location.origin)),
  ];
  worker.postMessage({ type: 'warm', urls: [...new Set(urls)] });
}

/**
 * Register sw.js, warm its cache, and keep asking whether a new version
 * exists. `onUpdateReady` is called at most once per page life, when a new
 * worker is installed and waiting.
 *
 * @param {{onUpdateReady:() => void, win?: Window}} opts
 */
export function registerWorker({ onUpdateReady, win = window }) {
  const nav = win.navigator;
  if (!('serviceWorker' in nav) || !win.location.protocol.startsWith('http')) return;

  // Warm only once the page has finished loading, so late resources (icons,
  // lazily-imported modules) are in the resource timeline before it is read.
  nav.serviceWorker.ready.then((reg) => {
    const worker = reg.active;
    if (win.document.readyState === 'complete') warmCache(worker, win);
    else win.addEventListener('load', () => warmCache(worker, win), { once: true });
  });

  nav.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // Announce at most once per page life. Without this an operator who
      // leaves the tab open all shift could collect a notice per update check.
      let told = false;
      const offerReload = () => {
        if (told) return;
        told = true;
        onUpdateReady();
      };

      // A worker can already be sitting in `waiting` by the time this runs —
      // the browser checks sw.js on navigation, and that check can finish
      // before our listener is attached. Only `updatefound` was handled, so
      // that race showed up as an app that stayed stale until a hard refresh.
      if (reg.waiting && nav.serviceWorker.controller) offerReload();

      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && nav.serviceWorker.controller) offerReload();
        });
      });

      // Nothing ever asked whether a new version existed. Registration checks
      // once, at load, and that was it: a tab open across a deploy — which is
      // exactly how this app is used, left open on a hall — never found out.
      const checkForUpdate = () => {
        if (win.document.visibilityState !== 'visible') return;
        reg.update().catch(() => {
          /* offline, or the check failed; the next one will do */
        });
      };
      // Coming back to the tab is the moment worth checking: it is when
      // someone is about to act on what the app says.
      win.document.addEventListener('visibilitychange', checkForUpdate);
      win.addEventListener('focus', checkForUpdate);
      // And a slow heartbeat for a tab that is simply left open.
      win.setInterval(checkForUpdate, 30 * 60 * 1000);
    })
    .catch(() => {
      /* offline-first is a progressive enhancement — the app runs without it */
    });
}

export const DISMISS_KEY = 'sdc_psychro_install_dismissed_v1';
const DISMISS_DAYS = 30;

/**
 * The install banner: surfaces the install prompt instead of relying on the
 * browser's easy-to-miss address-bar icon. Chrome/Edge/Android fire
 * `beforeinstallprompt`; iOS Safari never does (no programmatic install API),
 * so it gets its own instructions. Dismissal is remembered for 30 days, and
 * is shared by every page that shows the banner.
 *
 * Expects these elements: install-banner, install-title, install-sub,
 * install-go, install-dismiss (install-download is optional).
 *
 * @param {{byId:(id:string) => any, store:{get:(k:string)=>string|null, set:(k:string, v:string)=>unknown},
 *          win?: Window, fallbackMs?: number}} opts
 */
export function offerInstall({ byId, store, win = window, fallbackMs = 3000 }) {
  if (!win.location.protocol.startsWith('http')) return; // file:// copy: nothing to install
  if (isStandalone(win)) return; // already running as the installed app

  const recentlyDismissed = () => {
    const t = +(store.get(DISMISS_KEY) ?? 0);
    return t && Date.now() - t < DISMISS_DAYS * 86400000;
  };
  const banner = byId('install-banner');
  const show = () => { if (banner) banner.classList.add('show'); };
  const hide = () => { if (banner) banner.classList.remove('show'); };
  const dismiss = () => {
    store.set(DISMISS_KEY, String(Date.now()));
    hide();
  };
  if (!banner || recentlyDismissed()) return;

  byId('install-dismiss').addEventListener('click', dismiss);

  if (isIOS(win.navigator)) {
    // No beforeinstallprompt on iOS — show the manual Share-sheet steps.
    byId('install-title').textContent = 'Add to Home Screen';
    byId('install-sub').textContent =
      'Tap Share ⬆ then "Add to Home Screen" — opens fullscreen, works offline';
    byId('install-go').style.display = 'none';
    show();
    return;
  }

  // Chromium path: capture the native prompt, fire it from OUR button (the
  // browser only allows .prompt() from a user gesture on the saved event).
  let deferredPrompt = null;
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    byId('install-title').textContent = 'Install this app';
    byId('install-sub').textContent = 'Works offline · opens fullscreen like a native app';
    byId('install-go').style.display = '';
    show();
  });

  // Fallback. `beforeinstallprompt` is not guaranteed: Firefox and desktop
  // Safari never fire it, and Chromium withholds it until its own engagement
  // heuristics are satisfied — so waiting for it alone means many visitors see
  // no install affordance at all and no way to get the file either. If nothing
  // has armed the prompt shortly after load, show the banner anyway with
  // instructions this browser can actually follow, keeping the download action
  // (which always works) alongside it.
  win.setTimeout(() => {
    if (deferredPrompt || recentlyDismissed()) return;
    const ua = win.navigator.userAgent;
    const isFirefox = /firefox/i.test(ua);
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    const go = byId('install-go');
    if (isFirefox || isSafari) {
      // No install path in these browsers — lead with the file.
      byId('install-title').textContent = 'Keep this app';
      byId('install-sub').textContent =
        'Download it as one file — opens anywhere, works offline, no install needed';
    } else {
      byId('install-title').textContent = 'Install this app';
      byId('install-sub').textContent =
        'Use your browser menu ⋮ → "Install", or download it as a single file';
    }
    if (go) go.style.display = 'none'; // no saved event: our button cannot prompt
    show();
  }, fallbackMs);

  byId('install-go').addEventListener('click', async () => {
    if (!deferredPrompt) { hide(); return; }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    hide();
  });
  win.addEventListener('appinstalled', hide);
}
