/**
 * Build configuration.
 *
 * The deploy story from v1 must survive: a handful of files you can drag onto
 * GitHub Pages (or any static host) with no server config. `vite-plugin-singlefile`
 * inlines every JS/CSS chunk into dist/index.html, and the small plugin below
 * stamps the build version into sw.js so its cache name changes on every build —
 * killing the manual `sdc-psychro-vNN` bump the old README required.
 *
 * Why the PWA assets are NOT fingerprinted
 * -----------------------------------------
 * Vite fingerprints anything it treats as a module asset — including the
 * `<link rel="manifest">` target — and rewrites the HTML to the hashed name.
 * `sw.js` precaches by literal path, so the manifest the installed app actually
 * referenced was NOT the one in the precache list, and a cold offline launch
 * could fail to load it. That bug shipped once.
 *
 * The obvious fix is to move those files under `public/`, which Vite copies
 * verbatim. It cannot be used here: the repo root must stay directly servable
 * with no build step (local preview, any static host, and the `raw` E2E
 * project that pins it), so `index.html`'s `manifest.webmanifest` and
 * `icon-192.png` links must resolve as siblings AT the repo root. A file cannot be at
 * the root (for the raw deploy) and under `public/` (for the build) without
 * being duplicated — and the moment the root copy exists, Vite resolves it and
 * starts fingerprinting again, which is the original bug back.
 *
 * So the assets stay at the repo root, as the single source both deploys read,
 * and `assetFileNames` below turns fingerprinting off instead. Cache busting
 * does not depend on filenames: it comes from the service-worker cache key,
 * which is stamped per build (see `staticCompanions`). `test/assets.test.js`
 * pins the root layout; `scripts/verify-bundle.mjs` asserts no fingerprinted
 * PWA asset survives in `dist/`.
 *
 * `blockworld/` is an independent static mini-app; it is copied through untouched.
 */

import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
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
 * Files `dist/` needs that no HTML tag references, plus the version stamp.
 *
 * `manifest.webmanifest` and `icon-192.png` are emitted by Vite itself (they
 * ARE referenced from index.html, just no longer hashed — see `assetFileNames`).
 * The rest have no referrer Vite can see and would otherwise be missing:
 *
 *   - `icon-512.png` is named only inside the manifest's JSON, which Vite does
 *     not parse. Without this copy an installed PWA has no high-res icon and
 *     sw.js's precache — which lists it — rejects, killing offline entirely.
 *   - `robots.txt` is fetched by crawlers, never by the app.
 *   - `privacy.html` is the privacy-policy URL both app-store consoles point
 *     at; nothing in the app links it (the in-app copy is a dialog), so only
 *     this copy puts it on the deployed site.
 *   - `sw.js` is stamped rather than copied: its cache key must change every
 *     build, and it has to stay a top-level file so its scope covers the app.
 */
const UNREFERENCED_ASSETS = [
  'icon-512.png',
  'icon-maskable-512.png', // manifest-only: padded for Android's icon masks
  'screenshot-wide.png', //   manifest-only: richer install dialog
  'screenshot-narrow.png',
  'robots.txt',
  'privacy.html',
];

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
      for (const name of UNREFERENCED_ASSETS) {
        cpSync(resolve(__dirname, name), resolve(out, name));
      }
      // The app cites docs/sensor-validation.md and docs/coolprop-comparison.md
      // in four places on screen; only dist/ is deployed, so on the live site
      // and in both native shells those were 404s. Ship the reference docs
      // with the app that points at them.
      const docsSrc = resolve(__dirname, 'docs');
      if (existsSync(docsSrc)) {
        const docsOut = resolve(out, 'docs');
        mkdirSync(docsOut, { recursive: true });
        for (const f of readdirSync(docsSrc)) {
          if (f.endsWith('.md')) cpSync(resolve(docsSrc, f), resolve(docsOut, f));
        }
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
  // No public/ directory: the PWA assets live at the repo root so the tree
  // stays servable with no build step (see the header comment).
  publicDir: false,
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        // Stable names, no content hash. sw.js precaches by literal path and
        // cannot be told what a hash will be, so a fingerprinted manifest is a
        // manifest the offline cache does not contain. JS and CSS are inlined
        // by vite-plugin-singlefile and never reach this naming path.
        assetFileNames: '[name][extname]',
      },
    },
  },
});
