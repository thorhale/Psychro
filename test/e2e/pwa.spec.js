/**
 * Staying up to date.
 *
 * A stale app is a correctness problem, not a convenience one: an operator
 * acting on last week's envelope table is acting on the wrong numbers.
 *
 * The "a new version is ready" toast already existed, but nothing ever
 * re-checked. `register()` checks once, at load, and that was it — so a tab
 * left open across a deploy never found out, which is exactly how this app is
 * used: open on a hall all shift. The only way back was a hard refresh.
 */

import { test, expect } from '@playwright/test';

test.describe('service-worker update checks', () => {
  test('returning to the tab asks whether a new version exists', async ({ page }) => {
    // Count update() calls on the registration the app itself creates.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__updateCalls = 0;
      const proto = ServiceWorkerRegistration.prototype;
      const real = proto.update;
      proto.update = function patched() {
        w.__updateCalls++;
        return real.apply(this, arguments);
      };
    });

    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    // Wait for registration to resolve so the listeners are attached.
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.getRegistration()
        .then((r) => !!r).catch(() => false),
    );
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => /** @type {any} */ (window).__updateCalls);

    // Coming back to the tab is the moment worth checking: it is when someone
    // is about to act on what the app says.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState',
        { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => /** @type {any} */ (window).__updateCalls);
    expect(after, 'regaining focus must trigger an update check').toBeGreaterThan(before);
  });

  test('an update check is skipped while the tab is hidden', async ({ page }) => {
    // Checking while backgrounded wastes a request and can never be acted on:
    // there is nobody looking at the toast it would produce.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.__updateCalls = 0;
      const proto = ServiceWorkerRegistration.prototype;
      const real = proto.update;
      proto.update = function patched() { w.__updateCalls++; return real.apply(this, arguments); };
    });
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => /** @type {any} */ (window).__updateCalls);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState',
        { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => /** @type {any} */ (window).__updateCalls);
    expect(after, 'a hidden tab must not poll').toBe(before);
  });
});
