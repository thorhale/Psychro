#!/usr/bin/env node
/**
 * Generate the app-store screenshot set and the Play feature graphic.
 *
 *   npm run screenshots        (builds nothing — run `npm run shareable` first
 *                               if dist/ is stale; the script serves dist/)
 *
 * Produces, under docs/store/screenshots/, the six shots specified in
 * docs/store/README.md's checklist at every size the stores require:
 *
 *   iphone-69   1320×2868  (440×956  @3x) — Apple requires 6.9" OR 6.5"; with
 *                                           6.9" provided, smaller iPhone sizes
 *                                           are derived automatically by Apple
 *   ipad-13     2064×2752  (1032×1376 @2x) — REQUIRED because the iOS project
 *                                            ships TARGETED_DEVICE_FAMILY "1,2"
 *   play-phone  1080×2340  (360×780  @3x)
 *   play-tablet 1600×2560  (800×1280 @2x)
 *
 * plus feature-graphic.png at exactly 1024×500 (Play's required banner).
 *
 * Deliberately NOT in CI: screenshots change only when the UI meaningfully
 * changes, and burning Actions minutes re-rendering them on every push is what
 * emptied the quota once. Re-run locally and commit the results.
 *
 * Every produced file's pixel dimensions are read back from the PNG header and
 * asserted — a wrong-sized upload is a store-console rejection, so this fails
 * loudly instead (same philosophy as verify-bundle.mjs).
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'store', 'screenshots');
const PORT = 4181; // distinct from the E2E server's 4173 so the two never fight

/** Store-exact sizes: CSS viewport × deviceScaleFactor = required pixels. */
const SIZES = [
  { id: 'iphone-69', vw: 440, vh: 956, dpr: 3, px: [1320, 2868] },
  { id: 'ipad-13', vw: 1032, vh: 1376, dpr: 2, px: [2064, 2752] },
  { id: 'play-phone', vw: 360, vh: 780, dpr: 3, px: [1080, 2340] },
  { id: 'play-tablet', vw: 800, vh: 1280, dpr: 2, px: [1600, 2560] },
];

/** Fill the hall's plant model so the timing readout is populated (checklist). */
async function fillPlantRates(page) {
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => (d.open = true));
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`missing #${id}`);
      if (el.type === 'checkbox') {
        if (!el.checked) el.click();
      } else {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    set('hall-vol', 200000);
    set('rate-cool', 6);
    set('rate-warm', 4);
    set('cap-dehum', true);
    set('rate-dehum', 100);
    set('cap-hum', true);
    set('rate-hum', 80);
  });
  await page.waitForTimeout(300);
}

/** Scroll an element to the top of the viewport and let rendering settle. */
async function focusOn(page, selector) {
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'start' });
    // A touch of breathing room above the section, like a person would leave.
    window.scrollBy(0, -8);
  }, selector);
  await page.waitForTimeout(350);
}

/**
 * The six shots. Each prepares state and scrolls the story into frame; the
 * screenshot is always the raw viewport — what a phone would actually show.
 */
const SHOTS = [
  {
    name: '1-hero-planned-move',
    async prepare(page) {
      // Default state already shows Current→Target with pacing points once
      // the plant model is filled. Chart at the top of the frame.
      await focusOn(page, '#psychCanvas');
    },
  },
  {
    name: '2-compliance-readout',
    async prepare(page) {
      // Push Target hot so one point violates the SLA — the readout then
      // shows a green verdict beside a named violated bound, which is the
      // whole value proposition in one frame.
      await page.evaluate(() => {
        const el = document.getElementById('slider-b-temp');
        el.value = 95;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(250);
      await focusOn(page, '#control-readout');
    },
    async restore(page) {
      await page.reload();
      await page.waitForSelector('#selftest-badge');
      await fillPlantRates(page);
    },
  },
  {
    name: '3-properties-table',
    async prepare(page) {
      await focusOn(page, '#tableBody');
    },
  },
  {
    name: '4-sensor-validation',
    async prepare(page) {
      await page.evaluate(() => {
        const fill = (id, v) => {
          const el = document.getElementById(id);
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        fill('sv-db', 75);
        fill('sv-wb', 62);
        fill('sv-rh', 49); // within tolerance of the true 48.2 % → PASS verdict
      });
      await page.waitForTimeout(250);
      await focusOn(page, '#sv-res');
      // Center the whole card, not just the verdict line.
      await page.evaluate(() => window.scrollBy(0, -180));
      await page.waitForTimeout(200);
    },
  },
  {
    name: '5-hall-equipment',
    async prepare(page) {
      await focusOn(page, '#hall-editor');
    },
  },
  {
    name: '6-self-test',
    async prepare(page) {
      await page.locator('#selftest-badge').click();
      await page.waitForSelector('#selftest-panel tbody tr');
      await focusOn(page, '#selftest-panel');
      await page.evaluate(() => window.scrollBy(0, -60));
      await page.waitForTimeout(200);
    },
    async restore(page) {
      await page.locator('#selftest-badge').click(); // close the panel again
    },
  },
];

/** Read width/height straight from a PNG's IHDR chunk — no image library. */
function pngSize(path) {
  const b = readFileSync(path);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

const failures = [];
function assertSize(path, [w, h]) {
  const [aw, ah] = pngSize(path);
  const ok = aw === w && ah === h;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${path.replace(root + '/', '')}  ${aw}×${ah}`);
  if (!ok) failures.push(`${path}: got ${aw}×${ah}, need ${w}×${h}`);
}

// ── main ────────────────────────────────────────────────────────────────────

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('dist/ is missing — run `npm run shareable` first.');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const server = spawn(
  'npx',
  ['--yes', 'http-server', '.', '-p', String(PORT), '-c-1', '--silent'],
  { cwd: root, stdio: 'ignore' },
);
// Poll until the server answers rather than sleeping a guessed duration.
for (let i = 0; i < 50; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/dist/index.html`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const PINNED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch(
  existsSync(PINNED) ? { executablePath: PINNED } : {},
);

try {
  for (const size of SIZES) {
    console.log(`\n${size.id} (${size.px[0]}×${size.px[1]}):`);
    const ctx = await browser.newContext({
      viewport: { width: size.vw, height: size.vh },
      deviceScaleFactor: size.dpr,
    });
    const page = await ctx.newPage();
    // Suppress the install banner: its 3-second fallback would race the shots.
    await page.addInitScript(() => {
      localStorage.setItem('sdc_psychro_install_dismissed_v1', String(Date.now()));
    });
    await page.goto(`http://127.0.0.1:${PORT}/dist/`, { waitUntil: 'load' });
    await page.waitForSelector('#selftest-badge');
    await fillPlantRates(page);

    for (const shot of SHOTS) {
      await shot.prepare(page);
      const file = join(outDir, `${size.id}-${shot.name}.png`);
      await page.screenshot({ path: file });
      assertSize(file, size.px);
      if (shot.restore) await shot.restore(page);
    }
    await ctx.close();
  }

  // The Play feature graphic, rendered from its static HTML at exactly 1024×500.
  console.log('\nfeature graphic (1024×500):');
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 500 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(root, 'docs', 'store', 'feature-graphic.html')).href);
  const file = join(outDir, 'feature-graphic.png');
  await page.screenshot({ path: file });
  assertSize(file, [1024, 500]);
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} file(s) came out the wrong size:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\nAll screenshots written to docs/store/screenshots/ at store-exact sizes.`);
