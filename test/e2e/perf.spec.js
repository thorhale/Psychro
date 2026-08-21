/**
 * Performance budgets for the interactive path.
 *
 * Everything here is measured in a real browser against the built artifact,
 * because the thing that matters is what happens when a finger is dragging a
 * slider on a phone in a hall — not how fast a function runs in isolation.
 *
 * The budgets are deliberately loose. They exist to catch a REGRESSION of the
 * kind this codebase has already had twice — a panel re-rendering seven times
 * per frame, a psychrometric evaluation repeated a dozen times per unit — not
 * to police milliseconds. A failure here means something got structurally
 * slower, and the number in the message says by how much.
 */

import { test, expect } from '@playwright/test';

/** Median of n timed runs, which is far steadier than a mean on CI. */
async function medianMs(page, fn, runs = 21) {
  const times = await page.evaluate(
    ([body, n]) => {
      const f = new Function(body);
      const out = [];
      for (let i = 0; i < 5; i++) f(); //   warm up JIT and layout
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        f();
        out.push(performance.now() - t0);
      }
      return out.sort((a, b) => a - b);
    },
    [fn, runs],
  );
  return times[Math.floor(times.length / 2)];
}

test.describe('interactive performance', () => {
  test('a full update stays well inside a frame', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();

    // Dragging any slider runs the whole update: chart, table, readouts, every
    // panel. 16.7 ms is one frame at 60 Hz; the budget allows three, so a
    // slower machine still passes while a structural regression does not.
    const ms = await medianMs(
      page,
      "document.getElementById('a-temp').dispatchEvent(new Event('input',{bubbles:true}));",
    );
    console.log(`  full update: ${ms.toFixed(2)} ms`);
    expect(ms, `full update took ${ms.toFixed(1)} ms`).toBeLessThan(50);
  });

  test('a hall full of equipment does not slow the update down', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));

    const bare = await medianMs(
      page,
      "document.getElementById('a-temp').dispatchEvent(new Event('input',{bubbles:true}));",
    );

    // Twenty line items including wetted media, which is the expensive kind:
    // its output is a psychrometric evaluation at the hall's live condition.
    for (let i = 0; i < 10; i++) {
      await page.locator('.eq-add[data-kind="cool"]').click();
      await page.locator('.eq-add[data-evap="1"]').click();
    }
    await expect(page.locator('.eq-row')).toHaveCount(20);
    // Give the media units an airflow so they actually cost a psychrometric
    // evaluation — an evap unit with no CFM short-circuits to zero.
    const media = page.locator('.eq-row').filter({ has: page.locator('[data-k="evapCfm"]') });
    await expect(media).toHaveCount(10);
    for (let i = 0; i < 10; i++) {
      await media.nth(i).locator('[data-k="evapCfm"]').fill('9000');
      await media.nth(i).locator('[data-k="evapCfm"]').dispatchEvent('input');
    }

    const loaded = await medianMs(
      page,
      "document.getElementById('a-temp').dispatchEvent(new Event('input',{bubbles:true}));",
    );

    // The inventory is rolled up in ONE pass and the panel only rebuilds when
    // its markup changed, so twenty units must not multiply the frame cost.
    // Before those two changes this was the shape that regressed.
    console.log(`  bare: ${bare.toFixed(2)} ms | 20 units: ${loaded.toFixed(2)} ms`);
    expect(loaded, `20 units: ${loaded.toFixed(1)} ms vs ${bare.toFixed(1)} ms bare`)
      .toBeLessThan(Math.max(bare * 3 + 10, 60));
  });

  test('panning the chart redraws without running the whole app', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();

    // Timed IN-PAGE. Driving the mouse through the test harness measures the
    // CDP round-trip, not the app: that reads ~30 ms/frame no matter how fast
    // the redraw is, which would make this a test of Playwright.
    const perFrame = await page.evaluate(() => {
      const canvas = document.getElementById('psychCanvas');
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const at = (x, y, type) =>
        window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, bubbles: true }));
      for (let i = 0; i < 10; i++) at(cx + i, cy + i, 'mousemove'); // warm up
      const t0 = performance.now();
      const N = 60;
      for (let i = 0; i < N; i++) at(cx + (i % 20), cy + (i % 20), 'mousemove');
      const ms = (performance.now() - t0) / N;
      at(cx, cy, 'mouseup');
      return ms;
    });

    // A pan is a redraw only — no table rebuild, no panel re-render, no
    // persistence. It has a whole frame to itself and should not need it.
    console.log(`  pan frame: ${perFrame.toFixed(2)} ms`);
    expect(perFrame, `${perFrame.toFixed(2)} ms per pan frame`).toBeLessThan(16.7);
  });

  test('boots and is interactive quickly', async ({ page }) => {
    const t0 = Date.now();
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    const ms = Date.now() - t0;
    // The whole app is one file with no network round-trips after it lands.
    console.log(`  boot: ${ms} ms`);
    expect(ms, `boot to interactive took ${ms} ms`).toBeLessThan(4000);
  });
});
