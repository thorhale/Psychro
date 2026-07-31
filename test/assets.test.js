/**
 * The PWA assets live at the repo root, and exactly one copy exists. This pins
 * the layout that makes that work for both artifacts.
 *
 * The app ships two ways, with requirements that pull in opposite directions:
 *
 *   - **Raw** — the repo root served verbatim, which is what GitHub Pages
 *     publishes. `index.html` links `manifest.webmanifest` and `icon-192.png`
 *     as siblings and `sw.js` precaches them by those literal paths, so they
 *     must be AT the root. If one 404s the app is uninstallable and — worse —
 *     `cache.addAll()` rejects on the first miss, so the service worker never
 *     installs and there is no offline mode at all.
 *
 *   - **Built** — `dist/index.html` from `vite build`. Vite fingerprints any
 *     asset an HTML tag references, including `<link rel="manifest">`, and
 *     rewrites the tag to the hashed name while `sw.js` still precaches the
 *     unhashed one. That bug shipped once.
 *
 * Moving the files under `public/` fixes the build and breaks the raw deploy;
 * keeping copies in both places re-triggers the hashing the moment the root
 * copy exists. So there is one copy, at the root, and `vite.config.js` disables
 * fingerprinting instead. These tests guard the assumptions that rests on.
 * `scripts/verify-bundle.mjs` covers the other half, against a real `dist/`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, name), 'utf8');

describe('PWA assets at the repo root', () => {
  it('every asset the raw deploy serves is present', () => {
    for (const name of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'robots.txt']) {
      expect(existsSync(join(root, name)), `${name} missing — raw serving would 404`).toBe(true);
    }
  });

  it('there is no public/ directory to drift from the root copies', () => {
    // Its presence would mean two copies of each asset, and would silently
    // change which one vite emits. See the header comment.
    expect(existsSync(join(root, 'public'))).toBe(false);
  });

  it('the service worker precaches only assets that exist beside it', () => {
    // The offline story lives or dies here: addAll() is atomic, so a single
    // missing entry silently disables the whole service worker.
    const list = read('sw.js').match(/const ASSETS\s*=\s*\[([^\]]*)\]/);
    expect(list, 'sw.js declares a precache list').not.toBeNull();
    const assets = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      if (asset === './') continue; // the directory index, served by index.html
      expect(existsSync(join(root, asset)), `precached ${asset} is missing from the root`).toBe(
        true,
      );
    }
  });

  it('index.html references its PWA assets as flat siblings', () => {
    // A path with a directory in it would resolve raw and break in dist/, which
    // is flat — and vice versa. Flat is the only form that works in both.
    const refs = [...read('index.html').matchAll(/<link[^>]+href="([^"]+\.(?:webmanifest|png))"/g)]
      .map((m) => m[1]);
    expect(refs.length, 'index.html links a manifest and an icon').toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `${ref} must be a flat sibling path`).not.toMatch(/\//);
      expect(existsSync(join(root, ref)), `${ref} does not exist at the root`).toBe(true);
    }
  });

  it('the hosted privacy policy and the in-app dialog make the same statements', async () => {
    // Both stores require a privacy policy: a public URL (privacy.html on the
    // deployed site) and, for Google Play, a copy reachable inside the app
    // (src/app/privacy.js, shown from the footer). Two copies of a legal
    // statement is a drift hazard, so this pins them: every statement the app
    // shows must appear verbatim in the hosted page. Change one without the
    // other and this fails until they agree again.
    const { PRIVACY_STATEMENTS } = await import('../src/app/privacy.js');
    expect(PRIVACY_STATEMENTS.length).toBeGreaterThanOrEqual(4);
    const page = read('privacy.html');
    for (const statement of PRIVACY_STATEMENTS) {
      expect(page, `privacy.html is missing: "${statement}"`).toContain(statement);
    }
  });

  it('every icon the manifest declares exists and is precached', () => {
    // icon-512.png has no HTML referrer — it is named only in this JSON, which
    // vite does not parse — so it reaches dist/ only via the explicit copy in
    // vite.config.js. Adding an icon here without adding it there would ship a
    // manifest pointing at a 404, and take the service worker down with it.
    const manifest = JSON.parse(read('manifest.webmanifest'));
    expect(Array.isArray(manifest.icons) && manifest.icons.length).toBeTruthy();
    const swAssets = read('sw.js');
    for (const { src } of manifest.icons) {
      expect(src, `${src} must be a flat sibling path`).not.toMatch(/\//);
      expect(existsSync(join(root, src)), `manifest icon ${src} does not exist`).toBe(true);
      expect(swAssets.includes(`'./${src}'`), `manifest icon ${src} is not precached`).toBe(true);
    }
  });
});
