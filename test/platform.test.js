/**
 * Platform adapters: the storage write-through cache and bridge detection.
 *
 * The behaviour that matters is the iOS eviction-recovery path — WebView storage
 * can be cleared out from under an app that has gone unused, and Preferences
 * (UserDefaults) is the durable copy that survives it. Getting the precedence
 * backwards would silently roll an operator's data back to an older state, so
 * it is pinned here rather than discovered in the field.
 *
 * The Capacitor bridge is mocked via `globalThis.Capacitor`, which is exactly
 * how the real bridge announces itself.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

/** In-memory localStorage good enough for the adapter's use of it. */
function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
    _map: map,
  };
}

/** Minimal Capacitor Preferences double backed by a Map. */
function fakePreferences(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    plugin: {
      get: vi.fn(async ({ key }) => ({ value: store.has(key) ? store.get(key) : null })),
      set: vi.fn(async ({ key, value }) => void store.set(key, value)),
      remove: vi.fn(async ({ key }) => void store.delete(key)),
    },
  };
}

let platform;

/**
 * Load the adapter fresh with a given environment. A fresh module instance is
 * required because the plugin handle is memoised at module scope.
 */
async function loadPlatform({ native = false, preferences = null } = {}) {
  vi.resetModules();
  globalThis.localStorage = fakeLocalStorage();
  if (native) {
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    };
    vi.doMock('@capacitor/preferences', () => ({ Preferences: preferences.plugin }));
  } else {
    delete globalThis.Capacitor;
  }
  platform = await import('../src/platform/index.js');
  return platform;
}

afterEach(() => {
  vi.doUnmock('@capacitor/preferences');
  delete globalThis.Capacitor;
  vi.resetModules();
});

describe('bridge detection', () => {
  it('reports web when no bridge is present', async () => {
    const p = await loadPlatform();
    expect(p.isNative()).toBe(false);
    expect(p.platformName()).toBe('web');
  });

  it('reports native when the bridge announces itself', async () => {
    const p = await loadPlatform({ native: true, preferences: fakePreferences() });
    expect(p.isNative()).toBe(true);
    expect(p.platformName()).toBe('ios');
  });

  it('treats a malformed bridge object as web rather than crashing', async () => {
    vi.resetModules();
    globalThis.localStorage = fakeLocalStorage();
    globalThis.Capacitor = {}; // present but with no methods
    const p = await import('../src/platform/index.js');
    expect(p.isNative()).toBe(false);
    expect(p.platformName()).toBe('web');
  });
});

describe('web storage path', () => {
  it('reads and writes synchronously with no native involvement', async () => {
    const p = await loadPlatform();
    expect(p.storage.set('sdc_hep_v4', '{"v":4}')).toEqual({ ok: true });
    expect(p.storage.get('sdc_hep_v4')).toBe('{"v":4}');
    p.storage.remove('sdc_hep_v4');
    expect(p.storage.get('sdc_hep_v4')).toBeNull();
  });

  it('round-trips JSON', async () => {
    const p = await loadPlatform();
    const value = { halls: [{ name: 'H1' }], n: 42 };
    p.storage.setJSON('sdc_hep_v4', value);
    expect(p.storage.getJSON('sdc_hep_v4', null)).toEqual(value);
  });

  it('returns the fallback for absent or corrupt JSON', async () => {
    const p = await loadPlatform();
    expect(p.storage.getJSON('missing', 'fallback')).toBe('fallback');
    globalThis.localStorage.setItem('sdc_hep_v4', '{"broken');
    expect(p.storage.getJSON('sdc_hep_v4', 'fallback')).toBe('fallback');
  });

  it('reports quota exhaustion distinctly from other failures', async () => {
    const p = await loadPlatform();
    const quotaErr = new DOMException('full', 'QuotaExceededError');
    globalThis.localStorage.setItem = () => {
      throw quotaErr;
    };
    expect(p.storage.set('sdc_hep_v4', 'x')).toEqual({ ok: false, quota: true });

    globalThis.localStorage.setItem = () => {
      throw new Error('something else');
    };
    expect(p.storage.set('sdc_hep_v4', 'x')).toEqual({ ok: false, quota: false });
  });

  it('hydration is a no-op on web', async () => {
    const p = await loadPlatform();
    expect(await p.hydrateFromNative()).toEqual({ restored: [], platform: 'web' });
  });

  it('initNativeShell does nothing on web', async () => {
    const p = await loadPlatform();
    await expect(p.initNativeShell({ onBack: () => true })).resolves.toBeUndefined();
  });
});

describe('native storage: write-through mirroring', () => {
  it('mirrors owned keys to durable storage on write', async () => {
    const prefs = fakePreferences();
    const p = await loadPlatform({ native: true, preferences: prefs });
    p.storage.set('sdc_hep_v4', '{"v":4}');
    // Reads stay synchronous and local…
    expect(p.storage.get('sdc_hep_v4')).toBe('{"v":4}');
    // …while the durable copy is written in the background.
    await p.flushMirrors();
    expect(prefs.store.get('sdc_hep_v4')).toBe('{"v":4}');
  });

  it('mirrors removals too, so a delete cannot resurrect on next launch', async () => {
    const prefs = fakePreferences({ sdc_hep_v4: '{"stale"}' });
    const p = await loadPlatform({ native: true, preferences: prefs });
    p.storage.set('sdc_hep_v4', '{"v":4}');
    p.storage.remove('sdc_hep_v4');
    await p.flushMirrors();
    expect(prefs.store.has('sdc_hep_v4')).toBe(false);
  });

  it('applies same-key mirrors in issue order, never last-to-resolve order', async () => {
    // Without per-key serialisation these are two independent promises: if the
    // set resolves after the remove, the durable copy resurrects deleted data.
    // Made deterministic here by stalling the set so it WOULD land last.
    const prefs = fakePreferences();
    let releaseSet;
    const setStalled = new Promise((r) => (releaseSet = r));
    prefs.plugin.set = vi.fn(async ({ key, value }) => {
      await setStalled;
      prefs.store.set(key, value);
    });
    const p = await loadPlatform({ native: true, preferences: prefs });

    p.storage.set('sdc_hep_v4', '{"v":4}');
    p.storage.remove('sdc_hep_v4');
    releaseSet();
    await p.flushMirrors();

    // The remove was issued last, so it must win.
    expect(prefs.store.has('sdc_hep_v4')).toBe(false);
  });

  it('a failed mirror does not block later ones for the same key', async () => {
    const prefs = fakePreferences();
    prefs.plugin.set = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient bridge failure'))
      .mockImplementation(async ({ key, value }) => void prefs.store.set(key, value));
    const p = await loadPlatform({ native: true, preferences: prefs });

    p.storage.set('sdc_hep_v4', '{"first":true}'); // rejects
    p.storage.set('sdc_hep_v4', '{"second":true}'); // must still be attempted
    await p.flushMirrors();
    expect(prefs.store.get('sdc_hep_v4')).toBe('{"second":true}');
  });

  it('does not mirror keys the app does not own', async () => {
    const prefs = fakePreferences();
    const p = await loadPlatform({ native: true, preferences: prefs });
    p.storage.set('some_other_apps_key', 'value');
    await p.flushMirrors();
    expect(prefs.store.has('some_other_apps_key')).toBe(false);
    expect(prefs.plugin.set).not.toHaveBeenCalled();
  });

  it('every owned key is a key the app actually uses', async () => {
    // Guards against the mirror list drifting away from the real storage keys —
    // a key missing here is a key that would NOT survive iOS eviction.
    const p = await loadPlatform();
    const { LS_KEY_V1, LS_KEY_V3, LS_KEY_V4 } = await import('../src/state/persistence.js');
    for (const k of [LS_KEY_V1, LS_KEY_V3, LS_KEY_V4]) {
      expect(p.OWNED_KEYS, `${k} must be mirrored`).toContain(k);
    }
    // Scenarios and custom sites are written by main.js under these names.
    expect(p.OWNED_KEYS).toContain('sdc_psychro_scenarios_v1');
    expect(p.OWNED_KEYS).toContain('sdc_psychro_custom_sites_v1');
  });
});

describe('native storage: eviction recovery', () => {
  it('restores durable values when WebView storage has been cleared', async () => {
    // The iOS eviction case: Preferences survived, localStorage did not.
    const prefs = fakePreferences({
      sdc_hep_v4: '{"v":4,"hallProfiles":[]}',
      sdc_psychro_scenarios_v1: '[{"name":"Saved"}]',
    });
    const p = await loadPlatform({ native: true, preferences: prefs });

    const { restored, platform: name } = await p.hydrateFromNative();
    expect(name).toBe('ios');
    expect(restored.sort()).toEqual(['sdc_hep_v4', 'sdc_psychro_scenarios_v1']);
    expect(p.storage.get('sdc_hep_v4')).toBe('{"v":4,"hallProfiles":[]}');
    expect(p.storage.get('sdc_psychro_scenarios_v1')).toBe('[{"name":"Saved"}]');
  });

  it('the live copy wins when both exist', async () => {
    // localStorage is what the app has been writing this session; Preferences is
    // a mirror that may lag. Restoring over the live copy would roll data back.
    const prefs = fakePreferences({ sdc_hep_v4: '{"stale":true}' });
    const p = await loadPlatform({ native: true, preferences: prefs });
    globalThis.localStorage.setItem('sdc_hep_v4', '{"live":true}');

    const { restored } = await p.hydrateFromNative();
    expect(restored).toEqual([]);
    expect(p.storage.get('sdc_hep_v4')).toBe('{"live":true}');
  });

  it('restores only the gaps when storage is partially populated', async () => {
    const prefs = fakePreferences({
      sdc_hep_v4: '{"durable":true}',
      sdc_psychro_scenarios_v1: '[{"name":"Durable"}]',
    });
    const p = await loadPlatform({ native: true, preferences: prefs });
    globalThis.localStorage.setItem('sdc_hep_v4', '{"live":true}');

    const { restored } = await p.hydrateFromNative();
    expect(restored).toEqual(['sdc_psychro_scenarios_v1']);
    expect(p.storage.get('sdc_hep_v4')).toBe('{"live":true}');
    expect(p.storage.get('sdc_psychro_scenarios_v1')).toBe('[{"name":"Durable"}]');
  });

  it('survives a plugin failure without blocking boot', async () => {
    // A broken bridge must degrade to "no restore", never to a hung startup.
    const prefs = fakePreferences();
    prefs.plugin.get = vi.fn(async () => {
      throw new Error('bridge unavailable');
    });
    const p = await loadPlatform({ native: true, preferences: prefs });
    const { restored } = await p.hydrateFromNative();
    expect(restored).toEqual([]);
  });

  it('hydration is idempotent', async () => {
    const prefs = fakePreferences({ sdc_hep_v4: '{"v":4}' });
    const p = await loadPlatform({ native: true, preferences: prefs });
    expect((await p.hydrateFromNative()).restored).toEqual(['sdc_hep_v4']);
    // Second pass finds the value already live and restores nothing.
    expect((await p.hydrateFromNative()).restored).toEqual([]);
  });
});
