/**
 * End-to-end regression tests — the app as a browser actually runs it.
 *
 * The unit suite proves the physics; it cannot catch a broken install banner, a
 * "download" link that renders instead of downloading, a slider that stops
 * holding the dew point, or a single-file build that quietly depends on a
 * sibling asset. Every assertion below corresponds to something that actually
 * shipped broken at least once.
 *
 * Runs against BOTH artifacts, because they are the two things people are
 * handed and they have drifted apart before:
 *   1. the raw-served module tree, exactly as GitHub Pages serves it
 *   2. StreamHallPlanner.html, opened from disk over file://
 *
 * `npm run test:e2e` (build first — it needs StreamHallPlanner.html).
 */
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE_URL = 'file://' + join(repo, 'StreamHallPlanner.html');

/** Read a control's live value as the user would see it. */
const val = (page, id) => page.locator(`#${id}`).inputValue();

/** The behaviour contract, asserted identically against both artifacts. */
function sharedBehaviour(name, gotoApp, { isFile }) {
  test.describe(name, () => {
    test('loads, draws the chart, and passes its own self-test', async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

      await gotoApp(page);
      await expect(page.locator('#selftest-badge')).toContainText('passed', { timeout: 15000 });
      // A failing badge says "⚠ Self-test N/M — K failed"; passing says "✓ … passed".
      await expect(page.locator('#selftest-badge')).not.toContainText('failed');
      const canvas = await page.evaluate(() => {
        const c = document.getElementById('psychCanvas');
        return c ? { w: c.width, h: c.height } : null;
      });
      expect(canvas, 'chart canvas exists').not.toBeNull();
      expect(canvas.w, 'chart has been sized and drawn').toBeGreaterThan(0);
      expect(errors, 'no console or page errors on load').toEqual([]);
    });

    test('controls read Temp / Dew pt / RH in that order', async ({ page }) => {
      await gotoApp(page);
      for (const group of ['ctl-a', 'ctl-b']) {
        const labels = await page
          .locator(`.${group} .ctl-row .ctl-k`)
          .allTextContents();
        expect(labels, `${group} row order`).toEqual(['Temp', 'Dew pt', 'RH']);
      }
    });

    test('temperature holds the dew point and drives RH', async ({ page }) => {
      await gotoApp(page);
      const dp0 = await val(page, 'a-dp');
      const rh0 = Number(await val(page, 'a-rh'));

      await page.evaluate(() => {
        const el = document.getElementById('slider-a-temp');
        el.value = 85;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Heating adds no water: the dew point must not move, and RH must fall.
      expect(await val(page, 'a-dp'), 'dew point held across a temperature move').toBe(dp0);
      expect(Number(await val(page, 'a-rh')), 'RH falls as air is heated').toBeLessThan(rh0);
    });

    test('dew point holds temperature and drives RH', async ({ page }) => {
      await gotoApp(page);
      const t0 = await val(page, 'a-temp');
      const rh0 = Number(await val(page, 'a-rh'));

      await page.evaluate(() => {
        const el = document.getElementById('slider-a-dp');
        el.value = 35; // well below the 46 °F default
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(await val(page, 'a-temp'), 'temperature untouched by a dew-point move').toBe(t0);
      expect(Number(await val(page, 'a-rh')), 'drying the air lowers RH').toBeLessThan(rh0);
    });

    test('cooling below the dew point pins RH at 100%', async ({ page }) => {
      await gotoApp(page);
      await page.evaluate(() => {
        const el = document.getElementById('slider-a-temp');
        el.value = 40; // below the ~46 °F default dew point
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(Number(await val(page, 'a-rh'))).toBe(100);
    });

    test('sensor validation distinguishes the two wet-bulb definitions', async ({ page }) => {
      await gotoApp(page);
      await page.locator('#sv-summary').click();
      await page.locator('#sv-db').fill('75');
      await page.locator('#sv-wb').fill('62');

      const readRh = async () => {
        const txt = await page.locator('#sv-res').textContent();
        const m = txt.match(/True RH ([\d.]+)%/);
        expect(m, `sv-res reported an RH (got: ${txt})`).not.toBeNull();
        return Number(m[1]);
      };

      // Default is the instrument formula — that is the card's whole purpose.
      await expect(page.locator('#sv-method')).toHaveValue('psy');
      const psy = await readRh();

      await page.locator('#sv-method').selectOption('thermo');
      const thermo = await readRh();

      // The psychrometric reading must sit BELOW the thermodynamic one, by the
      // measured offset. If this drifts, the two formulas have been confused.
      expect(thermo - psy).toBeGreaterThan(0.3);
      expect(thermo - psy).toBeLessThan(0.7);
    });

    test('impossible wet bulb is refused, not silently computed', async ({ page }) => {
      await gotoApp(page);
      await page.locator('#sv-summary').click();
      await page.locator('#sv-db').fill('70');
      await page.locator('#sv-wb').fill('80'); // wet bulb above dry bulb
      await expect(page.locator('#sv-res')).toContainText('impossible');
    });

    test('offers the app file as a real download, not a navigation', async ({ page }) => {
      await gotoApp(page);
      const link = page.locator('#app-download');
      await expect(link).toHaveCount(1);
      // The `download` attribute is what makes the browser save instead of
      // render. Without it this link just re-opens the app and looks identical
      // to the site — which is exactly how it shipped wrong.
      await expect(link).toHaveAttribute('download', 'StreamHallPlanner.html');
    });

    if (!isFile) {
      test('is installable: manifest, icons and service worker all resolve', async ({ page }) => {
        await gotoApp(page);

        const manifest = await page.evaluate(async () => {
          const l = document.querySelector('link[rel=manifest]');
          if (!l) return { ok: false, reason: 'no manifest link' };
          const r = await fetch(l.href);
          if (!r.ok) return { ok: false, reason: `manifest HTTP ${r.status}` };
          return { ok: true, json: await r.json() };
        });
        expect(manifest.ok, manifest.reason).toBe(true);
        expect(manifest.json.name).toBeTruthy();
        expect(manifest.json.display).toBe('standalone');
        expect(manifest.json.start_url).toBeTruthy();

        // Every declared icon must actually exist — a 404 here silently makes
        // the app uninstallable in Chromium.
        for (const icon of manifest.json.icons) {
          const status = await page.evaluate(
            async (src) => (await fetch(new URL(src, location.href))).status,
            icon.src,
          );
          expect(status, `icon ${icon.src}`).toBe(200);
        }

        const sw = await page.evaluate(async () => {
          const r = await navigator.serviceWorker.getRegistration();
          return r ? { ok: true, active: !!(r.active || r.installing || r.waiting) } : { ok: false };
        });
        expect(sw.ok, 'service worker registered').toBe(true);
      });

      test('shows an install affordance even without beforeinstallprompt', async ({ page }) => {
        // Headless Chromium does not fire beforeinstallprompt, which is the
        // same situation as Firefox/Safari and as Chromium before its
        // engagement heuristics trip. The banner must still appear, and must
        // still offer the file. Previously nothing appeared at all.
        await gotoApp(page);
        await expect(page.locator('#install-banner')).toHaveClass(/show/, { timeout: 10000 });
        await expect(page.locator('#install-banner')).toBeVisible();
        await expect(page.locator('#install-download')).toHaveAttribute('download', /.+/);
        const title = await page.locator('#install-title').textContent();
        expect(title.trim().length, 'banner says something actionable').toBeGreaterThan(0);
      });
    }
  });
}

// ── 1. The hosted app, served as raw modules exactly like GitHub Pages ──
sharedBehaviour(
  'hosted app (raw modules)',
  async (page) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3500); // let the install-banner fallback arm
  },
  { isFile: false },
);

// ── 2. The shareable single file, opened straight off disk ──
sharedBehaviour(
  'single-file build (file://)',
  async (page) => {
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await page.waitForTimeout(500);
  },
  { isFile: true },
);

test.describe('single-file build integrity', () => {
  test('is genuinely self-contained', async ({ page }) => {
    expect(
      existsSync(join(repo, 'StreamHallPlanner.html')),
      'StreamHallPlanner.html exists — run `npm run shareable`',
    ).toBe(true);

    const html = readFileSync(join(repo, 'StreamHallPlanner.html'), 'utf8');
    const external = html.match(/(?:src|href)="(?!data:|#|https:\/\/)[^"]*\.(?:png|js|css|webmanifest)"/g);
    expect(external, 'no sibling-asset references').toBeNull();

    // And prove it: opening from disk must not reach the network at all.
    const requests = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('file://') && !r.url().startsWith('data:')) requests.push(r.url());
    });
    await page.goto(FILE_URL, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    expect(requests, 'zero network requests from the offline file').toEqual([]);
  });
});
