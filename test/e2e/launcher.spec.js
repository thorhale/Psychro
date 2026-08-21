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
});
