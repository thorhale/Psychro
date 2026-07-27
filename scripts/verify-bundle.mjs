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

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

// ── 5. Service worker is version-stamped ────────────────────────────────────
check('sw.js placeholder was substituted', !sw.includes('__BUILD_VERSION__'));
const cacheName = (sw.match(/CACHE\s*=\s*'([^']+)'/) || [])[1];
check('sw.js cache name is build-specific', Boolean(cacheName && /\d/.test(cacheName)), cacheName);

// ── 6. Offline self-containment ─────────────────────────────────────────────
// The app promises zero network calls after install. Any absolute http(s) URL in
// a src/href attribute would break that (and the CSP).
const externalRefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
check('no external resource references', externalRefs.length === 0, externalRefs.join(', '));

// ── 7. BlockWorld passthrough ───────────────────────────────────────────────
check('blockworld/ copied through', existsSync(join(dist, 'blockworld', 'index.html')));

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
