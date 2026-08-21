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
