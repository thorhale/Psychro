/**
 * Visual regression on the chart.
 *
 * The chart is ~900 lines of hand-rolled canvas drawing: envelope polygons, RH
 * curves, wet-bulb and specific-volume iso-lines, labels placed by a viewport-aware
 * solver. None of that is reachable by a unit test, and a silent corruption —
 * a mis-scaled axis, a polygon that stopped closing, labels stacking on top of
 * each other — would look fine in every numeric assertion.
 *
 * Goldens are committed. To re-bless after an intentional visual change:
 *
 *     npm run build && npm run e2e:update
 *
 * and review the diff images in the commit before accepting them.
 */

import { test, expect } from '@playwright/test';

/**
 * Screenshot just the chart, not the page: profile panels contain
 * environment-dependent text (site names, dates) that would make the whole-page
 * shot brittle without testing anything the chart doesn't already cover.
 */
const CHART = '.psych-wrap';

/** Wait for the canvas to have finished a draw pass. */
async function settle(page) {
  await page.waitForFunction(() => {
    const c = document.getElementById('psychCanvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4000) if (d[i] > 0) return true;
    return false;
  });
  // Two frames so any rAF-scheduled redraw has landed.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

test.describe('chart appearance', () => {
  test('default view', async ({ page }) => {
    await page.goto('./planner.html');
    await settle(page);
    await expect(page.locator(CHART)).toHaveScreenshot('chart-default.png');
  });

  test('at altitude — envelopes shift with site pressure', async ({ page }) => {
    // Westminster, CO at 5,380 ft. Pressure-aware polygons should visibly differ
    // from the sea-level-ish default; this is the picture of that physics.
    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.fill('#hall-elev', '5380');
    await page.dispatchEvent('#hall-elev', 'input');
    await settle(page);
    await expect(page.locator(CHART)).toHaveScreenshot('chart-altitude.png');
  });

  test('single envelope — legend filtering', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#leg-none').click();
    await settle(page);
    await expect(page.locator(CHART)).toHaveScreenshot('chart-legend-none.png');
  });

  test('a planned move — A→B line with hourly pacing points', async ({ page }) => {
    // Exercises the move-path drawing and the hourly tick placement, which only
    // appear once the hall has plant rates and the two points are far apart.
    // (No °C variant here: the chart axis is deliberately always °C — the unit
    // toggle drives the controls, table and readout, not the plot. A metric
    // screenshot was byte-identical to the default, so it pinned nothing.)
    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.fill('#hall-vol', '200000');
    await page.dispatchEvent('#hall-vol', 'input');
    await page.fill('#rate-cool', '4');
    await page.dispatchEvent('#rate-cool', 'input');
    await page.fill('#slider-b-temp', '64');
    await page.dispatchEvent('#slider-b-temp', 'input');
    await settle(page);
    await expect(page.locator(CHART)).toHaveScreenshot('chart-planned-move.png');
  });

  test('zoomed to the active SLA', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#zoom-sla').click();
    await settle(page);
    await expect(page.locator(CHART)).toHaveScreenshot('chart-zoom-sla.png');
  });
});
