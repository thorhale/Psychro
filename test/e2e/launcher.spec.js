/**
 * The launcher — the root page, and now the PWA's start_url.
 *
 * It exists because the CDU tool shipped as a link in the planner's masthead
 * and the person it was built for could not find it. A dashboard of tools needs
 * a front door, and this is it.
 *
 * The load-bearing test here is the deep-link one. Every share URL, QR code and
 * challenge code this app has ever produced points at the ROOT with its state
 * in the hash — and the root is no longer the planner. If the forward ever
 * breaks, those links silently open a menu instead of the hall they encode, and
 * nothing else in the suite would notice.
 */

import { test, expect } from '@playwright/test';

test.describe('launcher', () => {
  test('offers both tools and reaches them', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('h1')).toContainText('Critical environment tools');
    await expect(page.locator('.tool')).toHaveCount(2);

    await page.locator('.tool', { hasText: 'Hall Environment Planner' }).click();
    await expect(page).toHaveURL(/planner\.html$/);
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();

    // …and back out again, from the planner's masthead.
    await page.locator('.mh-tool').click();
    await expect(page.locator('.tool')).toHaveCount(2);

    await page.locator('.tool', { hasText: 'CDU Flow Calculator' }).click();
    await expect(page).toHaveURL(/cdu\/index\.html$/);
    // The CDU tool can get home too — without this it is a dead end.
    await page.locator('.mh-home').click();
    await expect(page.locator('.tool')).toHaveCount(2);
  });

  test('an old deep link still opens the hall it encodes', async ({ page }) => {
    // A share URL in the real v1 format, of the kind the app's own share button
    // and QR code produce: root + state in the hash.
    const hash = '#v=1&a=95%2C20&b=72%2C45';
    await page.goto('./' + hash);
    await expect(page).toHaveURL(new RegExp('planner\\.html' + hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    // The state actually applied — not just the right page, the right point.
    await expect(page.locator('#a-temp')).toHaveValue('95');
    await expect(page.locator('#a-rh')).toHaveValue('20');
  });

  test('loads with nothing to fetch', async ({ page }) => {
    const external = [];
    await page.route('**', (route) => {
      const u = route.request().url();
      if (!/^(data:|blob:)/.test(u) && !u.includes('127.0.0.1') && !u.includes('localhost')) {
        external.push(u);
      }
      return route.continue();
    });
    await page.goto('./');
    await expect(page.locator('.tool')).toHaveCount(2);
    expect(external, `unexpected external requests: ${external.join(', ')}`).toHaveLength(0);
  });

  // ── Installing from the link people are actually sent ─────────────────────
  // The planner always had an install banner; the home page, which is what
  // the shared link opens and what the installed app starts on, had none and
  // never registered the offline worker.

  test('registers the offline worker, so installing from here works offline', async ({ page }) => {
    await page.goto('./');
    const ok = await page.waitForFunction(
      () => navigator.serviceWorker.getRegistration().then((r) => !!r).catch(() => false),
    );
    expect(await ok.jsonValue()).toBe(true);
  });

  test('offers to install even when the browser never fires its own prompt', async ({ page }) => {
    // Headless Chromium never fires beforeinstallprompt — the same situation
    // as Firefox, Safari, and Chromium before its engagement heuristic trips.
    await page.goto('./');
    const banner = page.locator('#install-banner');
    await expect(banner).toHaveClass(/show/, { timeout: 10_000 });
    await expect(banner).toBeVisible();
    expect((await page.locator('#install-title').textContent()).trim().length).toBeGreaterThan(0);
    await expect(page.locator('#install-go')).toBeHidden(); // no saved prompt to fire
    await expect(page.locator('#install-download')).toHaveAttribute('download', 'StreamHallPlanner.html');
  });

  test("the Install button fires the browser's own install prompt", async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__prompted = 0;
      const e = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(e, {
        prompt: () => { w.__prompted++; },
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      });
      window.dispatchEvent(e);
    });
    await expect(page.locator('#install-banner')).toHaveClass(/show/);
    await expect(page.locator('#install-title')).toHaveText('Install this app');
    await expect(page.locator('#install-go')).toBeVisible();
    await page.locator('#install-go').click();
    expect(await page.evaluate(() => /** @type {any} */ (window).__prompted)).toBe(1);
    await expect(page.locator('#install-banner')).toBeHidden();
  });

  test('a dismissed offer stays dismissed', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#install-banner')).toHaveClass(/show/, { timeout: 10_000 });
    await page.locator('#install-dismiss').click();
    await expect(page.locator('#install-banner')).toBeHidden();
    await page.reload();
    await page.waitForTimeout(3_500); // past the fallback
    await expect(page.locator('#install-banner')).toBeHidden();
  });

  test('says nothing about installing inside the installed app', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q) => (q.includes('display-mode: standalone')
        ? /** @type {any} */ ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })
        : real(q));
    });
    await page.goto('./');
    await page.waitForTimeout(3_500);
    await expect(page.locator('#install-banner')).toBeHidden();
  });

  // ── About ─────────────────────────────────────────────────────────────────

  test('the About section credits its author and states the method', async ({ page }) => {
    await page.goto('./');
    const about = page.locator('#about');
    await expect(about).toBeVisible();
    await expect(about.locator('a[href="https://www.linkedin.com/in/tahoggatt/"]')).toHaveText('linkedin.com/in/tahoggatt');
    await expect(about.locator('a[href="https://github.com/thorhale/Psychro"]')).toBeVisible();
    for (const a of await about.locator('a[target="_blank"]').all()) {
      await expect(a).toHaveAttribute('rel', /noopener/);
    }
    await expect(about).toContainText('ASHRAE Handbook — Fundamentals');
    await expect(about).toContainText('RP-1485');
    await expect(about).toContainText('CoolProp');
    await expect(about).toContainText('TC 9.9');
    // The method's sources ship with the app; their links must not 404.
    for (const href of ['docs/bibliography.md', 'docs/coolprop-comparison.md']) {
      await expect(about.locator(`a[href="${href}"]`)).toHaveCount(1);
      const status = await page.evaluate(async (h) => (await fetch(h)).status, href);
      expect(status, href).toBe(200);
    }
  });
});
