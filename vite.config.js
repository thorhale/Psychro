/**
 * Build configuration.
 *
 * The deploy story from v1 must survive: a handful of files you can drag onto
 * GitHub Pages (or any static host) with no server config. `vite-plugin-singlefile`
 * inlines every JS/CSS chunk into dist/index.html, and the small plugin below
 * stamps the build version into sw.js so its cache name changes on every build —
 * killing the manual `sdc-psychro-vNN` bump the old README required.
 *
 * Why the PWA assets live in `public/`
 * ------------------------------------
 * Vite fingerprints anything it treats as a module asset — including the
 * `<link rel="manifest">` target — and rewrites the HTML to the hashed name.
 * `sw.js` precaches by literal path, so the manifest the installed app actually
 * references was NOT the one in the precache list, and a cold offline launch
 * could fail to load it. Files under `public/` are copied verbatim with stable
 * names, which is exactly the contract a hand-written service worker needs.
 * `test/build.test.js` asserts no fingerprinted PWA assets survive in `dist/`.
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

/**
 * Stamp the build version into sw.js and copy the BlockWorld mini-app.
 *
 * The PWA assets (manifest, icons, robots.txt) are NOT handled here — they live
 * in `public/` so Vite copies them with stable, unhashed names. sw.js is stamped
 * rather than copied because its cache key has to change every build, and it must
 * stay a separate top-level file so its service-worker scope covers the app.
 */
function staticCompanions() {
  return {
    name: 'psychro-static-companions',
    closeBundle() {
      const out = resolve(__dirname, 'dist');
      mkdirSync(out, { recursive: true });
      const sw = readFileSync(resolve(__dirname, 'sw.js'), 'utf8').replace(
        /__BUILD_VERSION__/g,
        `${APP_VERSION}-${BUILD_SHA}`,
      );
      writeFileSync(resolve(out, 'sw.js'), sw);
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
