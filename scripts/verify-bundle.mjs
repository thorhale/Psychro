#!/usr/bin/env node
/**
 * Post-build gate: assert the shipped artifact has the properties the app's
 * offline and deploy stories depend on.
 *
 * This is a script rather than a Vitest case on purpose — a test that needs
 * `dist/` present would have to skip when it is missing, and a silently-skipping
 * guard is worse than no guard. This exits non-zero, so CI cannot ignore it.
 *
 *   npm run build && npm run verify:bundle
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const failures = [];
const checks = [];

/** Record a check; `ok` false pushes onto the failure list. */
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(dist)) {
  console.error('dist/ does not exist. Run `npm run build` first.');
  process.exit(1);
}

const files = readdirSync(dist);
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const sw = existsSync(join(dist, 'sw.js')) ? readFileSync(join(dist, 'sw.js'), 'utf8') : '';

// ── 1. Required files ───────────────────────────────────────────────────────
for (const f of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
  check(`dist/${f} exists`, files.includes(f));
}

// ── 2. Single-file promise ──────────────────────────────────────────────────
// The whole point of vite-plugin-singlefile: index.html must be droppable on its
// own. Any emitted .js/.css sibling means an inlining regression.
const strayCode = files.filter((f) => f.endsWith('.js') && f !== 'sw.js');
check('no stray JS chunks beside index.html', strayCode.length === 0, strayCode.join(', '));
const strayCss = files.filter((f) => f.endsWith('.css'));
check('no stray CSS chunks', strayCss.length === 0, strayCss.join(', '));
check('index.html has no external script src', !/<script[^>]+\ssrc=/.test(html));

// ── 3. PWA assets are NOT fingerprinted ─────────────────────────────────────
// sw.js precaches by literal path. If Vite hashes the manifest or icons, the app
// references a name the service worker never cached and a cold offline launch can
// fail. See the `public/` note in vite.config.js.
const hashed = files.filter((f) => /^(manifest|icon-\d+)-[A-Za-z0-9_-]{6,}\./.test(f));
check('no fingerprinted manifest/icon variants', hashed.length === 0, hashed.join(', '));
check(
  'index.html references ./manifest.webmanifest verbatim',
  /rel="manifest"\s+href="\.?\/?manifest\.webmanifest"/.test(html),
  (html.match(/rel="manifest"[^>]*/) || ['<none>'])[0],
);

// ── 4. Every service-worker precache entry actually exists ──────────────────
// The check that would have caught the manifest bug directly.
const assetsMatch = sw.match(/ASSETS\s*=\s*\[([^\]]*)\]/);
check('sw.js declares a precache list', Boolean(assetsMatch));
if (assetsMatch) {
  const entries = [...assetsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const entry of entries) {
    if (entry === './') continue; // the navigation root, served by index.html
    const rel = entry.replace(/^\.\//, '');
    check(`precached asset present: ${entry}`, files.includes(rel));
  }
  // And the converse for the manifest specifically: what the HTML asks for must
  // be in the precache list.
  const ref = (html.match(/rel="manifest"\s+href="([^"]+)"/) || [])[1];
  if (ref) {
    const norm = ref.replace(/^\.?\//, '');
    check(
      'the manifest the HTML references is precached',
      entries.some((e) => e.replace(/^\.\//, '') === norm),
      `html wants "${norm}", sw caches [${entries.join(', ')}]`,
    );
  }
}

// ── 4b. The manifest's OWN references must resolve and be cached ────────────
// Added after `@capacitor/assets` rewrote the manifest to point at
// `../icons/*.webp` — paths that escape the deploy root, carry a mismatched MIME
// type, and are absent from the precache list. Checking only the <link> that
// reaches the manifest (§3) missed it entirely: an installed PWA would have had
// no usable icon offline. Anything the manifest names is part of the install.
if (files.includes('manifest.webmanifest')) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8'));
    check('manifest.webmanifest is valid JSON', true);
  } catch (err) {
    check('manifest.webmanifest is valid JSON', false, err.message);
  }
  if (manifest) {
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    check('manifest declares at least one icon', icons.length > 0);
    const swEntries = assetsMatch
      ? [...assetsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''))
      : [];
    for (const icon of icons) {
      const src = String(icon.src ?? '');
      check(`manifest icon stays inside the deploy root: ${src}`, !src.includes('..'));
      const rel = src.replace(/^\.?\//, '');
      check(`manifest icon exists: ${src}`, files.includes(rel));
      check(`manifest icon is precached: ${src}`, swEntries.includes(rel));
      // A declared type that disagrees with the extension breaks some installers.
      const ext = rel.split('.').pop()?.toLowerCase();
      const declared = String(icon.type ?? '');
      if (ext && declared) {
        const consistent =
          (ext === 'png' && declared === 'image/png') ||
          (ext === 'webp' && declared === 'image/webp') ||
          (ext === 'svg' && declared === 'image/svg+xml');
        check(`manifest icon type matches extension: ${src} (${declared})`, consistent);
      }
    }
    for (const field of ['name', 'short_name', 'start_url', 'display']) {
      check(`manifest has ${field}`, Boolean(manifest[field]));
    }
  }
}

// ── 5. Service worker is version-stamped ────────────────────────────────────
// The cache name is no longer a literal — sw.js picks between the Vite-stamped
// build version and a hand-bumped RAW_VERSION, because GitHub Pages serves this
// repo unbuilt. So EVALUATE the shipped expression instead of pattern-matching
// it: a regex would have to restate the rule, and would then agree with a
// service worker whose rule had silently changed. This is what the browser gets.
/**
 * Run sw.js's declarations up to and including CACHE, and return its value.
 * Only the const block is evaluated — the `self.addEventListener` calls below
 * it are never reached, so no service-worker globals are needed.
 * @returns {string|null} the cache name, or null if it cannot be determined
 */
function evaluateCacheName(source) {
  const end = source.search(/^const ASSETS\b/m);
  if (end < 0) return null;
  try {
    return String(new Function(`${source.slice(0, end)}\nreturn CACHE;`)());
  } catch {
    return null;
  }
}

check('sw.js placeholder was substituted', !sw.includes('__BUILD_VERSION__'));
const cacheName = evaluateCacheName(sw);
check(
  'sw.js cache name is build-specific',
  Boolean(cacheName && /\d/.test(cacheName) && cacheName !== 'sdc-psychro-'),
  cacheName ?? '(could not evaluate)',
);

// The raw-served deploy takes the other branch of that same expression. Nothing
// in dist/ exercises it, so check the source: an empty or unchanged fallback
// would leave every Pages deploy sharing one cache, and cache-first clients
// would never see an update — the exact failure the fallback exists to prevent.
const swSource = readFileSync(join(root, 'sw.js'), 'utf8');
const rawCacheName = evaluateCacheName(swSource);
check(
  'unbuilt sw.js falls back to a distinct raw cache name',
  Boolean(rawCacheName && rawCacheName !== 'sdc-psychro-' && rawCacheName !== cacheName),
  rawCacheName ?? '(could not evaluate)',
);

// ── 6. Offline self-containment ─────────────────────────────────────────────
// The app promises zero network calls after install. Any absolute http(s) URL in
// a src/href attribute would break that (and the CSP).
const externalRefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
check('no external resource references', externalRefs.length === 0, externalRefs.join(', '));

// ── 7. BlockWorld passthrough ───────────────────────────────────────────────
check('blockworld/ copied through', existsSync(join(dist, 'blockworld', 'index.html')));

// ── 8. Size budget ──────────────────────────────────────────────────────────
// One artifact serves both web and the native shells, so the Capacitor plugin
// code is bundled even though the web path never executes it (~8 kB gzipped).
// That was a deliberate trade: two builds would mean the E2E suite verifies a
// different artifact from the one running on a phone, which is a worse
// consistency risk than a few kB. The budget exists to catch ACCIDENTAL growth
// — raise it only with a note in CHANGELOG.md saying what was added and why.
const RAW_BUDGET_KB = 220;
const GZIP_BUDGET_KB = 65;
const rawKb = statSync(join(dist, 'index.html')).size / 1024;
const gzipKb = gzipSync(readFileSync(join(dist, 'index.html'))).length / 1024;
check(
  `index.html within ${RAW_BUDGET_KB} kB raw`,
  rawKb <= RAW_BUDGET_KB,
  `${rawKb.toFixed(1)} kB`,
);
check(
  `index.html within ${GZIP_BUDGET_KB} kB gzipped`,
  gzipKb <= GZIP_BUDGET_KB,
  `${gzipKb.toFixed(1)} kB`,
);

// ── Report ──────────────────────────────────────────────────────────────────
const width = Math.max(...checks.map((c) => c.name.length));
for (const c of checks) {
  console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name.padEnd(width)}${c.detail ? `  ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failures.length}/${checks.length} bundle checks passed`);

if (failures.length) {
  console.error(`\n${failures.length} bundle check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
