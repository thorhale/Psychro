/**
 * Platform adapters — the seam where the web app meets the host platform.
 *
 * The UI calls only these functions and never imports a Capacitor package
 * directly. Native plugins are loaded through dynamic `import()` behind a
 * runtime bridge check, which is what keeps the web bundle unchanged: with no
 * bridge present those branches are never taken, and `dist/index.html` is
 * byte-identical whether or not the native projects are installed (asserted by
 * `scripts/verify-build-parity.mjs` in CI).
 *
 *   storage   → @capacitor/preferences   (survives iOS WebView storage eviction)
 *   share     → @capacitor/share
 *   saveFile  → @capacitor/filesystem
 *   haptics   → @capacitor/haptics
 */

import { logError } from '../lib/errors.js';

// ── Bridge detection ────────────────────────────────────────────────────────

/** True when running inside a Capacitor native shell (not a browser). */
export function isNative() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}

/** 'ios' | 'android' | 'web' */
export function platformName() {
  return globalThis.Capacitor?.getPlatform?.() ?? 'web';
}

// ── Storage ─────────────────────────────────────────────────────────────────
//
// The whole UI reads storage synchronously (`storage.get` inside render paths),
// and Capacitor Preferences is async. Rather than make every call site async —
// a large, risky change for no user-visible benefit — this uses a write-through
// cache:
//
//   reads   always synchronous, from localStorage
//   writes  synchronous to localStorage, then mirrored to Preferences
//   boot    `hydrateFromNative()` restores localStorage from Preferences before
//           the app renders
//
// localStorage is the live copy; Preferences is the durable one. That matters on
// iOS, where the system can evict WebView storage from apps that go unused for
// a while — Preferences (UserDefaults) is not subject to that.

/** Keys this app owns. Only these are mirrored and restored. */
export const OWNED_KEYS = [
  'sdc_hep_v4',
  'sdc_hep_v3',
  'sdc_psychro_slaProfiles_v1',
  'sdc_psychro_scenarios_v1',
  'sdc_psychro_custom_sites_v1',
  'sdc_psychro_install_dismissed_v1',
];

/** Lazily-loaded Preferences plugin; null on web. */
let preferencesPlugin = null;

async function getPreferences() {
  if (!isNative()) return null;
  if (preferencesPlugin) return preferencesPlugin;
  try {
    const mod = await import('@capacitor/preferences');
    preferencesPlugin = mod.Preferences;
    return preferencesPlugin;
  } catch (err) {
    logError('platform.preferences.load', err);
    return null;
  }
}

/**
 * Restore localStorage from durable native storage, before the app reads it.
 *
 * Precedence: localStorage wins when both hold a value, because it is the live
 * copy the app has been writing to this session. Preferences only fills gaps —
 * which is exactly the eviction-recovery case.
 *
 * @returns {Promise<{restored: string[], platform: string}>}
 */
export async function hydrateFromNative() {
  const platform = platformName();
  const Preferences = await getPreferences();
  if (!Preferences) return { restored: [], platform };

  const restored = [];
  for (const key of OWNED_KEYS) {
    try {
      if (localStorage.getItem(key) != null) continue; // live copy wins
      const { value } = await Preferences.get({ key });
      if (value != null) {
        localStorage.setItem(key, value);
        restored.push(key);
      }
    } catch (err) {
      logError(`platform.hydrate(${key})`, err);
    }
  }
  return { restored, platform };
}

/**
 * Per-key serialisation of mirror writes.
 *
 * Mirrors are fire-and-forget so reads stay synchronous, but that means two
 * operations on the same key can be in flight at once — and if a `set` resolves
 * after a later `remove`, the durable copy resurrects a value the user deleted.
 * Chaining per key makes the durable copy converge to the last operation issued,
 * which is the only ordering that can be reasoned about.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const mirrorQueue = new Map();

/** Queue one durable-storage operation for `key`, after any already pending. */
function enqueueMirror(key, op) {
  if (!isNative() || !OWNED_KEYS.includes(key)) return;
  const prior = mirrorQueue.get(key) ?? Promise.resolve();
  const next = prior
    .catch(() => {}) // a failed earlier op must not block later ones
    .then(() => getPreferences())
    .then((Preferences) => (Preferences ? op(Preferences) : undefined))
    .catch((err) => logError(`platform.mirror(${key})`, err))
    .finally(() => {
      // Let the map drain once this key goes quiet.
      if (mirrorQueue.get(key) === next) mirrorQueue.delete(key);
    });
  mirrorQueue.set(key, next);
}

/** Mirror a write to durable storage. */
function mirrorToNative(key, value) {
  enqueueMirror(key, (Preferences) => Preferences.set({ key, value }));
}

/** Mirror a deletion to durable storage. */
function mirrorRemoveFromNative(key) {
  enqueueMirror(key, (Preferences) => Preferences.remove({ key }));
}

/**
 * Resolve once every queued durable write has completed.
 * Exposed for tests and for a future "flush before backgrounding" hook.
 */
export async function flushMirrors() {
  await Promise.allSettled([...mirrorQueue.values()]);
}

/**
 * Persistent key-value storage with explicit quota-failure reporting.
 *
 * v1 wrapped every localStorage write in `try {} catch {}` — a full disk (iOS
 * caps origin storage aggressively) silently stopped saving scenarios. Writes
 * now report success, and the caller decides how loudly to warn.
 */
export const storage = {
  /** @param {string} key @returns {string|null} */
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      logError('storage.get', err);
      return null;
    }
  },

  /**
   * @param {string} key @param {string} value
   * @returns {{ok: true} | {ok: false, quota: boolean}}
   */
  set(key, value) {
    try {
      localStorage.setItem(key, value);
      mirrorToNative(key, value);
      return { ok: true };
    } catch (err) {
      const quota =
        err instanceof DOMException &&
        (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      logError('storage.set', err);
      return { ok: false, quota };
    }
  },

  /** @param {string} key */
  remove(key) {
    try {
      localStorage.removeItem(key);
      mirrorRemoveFromNative(key);
    } catch (err) {
      logError('storage.remove', err);
    }
  },

  /** JSON convenience: parse or return `fallback` on any failure. */
  getJSON(key, fallback) {
    const raw = this.get(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      logError(`storage.getJSON(${key})`, err);
      return fallback;
    }
  },

  /** JSON convenience: stringify + set. Same result contract as `set`. */
  setJSON(key, value) {
    return this.set(key, JSON.stringify(value));
  },
};

// ── File save / share ───────────────────────────────────────────────────────

/** Web path: object URL + a synthetic anchor click. */
function downloadViaAnchor(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Offer a file to the user.
 *
 * On native there is no download folder to click into, so a "save" is really a
 * share: the file is written to the app's cache directory and handed to the OS
 * share sheet, which is where AirDrop / Files / Teams / email all live.
 *
 * @param {string} filename
 * @param {string|Blob} content
 * @param {string} [mime]
 */
export function saveFile(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  if (isNative() && typeof content === 'string') {
    shareFile(filename, content, filename, mime).catch((err) => logError('saveFile.native', err));
    return;
  }
  downloadViaAnchor(filename, blob);
}

/**
 * Share a file via the platform share sheet, falling back to a download.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|'failed'>}
 */
export async function shareFile(filename, content, title, mime = 'application/json') {
  if (isNative()) {
    try {
      const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ]);
      // Cache directory: the OS reclaims it, and the file only needs to live
      // long enough for the share sheet to copy it.
      const written = await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title, url: written.uri, dialogTitle: title });
      return 'shared';
    } catch (err) {
      if (err && /cancel/i.test(String(err.message ?? err))) return 'cancelled';
      logError('shareFile.native', err);
      return 'failed';
    }
  }

  const file = new File([content], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      logError('shareFile', err);
    }
  }
  downloadViaAnchor(filename, file);
  return 'downloaded';
}

// ── Haptics ─────────────────────────────────────────────────────────────────

/** Light tap feedback where the platform supports it. No-op on desktop. */
export function haptic() {
  if (isNative()) {
    import('@capacitor/haptics')
      .then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light }))
      .catch(() => {
        /* haptics are best-effort by definition */
      });
    return;
  }
  try {
    if (navigator.vibrate) navigator.vibrate(10);
  } catch {
    /* ditto */
  }
}

// ── Native shell integration ────────────────────────────────────────────────

/**
 * Wire up the bits of native behaviour that have no web equivalent: status-bar
 * styling, dismissing the splash screen once the app has actually rendered, and
 * an Android hardware-back handler that closes UI before it closes the app.
 *
 * @param {{onBack?: () => boolean}} [handlers] `onBack` returns true if it
 *   consumed the press (something was open to close), false to allow exit.
 */
export async function initNativeShell(handlers = {}) {
  if (!isNative()) return;

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // The app is dark-themed; light content keeps the clock legible.
    await StatusBar.setStyle({ style: Style.Dark });
    if (platformName() === 'android') {
      await StatusBar.setBackgroundColor({ color: '#0d1b2a' });
    }
  } catch (err) {
    logError('platform.statusBar', err);
  }

  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      // Close whatever is open first; only exit when nothing consumed it.
      if (handlers.onBack && handlers.onBack()) return;
      if (!canGoBack) App.exitApp();
      else window.history.back();
    });
  } catch (err) {
    logError('platform.backButton', err);
  }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch (err) {
    logError('platform.splash', err);
  }
}
