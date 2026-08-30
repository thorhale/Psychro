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
const html = readFileSync(join(dist, 'planner.html'), 'utf8');
const sw = existsSync(join(dist, 'sw.js')) ? readFileSync(join(dist, 'sw.js'), 'utf8') : '';

// ── 1. Required files ───────────────────────────────────────────────────────
// privacy.html is load-bearing for the app stores: both consoles point their
// mandatory privacy-policy URL at the deployed /privacy.html.
for (const f of [
  'index.html',   // the launcher
  'planner.html', // the bundled planner
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'privacy.html',
]) {
  check(`dist/${f} exists`, files.includes(f));
}

// ── 2. Single-file promise ──────────────────────────────────────────────────
// The whole point of vite-plugin-singlefile: index.html must be droppable on its
// own. Any emitted .js/.css sibling means an inlining regression.
const strayCode = files.filter((f) => f.endsWith('.js') && f !== 'sw.js');
check('no stray JS chunks beside planner.html', strayCode.length === 0, strayCode.join(', '));
const strayCss = files.filter((f) => f.endsWith('.css'));
check('no stray CSS chunks', strayCss.length === 0, strayCss.join(', '));
check('planner.html has no external script src', !/<script[^>]+\ssrc=/.test(html));

// ── 3. PWA assets are NOT fingerprinted ─────────────────────────────────────
// sw.js precaches by literal path. If Vite hashes the manifest or icons, the app
// references a name the service worker never cached and a cold offline launch can
// fail. See the asset-placement note at the top of vite.config.js.
const hashed = files.filter((f) => /^(manifest|icon-\d+)-[A-Za-z0-9_-]{6,}\./.test(f));
check('no fingerprinted manifest/icon variants', hashed.length === 0, hashed.join(', '));
check(
  'planner.html references ./manifest.webmanifest verbatim',
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
    // existsSync, not `files.includes` — the flat readdir only ever saw the top
    // level, so a nested entry like ./cdu/index.html could not be verified at
    // all. It would have passed a precache list pointing at nothing.
    const rel = entry.replace(/^\.\//, '');
    check(`precached asset present: ${entry}`, existsSync(join(dist, rel)));
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
// The cache name is not a literal — sw.js picks between the Vite-stamped build
// version and the RAW_VERSION namespace, because the same worker also serves
// the tree when it is hosted unbuilt. So EVALUATE the shipped expression instead of pattern-matching
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

// ── 4b. The deployed site's own download works ──────────────────────────────
// deploy.yml publishes dist/, and the app's download anchor points at
// ./StreamHallPlanner.html — so the file must be IN dist/, not only at the
// repo root. It 404'd in production once, with every test green, because only
// the raw-served tree was asserted and only the root copy existed. Running
// `npm run build` alone leaves dist/ without it by design: the sequence that
// produces a deployable dist/ is `npm run shareable`, and this check is what
// makes skipping it fail loudly instead of shipping a broken link.
{
  const inDist = join(dist, 'StreamHallPlanner.html');
  const atRoot = join(root, 'StreamHallPlanner.html');
  check('dist/StreamHallPlanner.html exists (the deployed download)', existsSync(inDist));
  if (existsSync(inDist) && existsSync(atRoot)) {
    check(
      'dist/ download is byte-identical to the committed copy',
      readFileSync(inDist).equals(readFileSync(atRoot)),
    );
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
// in dist/ exercises it, so check the source: an empty fallback or one equal to
// the built name would put two different artifacts in one cache namespace.
// (Freshness itself no longer rides on this name — the worker revalidates in
// the background — but namespace collisions would still cross-contaminate.)
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
// The launcher's promise is that it loads instantly with nothing to fetch, and
// that it is the one place both tools are reachable from. Both are cheap to
// assert and expensive to notice by hand.
{
  const home = readFileSync(join(dist, 'index.html'), 'utf8');
  check('launcher has no external references',
    !/(src|href)\s*=\s*["'](https?:)?\/\//i.test(home));
  check('launcher loads no scripts or styles from files',
    !/<script[^>]+\ssrc=/.test(home) && !/<link[^>]+rel=["']stylesheet/.test(home));
  check('launcher links the planner', home.includes('href="planner.html"'));
  check('launcher links the CDU tool', home.includes('href="cdu/index.html"'));
  check('launcher forwards deep links to the planner', home.includes("location.replace('planner.html'"));
}
check('blockworld/ copied through', existsSync(join(dist, 'blockworld', 'index.html')));
check('cdu/ copied through', existsSync(join(dist, 'cdu', 'index.html')));
// The CDU tool's entire promise is that it is one file with no network. If a
// build ever rewrote it into chunks, or someone added a CDN link, this catches
// it before it ships offline-broken.
{
  const cdu = existsSync(join(dist, 'cdu', 'index.html'))
    ? readFileSync(join(dist, 'cdu', 'index.html'), 'utf8') : '';
  check('cdu/index.html has no external references',
    !/(src|href)\s*=\s*["'](https?:)?\/\//i.test(cdu));
  // Was "byte-identical to thorhale/cdu-sim@ade1927". It no longer is: the tool
  // gained a link back to the launcher, because without one it is a dead end.
  // That is a deliberate fork, so the check now asserts what is still true —
  // the BUILD does not touch the file — rather than a provenance claim that
  // stopped holding. Upstream physics is still gated by `npm run validate:cdu`,
  // which checks the page's constants against its own test core.
  check('cdu/index.html reaches dist unprocessed',
    cdu === (existsSync('cdu/index.html') ? readFileSync('cdu/index.html', 'utf8') : null));
  check('cdu/index.html can get back to the launcher', cdu.includes('href="../index.html"'));
}

// ── 8. Size budget ──────────────────────────────────────────────────────────
// One artifact serves both web and the native shells, so the Capacitor plugin
// code is bundled even though the web path never executes it (~8 kB gzipped).
// That was a deliberate trade: two builds would mean the E2E suite verifies a
// different artifact from the one running on a phone, which is a worse
// consistency risk than a few kB. The budget exists to catch ACCIDENTAL growth
// — raise it only with a note in CHANGELOG.md saying what was added and why.
//
// Raised 220/65 → 280/85 for the feature round: the six-method sensor suite,
// the self-contained QR encoder, deep links, the briefing generator and ramp
// playback (~9 kB gzipped so far, headroom for the logbook/CSV/training
// milestones). Still small enough that a vendored library or an accidental
// asset inline blows the budget immediately.
//
// Raised again 280/85 → 300/95 for the in-app Start-here guide and glossary.
// This is prose, not code: it compresses well and it is the difference
// between a first-time operator understanding "W g/kg" or not. An audit found
// the app had no first-run guidance and no glossary anywhere, while the docs
// it pointed at were not even published. Prose that closes that gap is worth
// its bytes; the budget still trips instantly on a vendored library.
// Raised 300/95 → 450/150 for the digital-twin work (equipment inventory,
// redundancy, condition history) and the room to keep building on it. The
// budget exists to catch ACCIDENTAL weight — a vendored chart library, an
// inlined font, a base64 image — not to ration deliberate features, and at
// 95 kB it had started doing the latter.
//
// 150 kB gzipped is still a very small app: it arrives in well under a second
// on anything better than 2G, and after first load the service worker serves
// it from cache, so the number that matters on a hall floor is zero. A
// vendored library would still trip this immediately, which is the point.
const RAW_BUDGET_KB = 450;
const GZIP_BUDGET_KB = 150;
const rawKb = statSync(join(dist, 'planner.html')).size / 1024;
const gzipKb = gzipSync(readFileSync(join(dist, 'planner.html'))).length / 1024;
check(
  `planner.html within ${RAW_BUDGET_KB} kB raw`,
  rawKb <= RAW_BUDGET_KB,
  `${rawKb.toFixed(1)} kB`,
);
check(
  `planner.html within ${GZIP_BUDGET_KB} kB gzipped`,
  gzipKb <= GZIP_BUDGET_KB,
  `${gzipKb.toFixed(1)} kB`,
);

// ── Content-Security-Policy on every entry point ────────────────────────────
// The app's core promise is that it is fully offline and sends nothing
// anywhere. A CSP is what makes that a browser-enforced guarantee rather than
// a claim about our own code: `default-src 'none'` with `connect-src 'self'`
// means injected or tampered script cannot reach an external host at all.
//
// planner.html had one; the launcher, the CDU tool and the privacy page did
// not, so three of the four pages a user can land on were unprotected.
for (const [label, rel] of [
  ['launcher', 'index.html'],
  ['planner', 'planner.html'],
  ['CDU tool', join('cdu', 'index.html')],
  ['privacy page', 'privacy.html'],
]) {
  const file = join(dist, rel);
  if (!existsSync(file)) { check(`${label} exists to carry a CSP`, false, rel); continue; }
  const html = readFileSync(file, 'utf8');
  const has = html.includes('http-equiv="Content-Security-Policy"');
  check(`${label} carries a CSP`, has, rel);
  if (has) {
    check(`${label} CSP forbids external hosts`,
      html.includes("default-src 'none'") && html.includes("connect-src 'self'"), rel);
  }
}

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
