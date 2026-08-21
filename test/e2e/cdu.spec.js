/**
 * The CDU sim, imported byte-for-byte from thorhale/cdu-sim.
 *
 * Its PHYSICS is gated by its own oracle — `npm run validate:cdu` sweeps 124,488
 * operating points and CI runs it. What that sweep cannot see is whether the
 * page still boots inside THIS project: whether the build copied it through
 * unprocessed, whether the link from the planner reaches it, and whether it is
 * still the offline single file it promises to be. That is what this covers.
 *
 * Deliberately shallow on numbers. Re-asserting the model here would duplicate
 * the sweep and, worse, would need updating whenever a constant is retuned —
 * two places to keep in step, which is the drift their own validator exists to
 * prevent.
 */

import { test, expect } from '@playwright/test';

test.describe('CDU sim', () => {
  test('the launcher links to it and it boots', async ({ page }) => {
    // Reached from the launcher now. It used to hang off the planner's
    // masthead, which is exactly why it could not be found.
    await page.goto('./');
    await page.locator('.tool', { hasText: 'CDU Flow Calculator' }).click();
    await expect(page).toHaveURL(/cdu\/index\.html$/);
    await expect(page.locator('h1, .t')).toContainText(/CDU/i);

    // The diagram drew: both loop bands have a path, and the flow dots exist.
    await expect(page.locator('#secBand')).toHaveAttribute('d', /^M /);
    await expect(page.locator('#priBand')).toHaveAttribute('d', /^M /);
    await expect(page.locator('#parts circle').first()).toBeVisible();

    // All three headline readouts carry a number, not a placeholder.
    for (const id of ['#vChip', '#vRet', '#vPump']) {
      await expect(page.locator(id)).toHaveText(/[0-9]/);
    }
  });

  test('moving a slider moves the answer', async ({ page }) => {
    await page.goto('./cdu/index.html');
    const die = page.locator('#vChip');
    await expect(die).toHaveText(/[0-9]/);
    const before = await die.textContent();

    // Starve the facility loop. Their whole point is that this makes the die
    // HOTTER, not cooler — if this ever reads "cooler", the model has been
    // broken in a way that matters more than any styling regression.
    await page.locator('#mf').fill('250');
    await page.locator('#mf').dispatchEvent('input');
    const after = await die.textContent();
    expect(after).not.toBe(before);
    expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
  });

  test('the unit toggle converts, and the page needs no network', async ({ page }) => {
    const external = [];
    await page.route('**', (route) => {
      const u = route.request().url();
      if (!/^(data:|blob:)/.test(u) && !u.includes('127.0.0.1') && !u.includes('localhost')) {
        external.push(u);
      }
      return route.continue();
    });

    await page.goto('./cdu/index.html');
    const die = page.locator('#vChip');
    const c = parseFloat(await die.textContent());
    await page.locator('#uF').click();
    const f = parseFloat(await die.textContent());
    expect(f).toBeCloseTo(c * 9 / 5 + 32, 0);

    // One file, no requests off-box. That promise is the reason it can live on
    // a laptop in a hall with no signal.
    expect(external, `unexpected external requests: ${external.join(', ')}`).toHaveLength(0);
  });
});

test.describe('CDU site configuration', () => {
  test('the site panel rescales the whole tool and persists', async ({ page }) => {
    await page.goto('./cdu/index.html');
    await expect(page.locator('#cap1')).toContainText('500\u00a0kW');

    await page.locator('.site summary').click();
    // A 1 MW MEG-40 cold site — nothing the original constants were tuned for.
    await page.locator('#sQdes').fill('1000');
    await page.locator('#sQdes').dispatchEvent('change');
    await page.selectOption('#sFluid', 'MEG');
    await page.locator('#sConc').fill('40');
    await page.locator('#sConc').dispatchEvent('change');

    await expect(page.locator('#cap1')).toContainText('1\u00a0MW');
    await expect(page.locator('#legSec')).toHaveText('EG40');
    await expect(page.locator('#siteNote')).toContainText('EG40 freezes at -23.8');
    // The sliders rescaled: the design preset must sit inside the new range.
    const msMax = await page.locator('#ms').getAttribute('max');
    expect(Number(msMax)).toBeGreaterThan(3000);
    // The design preset lands at pump x1.00 — the anchor is self-consistent.
    await page.locator('#presets button', { hasText: 'Design point' }).click();
    await expect(page.locator('#vPump')).toHaveText('\u00d71.00');

    // Persists: the site belongs to the device, like the hall profiles do.
    await page.reload();
    await expect(page.locator('#cap1')).toContainText('1\u00a0MW');
    await expect(page.locator('#legSec')).toHaveText('EG40');

    // And resets to the original tool.
    await page.locator('.site summary').click();
    await page.locator('#sReset').click();
    await expect(page.locator('#cap1')).toContainText('500\u00a0kW');
    await expect(page.locator('#legSec')).toHaveText('PG25');
  });

  test('config temperatures follow the unit toggle as absolutes and deltas', async ({ page }) => {
    await page.goto('./cdu/index.html');
    await page.locator('.site summary').click();
    await expect(page.locator('#sTfws')).toHaveValue('18');
    await expect(page.locator('#sApp')).toHaveValue('3');

    await page.locator('#uF').click();
    // Absolute converts (18 C = 64.4 F); a DELTA scales (3 K = 5.4 F).
    await expect(page.locator('#sTfws')).toHaveValue('64.4');
    await expect(page.locator('#sApp')).toHaveValue('5.4');

    // Typing in F must store C canonically: 68 F = 20 C.
    await page.locator('#sTfws').fill('68');
    await page.locator('#sTfws').dispatchEvent('change');
    await page.locator('#uC').click();
    await expect(page.locator('#sTfws')).toHaveValue('20');
  });

  test('a corrupted site store falls back to the defaults', async ({ page }) => {
    await page.goto('./cdu/index.html');
    await page.evaluate(() => {
      localStorage.setItem('sdc_cdu_site_v1', '{"qDes":"NaN","fluid":"DIHYDROGEN","conc":9999}');
    });
    await page.reload();
    await expect(page.locator('#cap1')).toContainText('500\u00a0kW');
    await expect(page.locator('#legSec')).toHaveText('PG60'); // conc clamped to range
    await page.locator('.site summary').click();
    await page.locator('#sReset').click();
    await expect(page.locator('#legSec')).toHaveText('PG25');
  });
});
