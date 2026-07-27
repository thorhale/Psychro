/**
 * Platform adapters — the seam where the web app meets the host platform.
 *
 * The UI calls only these functions. Today they are backed by web APIs; when the
 * Capacitor shells land (round 2), each gains a native branch behind the same
 * signature and nothing above this file changes:
 *
 *   storage   → @capacitor/preferences   (survives iOS storage eviction)
 *   share     → @capacitor/share
 *   saveFile  → @capacitor/filesystem
 *   haptics   → @capacitor/haptics
 */

import { logError } from '../lib/errors.js';

// ── Storage ─────────────────────────────────────────────────────────────────

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

/**
 * Offer a file for download.
 * @param {string} filename
 * @param {string|Blob} content
 * @param {string} [mime]
 */
export function saveFile(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
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
 * Share a file via the platform share sheet where available, falling back to a
 * plain download. Returns 'shared' | 'downloaded' | 'cancelled'.
 * @param {string} filename @param {string} content @param {string} title
 */
export async function shareFile(filename, content, title, mime = 'application/json') {
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
  saveFile(filename, content, mime);
  return 'downloaded';
}

// ── Haptics ─────────────────────────────────────────────────────────────────

/** Light tap feedback where the platform supports it. No-op on desktop. */
export function haptic() {
  try {
    if (navigator.vibrate) navigator.vibrate(10);
  } catch {
    /* haptics are best-effort by definition */
  }
}
