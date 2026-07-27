/**
 * Build configuration.
 *
 * The deploy story from v1 must survive: a handful of files you can drag onto
 * GitHub Pages (or any static host) with no server config. `vite-plugin-singlefile`
 * inlines every JS/CSS chunk into dist/index.html, and the small plugin below
 * stamps the build version into sw.js so its cache name changes on every build —
 * killing the manual `sdc-psychro-vNN` bump the old README required.
 *
 * `blockworld/` is an independent static mini-app; it is copied through untouched.
 */

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}

const APP_VERSION = pkg.version;
const BUILD_SHA = gitSha();

/** Copy static companions and stamp the version into sw.js after the bundle. */
function staticCompanions() {
  return {
    name: 'psychro-static-companions',
    closeBundle() {
      const out = resolve(__dirname, 'dist');
      mkdirSync(out, { recursive: true });
      // Service worker: substitute the version placeholder so the cache name
      // tracks the build. sw.js must stay a separate top-level file (scope).
      const sw = readFileSync(resolve(__dirname, 'sw.js'), 'utf8').replace(
        /__BUILD_VERSION__/g,
        `${APP_VERSION}-${BUILD_SHA}`,
      );
      writeFileSync(resolve(out, 'sw.js'), sw);
      for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'robots.txt']) {
        if (existsSync(resolve(__dirname, f))) cpSync(resolve(__dirname, f), resolve(out, f));
      }
      if (existsSync(resolve(__dirname, 'blockworld'))) {
        cpSync(resolve(__dirname, 'blockworld'), resolve(out, 'blockworld'), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [viteSingleFile(), staticCompanions()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
  },
  build: {
    target: 'es2020',
  },
});
