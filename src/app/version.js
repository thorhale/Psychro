/**
 * Build identity. `__APP_VERSION__` and `__BUILD_SHA__` are injected by Vite
 * (`define` in vite.config.js) from package.json and git at build time. The
 * fallbacks keep the module working under Vitest and any non-Vite tooling.
 */

/* global __APP_VERSION__, __BUILD_SHA__ */

export const APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
export const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'local';

/** Full display string for the footer: e.g. "v2.0.0 (3f6b2a1)". */
export const VERSION_LABEL = `v${APP_VERSION} (${BUILD_SHA})`;
