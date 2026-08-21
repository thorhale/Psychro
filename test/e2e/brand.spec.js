/**
 * The Branding card: upload a logo, and every tool restyles itself.
 *
 * This is the feature that existed for months as a build-time script and was
 * reported missing because it had no button. The test drives the whole loop a
 * person would: pick a file, see the preview, apply, leave the page, come
 * back, visit the other tools — and undo it all.
 *
 * The logo is a dark-red square generated in-page, chosen because red is far
 * from the committed navy: every assertion can tell override from default at
 * a glance, and the derived accent (fixed S/L, hue rotated toward cyan) comes
 * out measurably different from the built-in teal.
 */

import { test, expect } from '@playwright/test';

const KEY = 'sdc_psychro_brand_v1';
const DEFAULT_PRIMARY = '#193c76';

/** Upload a solid-colour PNG through the real file input. */
async function uploadLogo(page, fill) {
  await page.evaluate(async (color) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 64, 64);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'logo.png', { type: 'image/png' }));
    const inp = document.getElementById('brand-file');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, fill);
}

const brandPrimary = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim());
const brandAccent = (page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-accent').trim());

test.describe('branding', () => {
  test('a logo restyles the planner, survives a reload, and resets', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    expect(await brandPrimary(page)).toBe(DEFAULT_PRIMARY);

    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await uploadLogo(page, '#8b1a1a');
    // Preview shows the sampled primary before anything is committed.
    await expect(page.locator('#brand-hexes')).toContainText('#8b1a1a');
    expect(await brandPrimary(page)).toBe(DEFAULT_PRIMARY); //  not applied yet

    await page.locator('#brand-apply').click();
    expect(await brandPrimary(page)).toBe('#8b1a1a');

    // Persistence is the feature: a brand that lasts one session is a demo.
    await page.reload();
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    expect(await brandPrimary(page)).toBe('#8b1a1a');

    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.locator('#brand-reset').click();
    expect(await brandPrimary(page)).toBe(DEFAULT_PRIMARY);
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  });

  test('the launcher and the CDU tool follow the stored brand', async ({ page }) => {
    // Seed the store the way the card writes it, then visit the OTHER pages —
    // the two that cannot import brand.js and read the key with inline scripts.
    await page.goto('./');
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({
        primary: '#8b1a1a', primaryDark: '#5b1111', primaryLight: '#a94747',
        accent: '#14b1d1', accentDark: '#0e7c92',
      }));
    }, KEY);

    await page.reload();
    await expect(page.locator('.tool')).toHaveCount(2);
    expect(await brandPrimary(page)).toBe('#8b1a1a');

    await page.goto('./cdu/index.html');
    await expect(page.locator('#vChip')).toHaveText(/[0-9]/);
    expect(await brandAccent(page)).toBe('#14b1d1');
  });

  test('a corrupted store cannot touch the pages', async ({ page }) => {
    await page.goto('./');
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ primary: 'url(javascript:x)', accent: '#zzzzzz' }));
    }, KEY);
    await page.reload();
    await expect(page.locator('.tool')).toHaveCount(2);
    // Garbage is rejected wholesale — the defaults stand, nothing half-applies.
    expect(await brandPrimary(page)).toBe(DEFAULT_PRIMARY);

    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    expect(await brandPrimary(page)).toBe(DEFAULT_PRIMARY);
  });
});
