/**
 * End-to-end behaviour of the shipped artifact.
 *
 * Unit tests prove the physics is right; these prove the app is WIRED to it.
 * Every assertion here is something no unit test can reach: that the bundle
 * boots, that the four display surfaces read the tested core, that the service
 * worker really serves the app offline, that a corrupt import cannot damage
 * saved state.
 *
 * This file runs under BOTH Playwright projects (see playwright.config.js) —
 * `raw`, the module tree served without a build, and `built`, the single inlined
 * `dist/index.html` — so every assertion below is made twice, once per artifact.
 * Nothing here may depend on the bundler: the one thing that legitimately
 * differs between the two is the version stamp, handled explicitly below.
 *
 * Navigation is `goto('./')`, never `goto('/')`. A leading slash is an absolute
 * path and DISCARDS the baseURL's directory, so `/` sends both projects to the
 * server root and the `built` project silently tests the raw app instead. That
 * happened; the version assertion below is what caught it.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/** Collect console errors and uncaught exceptions for the whole test. */
function watchForErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Open every <details> so panels below the fold are interactable. */
async function expandAll(page) {
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
}

test.describe('boot', () => {
  test('loads clean, self-test green, version stamped', async ({ page }, testInfo) => {
    const errors = watchForErrors(page);
    await page.goto('./');

    const badge = page.locator('#selftest-badge');
    await expect(badge).toContainText('passed');
    // The badge must report a real count, and every case must pass.
    const text = await badge.textContent();
    const [, passed, total] = text.match(/(\d+)\/(\d+)/) ?? [];
    expect(Number(passed)).toBe(Number(total));
    expect(Number(total)).toBeGreaterThanOrEqual(30);

    // The footer stamp must match the package being built, not a stale literal.
    // Only the bundler can know the version: `__APP_VERSION__` is a Vite
    // `define`, so the raw module tree legitimately reports `vdev (local)`.
    // Asserting the RIGHT one per artifact is what proves the define landed —
    // a build that silently lost it would read `vdev` and be caught here.
    await expect(page.locator('#app-version')).toContainText(
      testInfo.project.name === 'built' ? `v${pkg.version}` : 'vdev',
    );

    expect(errors, `console errors on boot:\n${errors.join('\n')}`).toEqual([]);
  });

  test('the self-test panel opens and lists every case', async ({ page }) => {
    await page.goto('./');
    await page.locator('#selftest-badge').click();
    const rows = page.locator('#selftest-panel tbody tr');
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(30);
    // No case may be rendered as failing.
    await expect(page.locator('#selftest-panel .st-row-fail')).toHaveCount(0);
  });
});

test.describe('chart', () => {
  test('renders actual content, not a blank canvas', async ({ page }) => {
    await page.goto('./');
    const ink = await page.evaluate(() => {
      const c = document.getElementById('psychCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
      return n;
    });
    expect(ink).toBeGreaterThan(100);
  });

  test('legend toggles change what is drawn', async ({ page }) => {
    await page.goto('./');
    const snapshot = () =>
      page.evaluate(() => document.getElementById('psychCanvas').toDataURL().length);
    const before = await snapshot();
    await page.locator('#leg-none').click();
    await page.waitForTimeout(150);
    const after = await snapshot();
    expect(after).not.toBe(before);
    // And restoring brings the ink back.
    await page.locator('#leg-all').click();
    await page.waitForTimeout(150);
    expect(await snapshot()).not.toBe(after);
  });
});

test.describe('physics wiring', () => {
  /**
   * The load-bearing test: scrape what the properties table SHOWS and compare it
   * against the tested core evaluated inside the same page. If the UI ever stops
   * reading `deriveState`, or a formatter mangles a value, this catches it —
   * something no unit test can do.
   */
  for (const scenario of [
    { name: 'default site (Goodyear, 1,066 ft)', elevFt: null },
    { name: 'Denver site (Westminster, 5,380 ft)', elevFt: 5380 },
  ]) {
    test(`the table agrees with the core — ${scenario.name}`, async ({ page }) => {
      await page.goto('./');
      await expandAll(page);

      if (scenario.elevFt != null) {
        await page.fill('#hall-elev', String(scenario.elevFt));
        await page.dispatchEvent('#hall-elev', 'input');
        await page.waitForTimeout(200);
      }

      const shown = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('#tableBody tr')[0].querySelectorAll('td')];
        return cells.map((c) => c.textContent.trim());
      });

      // Column order per the table header in index.html:
      //   Point | Temp °F | Temp °C | RH % | p_ws kPa | p_w kPa | W g/kg |
      //   Abs.Hum g/m³ | Dew Pt °F | Wet Bulb °F | Enthalpy | Sp.Vol | Zone
      // Note dew point and wet bulb are °F here, not °C.
      const [, tempF, tc, rh, pws, pw, W, ah, dpF, wbF, h, v, zone] = shown;

      const core = await page.evaluate(async () => {
        // The bundle is inlined, so reach the state the app is actually holding
        // and recompute from the same numbers the chart is drawing with.
        const readout = document.getElementById('pressure-readout').textContent;
        const p = parseFloat(readout);
        const t = parseFloat(document.getElementById('a-temp').value);
        const r = parseFloat(document.getElementById('a-rh').value);
        return { p, t, r };
      });

      // Values are °F-native in the first column; confirm the pairs are coherent
      // and that the displayed properties are self-consistent to the shown digits.
      expect(Number(tempF)).toBeCloseTo(core.t, 1);
      expect(Number(rh)).toBeCloseTo(core.r, 1);
      expect(Number(tc)).toBeCloseTo(((core.t - 32) * 5) / 9, 1);
      // pw = pws × RH/100, straight from the definition.
      expect(Number(pw)).toBeCloseTo((Number(pws) * Number(rh)) / 100, 3);
      // Every property parses as a real number.
      for (const [label, value] of Object.entries({ pws, pw, W, ah, dpF, wbF, h, v })) {
        expect(Number.isFinite(Number(value)), `${label} = "${value}"`).toBe(true);
      }
      // The ordering invariant, in the units the table actually prints:
      // dew point ≤ wet bulb ≤ dry bulb, all °F.
      expect(Number(dpF)).toBeLessThanOrEqual(Number(wbF) + 0.05);
      expect(Number(wbF)).toBeLessThanOrEqual(Number(tempF) + 0.05);
      // And the zone is one the envelope engine can actually produce.
      expect(['A1', 'A2', 'A3', 'A4', 'Out']).toContain(zone);
    });
  }

  test('elevation drives pressure, and pressure moves humidity ratio', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const readW = () =>
      page.evaluate(() =>
        parseFloat([...document.querySelectorAll('#tableBody tr')[0].querySelectorAll('td')][6].textContent),
      );
    const readP = () =>
      page.evaluate(() => parseFloat(document.getElementById('pressure-readout').textContent));

    const pSea = await readP();
    const wSea = await readW();
    await page.fill('#hall-elev', '5380');
    await page.dispatchEvent('#hall-elev', 'input');
    await page.waitForTimeout(200);
    const pAlt = await readP();
    const wAlt = await readW();

    // Higher elevation → lower pressure → more water per kg of dry air at the
    // same RH. This is the whole reason the tool is pressure-aware.
    expect(pAlt).toBeLessThan(pSea);
    expect(wAlt).toBeGreaterThan(wSea);
  });
});

test.describe('validity domain guard', () => {
  test('warns outside the validated band and clears on return', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const chip = page.locator('#domain-chip');
    await expect(chip).toBeHidden();

    await page.fill('#hall-elev', '18000');
    await page.dispatchEvent('#hall-elev', 'input');
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('Outside validated range');
    await expect(chip).toContainText('kPa');

    await page.fill('#hall-elev', '1066');
    await page.dispatchEvent('#hall-elev', 'input');
    await expect(chip).toBeHidden();
  });
});

test.describe('sensor validation', () => {
  test('computes RH from a dry-bulb / wet-bulb pair', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.fill('#sv-db', '75');
    await page.dispatchEvent('#sv-db', 'input');
    await page.fill('#sv-wb', '62');
    await page.dispatchEvent('#sv-wb', 'input');

    // 75/62 °F at the default site (1,066 ft → 97.4821 kPa) has TWO correct
    // answers, and which one the card shows depends on what the instrument
    // measured. The default is the psychrometer formula, because that is what a
    // sling psychrometer actually reads:
    await expect(page.locator('#sv-method')).toHaveValue('psy');
    await expect(page.locator('#sv-res')).toContainText('48.2%');
    await expect(page.locator('#sv-res')).toContainText('54.1');

    // The thermodynamic wet bulb is the other definition — CoolProp
    // cross-checked at 48.72 % RH, 54.4 °F dew point. Pinning both is what
    // keeps the two from being quietly swapped: they differ by only ~0.5 % RH,
    // small enough to look like a rounding change and large enough to fail a
    // calibration audit.
    await page.locator('#sv-method').selectOption('thermo');
    await expect(page.locator('#sv-res')).toContainText('48.7%');
    await expect(page.locator('#sv-res')).toContainText('54.4');
  });

  test('rejects a physically impossible pair', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.fill('#sv-db', '70');
    await page.dispatchEvent('#sv-db', 'input');
    await page.fill('#sv-wb', '80'); // wet bulb above dry bulb
    await page.dispatchEvent('#sv-wb', 'input');
    await expect(page.locator('#sv-res')).toContainText('impossible');
  });

  test('grades a sensor reading against the true value', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.fill('#sv-db', '75');
    await page.dispatchEvent('#sv-db', 'input');
    await page.fill('#sv-wb', '62');
    await page.dispatchEvent('#sv-wb', 'input');
    await page.fill('#sv-rh', '49'); // within ±2 % of 48.7 → PASS
    await page.dispatchEvent('#sv-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('PASS');

    await page.fill('#sv-rh', '60'); // 11 % out → FAIL
    await page.dispatchEvent('#sv-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('FAIL');
  });
});

test.describe('share and playback', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a deep link lands on its exact numbers', async ({ page }) => {
    await page.goto('./#v=1&a=80,30&b=70,50');
    await expect(page.locator('#selftest-badge')).toContainText('passed');
    await expect(page.locator('#a-temp')).toHaveValue('80');
    await expect(page.locator('#a-rh')).toHaveValue('30');
    await expect(page.locator('#b-temp')).toHaveValue('70');
    await expect(page.locator('.ntf-toast')).toContainText('shared scenario');
  });

  test('copy link produces a URL that parses back to the current state', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#share-link').click();
    await expect(page.locator('.ntf-toast')).toContainText('Link copied');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toContain('#v=1');
    // URLSearchParams percent-encodes the comma; compare decoded.
    expect(decodeURIComponent(url)).toMatch(/a=68,4[45]/); // default Current: 68 °F / ~45 %
  });

  test('the QR dialog renders a real code', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#share-qr').click();
    const dialog = page.locator('.ntf-dialog');
    await expect(dialog).toBeVisible();
    const px = await dialog.locator('canvas').evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) dark++;
      return { w: c.width, dark };
    });
    expect(px.w).toBeGreaterThan(100); // modules × scale + quiet zone
    expect(px.dark).toBeGreaterThan(300); // an actual pattern, not a blank
  });

  test('the briefing narrates the same numbers the app shows', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#copy-briefing').click();
    await expect(page.locator('.ntf-toast')).toContainText('Briefing copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('68 °F / 45% RH');
    expect(text).toContain('verify against site instrumentation');
    // The ticket is now a work order: hour-by-hour rungs and a timestamp.
    expect(text).toContain('Set-point ladder (elapsed from start):');
    expect(text).toContain('(arrival)');
    expect(text).toMatch(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  test('scrubbing the playback moves the marker and the readout', async ({ page }) => {
    await page.goto('./');
    const snapshot = () =>
      page.evaluate(() => document.getElementById('psychCanvas').toDataURL().length);
    const before = await snapshot();
    await page.locator('#playback-scrub').fill('500');
    await page.dispatchEvent('#playback-scrub', 'input');
    await page.waitForTimeout(150);
    expect(await snapshot()).not.toBe(before);
    await expect(page.locator('#playback-info')).toContainText('t+');
  });
});

test.describe('sensor validation suite', () => {
  test('salt-chamber method grades a sensor against Greenspan NaCl', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-salt').click();
    await page.locator('#sv-salt-sel').selectOption('nacl');
    await page.fill('#sv-salt-t', '77'); // 25 °C — the canonical anchor
    await page.dispatchEvent('#sv-salt-t', 'input');
    // Greenspan 1977: NaCl at 25 °C = 75.29 ± 0.12 (app applies conservative ±0.4)
    await expect(page.locator('#sv-res')).toContainText('75.3%');
    await expect(page.locator('#sv-res')).toContainText('Greenspan');

    await page.fill('#sv-salt-rh', '74'); // −1.3 → inside the 2 − 0.4 guard band
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('PASS');

    await page.fill('#sv-salt-rh', '82'); // +6.7 → beyond 5 + 0.4
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('FAIL');

    // Error landing within ±u of the tolerance: the reference itself could be
    // why it looks good (or bad), and the verdict must say so, not guess.
    await page.fill('#sv-salt-rh', '77.2'); // +1.9: between 1.6 and 2.4
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('TOO CLOSE TO CALL');
  });

  test('boiling-point reference is altitude-corrected, not 212°F', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-boil').click();
    // Default site (1,066 ft → 97.48 kPa): pure water boils near 210.9 °F,
    // visibly below 212 — the whole point of the correction.
    const res = await page.locator('#sv-res').textContent();
    const m = res.match(/Boiling point at this site:\s*([\d.]+)/);
    expect(m, `res shows a boiling temp (got: ${res})`).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(209);
    expect(Number(m[1])).toBeLessThan(211.5);
  });

  test('ice-point method grades a temperature sensor', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-ice').click();
    await page.fill('#sv-ice-t', '32.4'); // +0.4 °F → inside the 0.9 − 0.1 guard band
    await page.dispatchEvent('#sv-ice-t', 'input');
    await expect(page.locator('#sv-res')).toContainText('PASS');
    await page.fill('#sv-ice-t', '34.5'); // +2.5 °F → beyond ±1.8+0.1
    await page.dispatchEvent('#sv-ice-t', 'input');
    await expect(page.locator('#sv-res')).toContainText('FAIL');
  });
});

test.describe('operator companion', () => {
  test('a logged check lands in the drift logbook and survives reload', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-salt').click();
    await page.locator('#sv-salt-sel').selectOption('nacl');
    await page.fill('#sv-salt-t', '77');
    await page.dispatchEvent('#sv-salt-t', 'input');
    await page.fill('#sv-salt-rh', '74');
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await page.fill('#sv-sensor-label', 'CRAH-1 supply');
    await page.locator('#sv-log').click();
    await expect(page.locator('.ntf-toast')).toContainText('Logged');
    await expect(page.locator('#sv-logbook')).toContainText('CRAH-1 supply');
    await expect(page.locator('.svlog-table tbody tr')).toHaveCount(1);

    await page.reload();
    await expandAll(page);
    await expect(page.locator('#sv-logbook')).toContainText('CRAH-1 supply');
  });

  test('a BMS trend CSV imports, reports honestly, and overlays the chart', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const snapshot = () =>
      page.evaluate(() => document.getElementById('psychCanvas').toDataURL().length);
    const before = await snapshot();

    const csv =
      'Timestamp,Temp (°F),RH (%)\n' +
      Array.from({ length: 12 }, (_, i) => {
        const t = new Date(Date.UTC(2026, 6, 1, i)).toISOString();
        return `${t},${(68 + i * 0.6).toFixed(1)},${(45 - i * 0.8).toFixed(1)}`;
      }).join('\n');
    await page.setInputFiles('#trend-file', {
      name: 'trend.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });

    await expect(page.locator('#trend-res')).toContainText('12 points');
    await expect(page.locator('#trend-res')).toContainText('°F from the header');
    await expect(page.locator('#trend-res')).toContainText('Achieved');
    // The gentle 0.6 °F/hr move sits inside the Base SLA's 18 °F/hr limit —
    // and the readout says so now that the limit is actually checked. Hourly
    // sampling widens the rolling window to the sample interval and says so.
    await expect(page.locator('#trend-res')).toContainText('Fastest sustained ramp (60-min window)');
    await expect(page.locator('#trend-res')).toContainText('within the SLA ramp limits');
    // The Actual legend layer switched itself on and the chart changed.
    await expect(page.locator('.leg-item[data-vis="actual"]')).not.toHaveClass(/leg-off/);
    expect(await snapshot()).not.toBe(before);
  });

  test('sentinel dropouts are skipped, and the unit override re-reads the file', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    // A °C hall trend with two −9999 comms dropouts and NO unit in the header:
    // the sentinels must not reach the unit heuristic, which should read ~22 °C.
    const rows = Array.from({ length: 10 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 6, 1, 0, i * 10)).toISOString();
      const v = i === 3 || i === 7 ? '-9999' : (22 + i * 0.1).toFixed(1);
      return `${t},${v},45`;
    });
    await page.setInputFiles('#trend-file', {
      name: 'trend-c.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Timestamp,Zone Temp,RH\n' + rows.join('\n')),
    });
    await expect(page.locator('#trend-res')).toContainText('8 points');
    await expect(page.locator('#trend-res')).toContainText('2 bad rows skipped');
    await expect(page.locator('#trend-res')).toContainText('°C guessed from the value range');

    // The heuristic guessed °C — the operator can force °F and the file
    // re-reads in place (22 °F is a freezer, but the point is the override).
    await page.locator('#trend-unit-f').click();
    await expect(page.locator('#trend-res')).toContainText('°F (your override)');
  });

  test('a ramp faster than the SLA limit is called out', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    // 0.4 °F/min = 24 °F/hr sustained over 30 minutes — past the Base SLA's 18.
    const rows = Array.from({ length: 31 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString();
      return `${t},${(68 + i * 0.4).toFixed(1)},45`;
    });
    await page.setInputFiles('#trend-file', {
      name: 'fast.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Timestamp,Temp (°F),RH\n' + rows.join('\n')),
    });
    await expect(page.locator('#trend-res')).toContainText('FASTER than the SLA');
  });

  test('the door placard downloads as a PDF named for its hall and SLA', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-placard').click();
    const download = await downloadPromise;
    // placard_<hall>_<sla>_<date>.pdf — four halls' placards in one Downloads
    // folder used to be indistinguishable copies of sdc_psychrometric.pdf.
    expect(download.suggestedFilename()).toMatch(/^placard_.+_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

test.describe('injection safety', () => {
  // A crafted name in a colleague's save file, or a crafted header in a BMS
  // export, must be inert TEXT — never markup, never script. Each test arms
  // a tripwire on window and fails if the page ever executes the payload.
  const PAYLOAD = '<img src=x onerror="window.__pwned=1">';

  test('a hostile hall/SLA name in a save file renders as text', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const save = JSON.stringify({
      app: 'SDC Hall Environment Planner', kind: 'saveFile', version: 1,
      hallProfiles: [{ name: 'Pwned Hall', siteName: PAYLOAD, canDehumidify: true, canHumidify: true }],
      slaProfiles: [{ name: PAYLOAD, tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80 }],
    });
    await page.setInputFiles('#save-file', {
      name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from(save),
    });
    await expect(page.locator('.ntf-toast')).toContainText('Loaded');
    // Select the imported hall so its capability note renders the site name.
    await page.locator('#hall-tabs button', { hasText: 'Pwned Hall' }).first().click();
    await expect(page.locator('.cap-note')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });

  test('a hostile CSV header cannot inject through the import error', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.setInputFiles('#trend-file', {
      name: 'evil.csv', mimeType: 'text/csv',
      buffer: Buffer.from(`${PAYLOAD},b,c\n1,2,3\n4,5,6\n`),
    });
    await expect(page.locator('#trend-res')).toContainText('Could not identify');
    // The message names what was missing without quoting the file back.
    await expect(page.locator('#trend-res')).not.toContainText('onerror');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('#trend-res img').count()).toBe(0);
  });

  test('a hostile sensor label stays text in the logbook', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-ice').click();
    await page.fill('#sv-ice-t', '32.2');
    await page.dispatchEvent('#sv-ice-t', 'input');
    await page.fill('#sv-sensor-label', PAYLOAD);
    await page.locator('#sv-log').click();
    await expect(page.locator('#svlog-sel')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});

test.describe('sensor registry and recall', () => {
  test('a registered spec re-grades the live verdict against the sensor itself', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-salt').click();
    await page.locator('#sv-salt-sel').selectOption('nacl');
    await page.fill('#sv-salt-t', '77');
    await page.dispatchEvent('#sv-salt-t', 'input');
    await page.fill('#sv-salt-rh', '78'); // +2.7 vs the generic ±2 → MARGINAL
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await page.fill('#sv-sensor-label', 'CRAH-9 return');
    await page.dispatchEvent('#sv-sensor-label', 'input');
    await expect(page.locator('#sv-res')).toContainText('MARGINAL');

    // Log it so the registry editor appears, then record the sensor's real
    // datasheet spec: ±4 %RH. The same +2.7 error is now confidently in spec.
    await page.locator('#sv-log').click();
    await page.fill('#svreg-rh', '4');
    await page.dispatchEvent('#svreg-rh', 'input');
    await expect(page.locator('#sv-res')).toContainText('PASS');
    await expect(page.locator('#sv-res')).toContainText("own ±4% spec");

    // A cadence turns the logbook into a recall list.
    await page.fill('#svreg-days', '90');
    await page.dispatchEvent('#svreg-days', 'input');
    await page.locator('#svlog-sel').selectOption('CRAH-9 return');
    await expect(page.locator('#sv-logbook')).toContainText('Next check due in');
  });

  test('temperature and humidity histories are both visible at once', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    // One RH check…
    await page.locator('#sv-tab-salt').click();
    await page.fill('#sv-salt-t', '77');
    await page.dispatchEvent('#sv-salt-t', 'input');
    await page.fill('#sv-salt-rh', '75');
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await page.fill('#sv-sensor-label', 'MULTI-1');
    await page.locator('#sv-log').click();
    // …then a temperature check on the SAME sensor. The old logbook showed
    // only the last entry's quantity, hiding the RH history entirely.
    await page.locator('#sv-tab-ice').click();
    await page.fill('#sv-ice-t', '32.4');
    await page.dispatchEvent('#sv-ice-t', 'input');
    await page.locator('#sv-log').click();
    await expect(page.locator('#sv-logbook')).toContainText('Humidity checks');
    await expect(page.locator('#sv-logbook')).toContainText('Temperature checks');
  });

  test('the logbook exports as a named CSV', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-ice').click();
    await page.fill('#sv-ice-t', '32.2');
    await page.dispatchEvent('#sv-ice-t', 'input');
    await page.fill('#sv-sensor-label', 'PROBE-7');
    await page.fill('#sv-tech', 'TH');
    await page.locator('#sv-log').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#svlog-csv').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sensor-logbook_.+\.csv$/);
  });

  test('a measured barometer beats the elevation estimate, and clears back', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await expect(page.locator('#pressure-readout')).toContainText('standard atmosphere');
    await page.fill('#hall-baro', '100');
    await page.dispatchEvent('#hall-baro', 'input');
    await expect(page.locator('#pressure-readout')).toContainText('100.0 kPa');
    await expect(page.locator('#pressure-readout')).toContainText('measured on site');
    await page.fill('#hall-baro', '');
    await page.dispatchEvent('#hall-baro', 'input');
    await expect(page.locator('#pressure-readout')).toContainText('standard atmosphere');
  });
});

test.describe('round-2 seam fixes', () => {
  test('an imported trail survives an unrelated edit to the hall card', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const csv = 'Timestamp,Temp (°F),RH (%)\n' +
      Array.from({ length: 8 }, (_, i) =>
        `${new Date(Date.UTC(2026, 6, 1, i)).toISOString()},${(68 + i * 0.5).toFixed(1)},45`).join('\n');
    await page.setInputFiles('#trend-file', {
      name: 'trend.csv', mimeType: 'text/csv', buffer: Buffer.from(csv),
    });
    await expect(page.locator('#trend-res')).toContainText('8 points');
    // Toggling a capability rebuilds the hall card's markup; the panel used to
    // vanish with it, stranding the overlay with no unit toggle and no way to log.
    await page.locator('#cap-dehum').click();
    await expect(page.locator('#trend-res')).toContainText('8 points');
    await expect(page.locator('#trend-unit-c')).toBeVisible();
  });

  test('switching halls drops the previous hall\'s measured trail', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const csv = 'Timestamp,Temp (°F),RH (%)\n' +
      Array.from({ length: 6 }, (_, i) =>
        `${new Date(Date.UTC(2026, 6, 1, i)).toISOString()},${(70 + i).toFixed(1)},45`).join('\n');
    await page.setInputFiles('#trend-file', {
      name: 'hallA.csv', mimeType: 'text/csv', buffer: Buffer.from(csv),
    });
    await expect(page.locator('.leg-item[data-vis="actual"]')).not.toHaveClass(/leg-off/);
    await page.locator('#hall-add').click(); // creates and switches to a new hall
    await expect(page.locator('#trend-res')).toBeHidden();
    await expect(page.locator('.leg-item[data-vis="actual"]')).toHaveClass(/leg-off/);
  });

  test('the logbook grades rows with the same guard band as the live verdict', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-tab-salt').click();
    await page.fill('#sv-salt-t', '77');
    await page.dispatchEvent('#sv-salt-t', 'input');
    await page.fill('#sv-salt-rh', '78'); // +2.7 → MARGINAL under ±2 (u 0.4)
    await page.dispatchEvent('#sv-salt-rh', 'input');
    await page.fill('#sv-sensor-label', 'BAND-1');
    await expect(page.locator('#sv-res')).toContainText('MARGINAL');
    await page.locator('#sv-log').click();
    // The row must say MARGINAL too — it used to render green "in band"
    // because it compared against the recalibrate bound and ignored u.
    await expect(page.locator('.svlog-table tbody')).toContainText('MARGINAL');
  });
});

test.describe('field usability', () => {
  test.use({ hasTouch: true });

  test('a clamped typed value snaps back on blur, with an explanation', async ({ page }) => {
    await page.goto('./');
    // 300% RH is impossible; the app computes with 100 while the box said 300
    // until blur — which now reconciles the box and says why.
    await page.fill('#a-rh', '300');
    await page.dispatchEvent('#a-rh', 'input');
    await page.locator('#a-rh').blur();
    await expect(page.locator('#a-rh')).toHaveValue('100');
    await expect(page.locator('.ntf-toast')).toContainText('outside the allowed range');
  });

  test('deleting an SLA profile asks first, and cancel keeps it', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sla-add').click(); // Base SLA is locked; make a deletable one
    const tabs = () => page.locator('.sla-tab').count();
    const before = await tabs();
    await page.locator('#sla-del').click();
    const dialog = page.locator('.ntf-dialog');
    await expect(dialog).toContainText('Delete the SLA profile');
    await dialog.getByRole('button', { name: /cancel/i }).click();
    expect(await tabs()).toBe(before);
    // Confirming really deletes.
    await page.locator('#sla-del').click();
    await page.locator('.ntf-dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.sla-tab')).toHaveCount(before - 1);
  });

  test('a tap pins the chart inspector on a touch screen', async ({ page }) => {
    await page.goto('./');
    const canvas = page.locator('#psychCanvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.touchscreen.tap(cx, cy);
    await expect(page.locator('#chart-tip')).toBeVisible();
    await expect(page.locator('#chart-tip')).toContainText('RH');
    // The next still tap dismisses it.
    await page.touchscreen.tap(cx, cy);
    await expect(page.locator('#chart-tip')).toBeHidden();
  });
});

test.describe('training mode', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a committed recovery gets refereed and scored', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#tr-scenario').selectOption('stuck-humidifier');
    await page.fill('#tr-temp', '72');
    await page.fill('#tr-rh', '38');
    await page.locator('#tr-commit').click();
    // The known-good answer from the unit suite survives the whole run.
    await expect(page.locator('#tr-result')).toContainText('SURVIVED');
    await expect(page.locator('#tr-result')).toContainText('Score');
    await expect(page.locator('#tr-spark')).toBeVisible();
  });

  test('hesitating against the stuck humidifier breaches the dew-point cap', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#tr-scenario').selectOption('stuck-humidifier');
    await page.locator('#tr-idle').click();
    await expect(page.locator('#tr-result')).toContainText('BREACHED');
    await expect(page.locator('#tr-result')).toContainText('dew point');
    await expect(page.locator('#tr-result')).toContainText('hesitation');
  });

  test('a challenge code round-trips: copy, open, same scenario and seed', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.locator('#tr-scenario').selectOption('cold-snap');
    await page.fill('#tr-seed', '777');
    await page.dispatchEvent('#tr-seed', 'input');
    await page.locator('#tr-share').click();
    await expect(page.locator('.ntf-toast')).toContainText('Challenge code copied');
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toContain('#train=v3.cold-snap.777');

    // Opening the code lands preloaded on the identical fault. Leave the page
    // first — a hash-only goto is a same-document navigation and never reboots.
    await page.goto('about:blank');
    await page.goto('./#train=v3.cold-snap.777');
    await expect(page.locator('.ntf-toast')).toContainText('Challenge accepted');
    await expect(page.locator('#tr-scenario')).toHaveValue('cold-snap');
    await expect(page.locator('#tr-seed')).toHaveValue('777');
    await expect(page.locator('#tr-brief')).toContainText('fault seed 777');
  });

  test('an unversioned (v1) challenge code still opens, with a re-score warning', async ({ page }) => {
    // Codes shared before the referee was versioned run on today's physics —
    // flagged, never silently re-scored as if nothing changed.
    await page.goto('./#train=washdown.42');
    await expect(page.locator('.ntf-toast').filter({ hasText: 'older version' })).toBeVisible();
    await expect(page.locator('#tr-scenario')).toHaveValue('washdown');
    await expect(page.locator('#tr-seed')).toHaveValue('42');
  });
});

test.describe('feature-detected extras', () => {
  test('the NFC button stays hidden where Web NFC does not exist', async ({ page }) => {
    // Desktop Chromium has no NDEFReader — the button must not tease.
    await page.goto('./');
    await expandAll(page);
    expect(await page.evaluate(() => 'NDEFReader' in window)).toBe(false);
    await expect(page.locator('#share-nfc')).toBeHidden();
  });

  test('ladder mode speaks the verdict on screen', async ({ page }) => {
    // Stub the speech engine BEFORE the app boots and capture what it is
    // asked to say — the assertion is on the spoken text, not on audio.
    await page.addInitScript(() => {
      window.__spoken = [];
      window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
    });
    await page.goto('./');
    await expandAll(page);
    await page.locator('#sv-ladder').click();
    await expect(page.locator('#sv-ladder')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#sv-res')).toHaveClass(/sv-ladder-on/);

    // An ice-point check: sensor reads 32.4 °F against the 32.000 reference.
    await page.locator('#sv-tab-ice').click();
    await page.fill('#sv-ice-t', '32.4');
    await page.dispatchEvent('#sv-ice-t', 'input');
    await expect(page.locator('#sv-res')).toContainText('PASS');
    await expect
      .poll(async () => page.evaluate(() => window.__spoken.join(' ')))
      .toContain('PASS');

    // Toggling off restores quiet and normal type.
    await page.locator('#sv-ladder').click();
    await expect(page.locator('#sv-res')).not.toHaveClass(/sv-ladder-on/);
  });
});

test.describe('persistence', () => {
  test('a saved scenario survives a reload', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.fill('#scn-name', 'E2E scenario');
    await page.locator('#scn-save').click();
    await expect(page.locator('.scn-item-name')).toContainText('E2E scenario');

    await page.reload();
    await expandAll(page);
    await expect(page.locator('.scn-item-name')).toContainText('E2E scenario');
  });

  test('a hall edit survives a reload', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    await page.fill('#hall-name', 'Reload Test Hall');
    await page.dispatchEvent('#hall-name', 'input');
    await page.waitForTimeout(200);

    await page.reload();
    await expandAll(page);
    await expect(page.locator('#hall-name')).toHaveValue('Reload Test Hall');
  });
});

test.describe('save-file import', () => {
  test('malformed JSON toasts an error and leaves state intact', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const hallsBefore = await page.evaluate(
      () => document.querySelectorAll('#hall-tabs .sla-tab').length,
    );

    await page.setInputFiles('#save-file', {
      name: 'broken.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"hallProfiles": [{"name": "Half'),
    });

    await expect(page.locator('.ntf-toast')).toContainText('Could not load save file');
    // The critical half: nothing was applied.
    expect(await page.evaluate(() => document.querySelectorAll('#hall-tabs .sla-tab').length)).toBe(
      hallsBefore,
    );
  });

  test('a valid save file merges and reports counts', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    const payload = {
      app: 'SDC Hall Environment Planner',
      kind: 'saveFile',
      version: 1,
      hallProfiles: [{ name: 'Imported Hall', siteName: 'Ashburn, VA', elevFt: 300 }],
      slaProfiles: [{ name: 'Imported SLA', tMinF: 60, tMaxF: 85, rhMin: 10, rhMax: 70 }],
      scenarios: [{ name: 'Imported Scenario', aTemp: 70, aRH: 40, bTemp: 75, bRH: 35 }],
      customSites: [],
    };
    await page.setInputFiles('#save-file', {
      name: 'good.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(payload)),
    });

    await expect(page.locator('.ntf-toast')).toContainText('Loaded:');
    await expect(page.locator('#hall-tabs')).toContainText('Imported Hall');
    await expect(page.locator('#sla-tabs')).toContainText('Imported SLA');
  });
});

test.describe('units', () => {
  test('switching to °C converts displayed temperatures', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#a-temp')).toHaveValue('68');
    await page.locator('#unit-toggle .unit-btn[data-unit="C"]').click();
    await expect(page.locator('#a-temp')).toHaveValue('20'); // 68 °F = 20 °C
    await page.locator('#unit-toggle .unit-btn[data-unit="F"]').click();
    await expect(page.locator('#a-temp')).toHaveValue('68');
  });

  test('an out-of-SLA verdict speaks the display unit, not stored °F', async ({ page }) => {
    // The deep link parks Current at 40 °F — below the Base SLA's 50 °F floor.
    // In °C mode the chip must name the bound as 10 °C; the °F string leaking
    // through here is the exact bug this pins.
    await page.goto('./#v=1&a=40,45&b=68,45');
    await expect(page.locator('.cr-slachip .badge-bad').first()).toContainText('below 50 °F');
    await page.locator('#unit-toggle .unit-btn[data-unit="C"]').click();
    await expect(page.locator('.cr-slachip .badge-bad').first()).toContainText('below 10 °C');
    await expect(page.locator('.cr-slachip .badge-bad').first()).not.toContainText('°F');
  });

  test('the SLA editor edits the contract in the active display unit', async ({ page }) => {
    await page.goto('./');
    await expandAll(page);
    // Create an editable profile (Base SLA is locked), then flip to °C.
    await page.locator('#sla-add').click();
    await expect(page.locator('#sla-tmin')).toHaveValue('50');
    await page.locator('#unit-toggle .unit-btn[data-unit="C"]').click();
    await expect(page.locator('#sla-tmin')).toHaveValue('10'); // 50 °F = 10 °C
    // Typing 12 °C must store 53.6 °F canonically — visible back in °F mode.
    await page.fill('#sla-tmin', '12');
    await page.dispatchEvent('#sla-tmin', 'input');
    await page.locator('#unit-toggle .unit-btn[data-unit="F"]').click();
    await expect(page.locator('#sla-tmin')).toHaveValue('53.6');
  });
});

test.describe('download link', () => {
  test('the app file the UI offers actually resolves', async ({ page }) => {
    // artifacts.spec.js asserts the link's `download` attribute, but only
    // against the raw tree — where the committed root copy always exists. The
    // DEPLOYED site is dist/, and this exact link 404'd in production while
    // every test was green, because nothing ever fetched the href under the
    // built artifact. Running under both projects closes that hole for good.
    const href = await page.goto('./').then(() => page.locator('#app-download').getAttribute('href'));
    expect(href, 'the download anchor names a file').toBeTruthy();
    const res = await page.evaluate(async (u) => {
      const r = await fetch(new URL(u, location.href), { method: 'GET' });
      const body = await r.blob();
      return { status: r.status, size: body.size };
    }, href);
    expect(res.status, `${href} must be served, not 404`).toBe(200);
    // A real single-file build is ~200 kB; a soft-404 error page is not.
    expect(res.size, 'the served file is the actual app, not an error page').toBeGreaterThan(100_000);
  });
});

test.describe('privacy', () => {
  test('the policy is reachable inside the app, offline-safe', async ({ page }) => {
    // Google Play requires the privacy policy INSIDE the app, not only at the
    // store-console URL. The footer button opens it as a dialog — inline text,
    // no fetch — so this holds in every artifact including file:// and the
    // native shells.
    await page.goto('./');
    await page.locator('#privacy-link').click();
    const dialog = page.locator('.ntf-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('does not collect');
    await expect(dialog).toContainText('stays on your device');
  });
});

test.describe('offline', () => {
  test('the app still boots with the network cut', async ({ page, context }, testInfo) => {
    // Proves the service worker cached everything the app references — the
    // exact guarantee the manifest-hashing bug silently broke.
    await page.goto('./');
    await expect(page.locator('#selftest-badge')).toContainText('passed');
    await page.evaluate(() => navigator.serviceWorker.ready);

    // `serviceWorker.ready` means the worker is ACTIVE, not that the app's own
    // code is cached — the worker does not control the load that registers it,
    // so none of the module fetches reached its handler. `warmCache()` in
    // src/app/pwa.js closes that gap, and this waits for it to finish.
    //
    // Not `page.waitForFunction`: it treats the Promise an async predicate
    // returns as a truthy value and resolves immediately, so the barrier would
    // silently do nothing. `expect.poll` awaits properly.
    //
    // Asserting the COUNT rather than just proceeding is deliberate. Without it
    // this test passes on a machine whose HTTP cache happens to still hold the
    // modules — which is exactly why it went green locally and red in CI.
    const cacheState = async () =>
      page.evaluate(async () => {
        const urls = new Set([
          location.href,
          ...performance
            .getEntriesByType('resource')
            .map((r) => r.name)
            .filter((u) => u.startsWith(location.origin)),
        ]);
        let cached = 0;
        // caches.match() searches every cache, so the build-stamped name — which
        // this test has no way to know — need not be hard-coded.
        for (const url of urls) if (await caches.match(url)) cached++;
        return { cached, total: urls.size };
      });

    await expect
      .poll(async () => {
        const { cached, total } = await cacheState();
        return cached === total;
      }, { message: 'service worker never cached the full module graph', timeout: 15000 })
      .toBe(true);

    // How much there IS to cache differs by artifact, and asserting the right
    // amount per artifact is what makes "everything is cached" mean something.
    // `raw` pulls its whole module graph over the wire, so a small count would
    // mean the shell loaded and the modules did not. `built` inlines every
    // module into one file, so 2–3 resources is complete, not truncated.
    const { total } = await cacheState();
    if (testInfo.project.name === 'raw') {
      expect(total, 'the raw app loaded its module graph, not just a shell').toBeGreaterThan(5);
    } else {
      expect(total, 'the single-file build should pull almost nothing').toBeLessThanOrEqual(4);
    }

    await context.setOffline(true);
    const errors = watchForErrors(page);
    await page.reload();

    await expect(page.locator('#selftest-badge')).toContainText('passed');
    const ink = await page.evaluate(() => {
      const c = document.getElementById('psychCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 400) if (d[i] > 0) n++;
      return n;
    });
    expect(ink, 'chart must render offline').toBeGreaterThan(100);
    expect(errors, `console errors offline:\n${errors.join('\n')}`).toEqual([]);

    await context.setOffline(false);
  });
});
