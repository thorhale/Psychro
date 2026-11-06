/**
 * The home screen's "Upload logo" button, end to end.
 *
 * What a person would do: open the home screen, upload their logo, and see
 * the tools take its colours, the header show the logo instead of the
 * wordmark, and the tab and install icons become the logo. Then leave, come
 * back, open the other tools, and take it all off again.
 *
 * The logo is drawn in-page: a dark-red disc on a transparent square, so the
 * palette is measurably far from the committed navy and the backdrop rule
 * (dark mark on transparency gets white) is exercised.
 */

import { test, expect } from '@playwright/test';

const DEFAULT_PRIMARY = '#193c76';
const LOGO_KEY = 'sdc_psychro_logo_v1';
const BRAND_KEY = 'sdc_psychro_brand_v1';

async function uploadOnHome(page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 120;
    const x = c.getContext('2d');
    x.fillStyle = '#8b1a1a';
    x.beginPath(); x.ellipse(120, 60, 110, 50, 0, 0, Math.PI * 2); x.fill();
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'logo.png', { type: 'image/png' }));
    const inp = /** @type {HTMLInputElement} */ (document.getElementById('logo-file'));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const cssVar = (page, name) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const href = (page, rel) =>
  page.evaluate((r) => document.querySelector(`link[rel="${r}"]`)?.getAttribute('href') ?? null, rel);

test.describe('logo upload on the home screen', () => {
  test('themes the colours, the header and the icons, persists, and comes off', async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#logo-pick')).toBeVisible();
    await expect(page.locator('#logo-pick')).toHaveText('Upload logo');
    await expect(page.locator('#logo-reset')).toBeHidden();
    await expect(page.locator('.mh-company')).toBeVisible();
    expect(await cssVar(page, '--brand-primary')).toBe(DEFAULT_PRIMARY);

    await uploadOnHome(page);
    await expect(page.locator('#logo-note')).toContainText('Colours and icon updated');
    // The note is honest about the one thing a web page cannot do.
    await expect(page.locator('#logo-note')).toContainText('add it again');

    // Colours follow the logo.
    expect(await cssVar(page, '--brand-primary')).toBe('#8b1a1a');
    // The logo REPLACES the wordmark.
    const logo = page.locator('.masthead img[data-brand-logo]');
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    await expect(page.locator('.mh-company')).toBeHidden();
    await expect(page.locator('.mh-sub')).toBeHidden();
    // A dark mark on transparency sits on white, so it can be seen.
    expect(await logo.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');

    // Tab icon and Add-to-Home-Screen icon are the logo.
    expect(await href(page, 'icon')).toMatch(/^data:image\/png;base64,/);
    expect(await href(page, 'apple-touch-icon')).toMatch(/^data:image\/png;base64,/);
    // The install manifest carries the logo icons and keeps the app's identity.
    await expect.poll(() => href(page, 'manifest')).toMatch(/^blob:/);
    // Ask the browser for the manifest IT loaded, through the same CSP the page
    // runs under (manifest-src allows blob:; a page script reading it with
    // fetch would be connect-src, which rightly does not). Parse errors here
    // would mean the install prompt silently fell back or broke.
    const cdp = await page.context().newCDPSession(page);
    const got = await cdp.send('Page.getAppManifest');
    expect(got.url).toMatch(/^blob:/);
    expect(got.errors).toEqual([]);
    const manifest = JSON.parse(got.data);
    expect(manifest.icons).toHaveLength(3);
    expect(manifest.icons.every((i) => i.src.startsWith('data:image/png;base64,'))).toBe(true);
    expect(manifest.icons.map((i) => i.purpose)).toEqual(['any', 'any', 'maskable']);
    expect(new URL(manifest.id).pathname).toBe('/Psychro/');
    expect(new URL(manifest.start_url).origin).toBe(new URL(page.url()).origin);
    expect(manifest.theme_color).toBe('#8b1a1a');
    expect(await page.locator('meta[name="theme-color"]').getAttribute('content')).toBe('#8b1a1a');

    // The icons really are the logo on its backdrop, at the promised sizes.
    const sizes = await page.evaluate(async (k) => {
      const kit = JSON.parse(localStorage.getItem(k));
      const dim = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res([i.naturalWidth, i.naturalHeight]); i.src = src; });
      return { i192: await dim(kit.icons.i192), i512: await dim(kit.icons.i512), m512: await dim(kit.icons.m512), a180: await dim(kit.icons.a180) };
    }, LOGO_KEY);
    expect(sizes).toEqual({ i192: [192, 192], i512: [512, 512], m512: [512, 512], a180: [180, 180] });

    // It survives a reload, with no flash of the old wordmark on the way.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.classList.contains('has-logo'))).toBe(true);
    await expect(logo).toBeVisible();
    await expect(page.locator('.mh-company')).toBeHidden();
    await expect(page.locator('#logo-pick')).toHaveText('Change logo');
    await expect(page.locator('#logo-reset')).toBeVisible();

    // The planner follows: logo in the header and footer, tab icon, colours.
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    await expect(page.locator('.masthead img[data-brand-logo]')).toBeVisible();
    await expect(page.locator('.masthead [data-brand="company"]')).toBeHidden();
    expect(await href(page, 'icon')).toMatch(/^data:image\/png;base64,/);
    expect(await cssVar(page, '--brand-primary')).toBe('#8b1a1a');

    // So does the CDU tool's tab icon.
    await page.goto('./cdu/index.html');
    await expect(page.locator('#vChip')).toHaveText(/[0-9]/);
    expect(await href(page, 'icon')).toMatch(/^data:image\/png;base64,/);

    // And it all comes off again, from the home screen.
    await page.goto('./');
    await page.locator('#logo-reset').click();
    await expect(page.locator('#logo-note')).toContainText('Back to the built-in');
    expect(await cssVar(page, '--brand-primary')).toBe(DEFAULT_PRIMARY);
    await expect(page.locator('.mh-company')).toBeVisible();
    await expect(logo).toBeHidden();
    expect(await href(page, 'icon')).toMatch(/icon-192\.png$/);
    expect(await href(page, 'manifest')).toMatch(/manifest\.webmanifest$/);
    expect(await page.evaluate(([a, b]) => [localStorage.getItem(a), localStorage.getItem(b)], [LOGO_KEY, BRAND_KEY]))
      .toEqual([null, null]);
  });

  test('a file that is not an image is refused in plain words', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['not a picture'], 'notes.png', { type: 'image/png' }));
      const inp = /** @type {HTMLInputElement} */ (document.getElementById('logo-file'));
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('#logo-note')).toContainText('not an image');
    expect(await cssVar(page, '--brand-primary')).toBe(DEFAULT_PRIMARY);
    expect(await page.evaluate((k) => localStorage.getItem(k), LOGO_KEY)).toBeNull();
  });

  test('a tampered store cannot put a foreign URL on the page', async ({ page }) => {
    await page.goto('./');
    await page.evaluate((k) => {
      const bad = 'https://evil.example/x.png';
      localStorage.setItem(k, JSON.stringify({ v: 1, logo: bad, bg: '#ffffff', icons: { i192: bad, i512: bad, m512: bad, a180: bad } }));
    }, LOGO_KEY);
    await page.reload();
    await expect(page.locator('.tool')).toHaveCount(2);
    await expect(page.locator('.masthead img[data-brand-logo]')).toBeHidden();
    expect(await href(page, 'icon')).toMatch(/icon-192\.png$/);
  });
});
