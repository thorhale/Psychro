/**
 * Security regressions.
 *
 * An audit of every `innerHTML` write found no live injection vector: the
 * fields an operator types into are interpolated into quoted attributes with
 * quotes escaped, which is sufficient, and the one template that writes a
 * title into markup takes it from a hardcoded table. These tests exist so that
 * stays true — the next person to reach for innerHTML with a hall name in it
 * fails here rather than in production.
 */

import { test, expect } from '@playwright/test';

const PAYLOADS = [
  '"><img src=x onerror="window.__xss(\'img\')">',
  '"><scr' + 'ipt>window.__xss("script")</scr' + 'ipt>',
  '" onfocus="window.__xss(\'focus\')" autofocus="',
  '</textarea><img src=y onerror=window.__xss("ta")>',
  "'-alert(1)-'",
];

test.describe('injection', () => {
  test('hall and SLA names cannot execute script', async ({ page }) => {
    /** @type {string[]} */
    const fired = [];
    await page.exposeFunction('__xss', (w) => { fired.push(String(w)); });
    page.on('dialog', async (d) => { fired.push('dialog'); await d.dismiss(); });

    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));

    for (const payload of PAYLOADS) {
      for (const id of ['hall-name', 'hall-building', 'hall-site']) {
        await page.fill(`#${id}`, payload);
        await page.dispatchEvent(`#${id}`, 'input');
      }
      // Toggling a capability rebuilds the hall card's markup from these
      // fields, which is where an unescaped interpolation would detonate.
      await page.locator('#cap-hum').click();
      await page.locator('#cap-hum').click();
    }

    // A reload re-renders every surface from persisted storage — the second
    // place a stored payload would get its chance.
    await page.reload();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));

    expect(fired, `payload executed: ${fired.join(', ')}`).toEqual([]);
    // Only nodes the PAYLOADS could have created — the raw build legitimately
    // has its own <script src> module tag, which a bare `script[src]` counts.
    const injected = await page.evaluate(
      () => document.querySelectorAll('img[src="x"], img[src="y"], [onerror], [onfocus]').length);
    expect(injected, 'no attacker-controlled nodes in the DOM').toBe(0);
    // And the value survives intact — escaping must not corrupt real names.
    await expect(page.locator('#hall-name')).toHaveValue(PAYLOADS[PAYLOADS.length - 1]);
  });

  test('an ampersand in a hall name survives a round trip', async ({ page }) => {
    // The escaping is quote-only by design. "AT&T" is a real site name and
    // must come back exactly, not as "AT&amp;T" or "ATT".
    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.fill('#hall-name', 'AT&T Hall <2>');
    await page.dispatchEvent('#hall-name', 'input');
    await page.reload();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await expect(page.locator('#hall-name')).toHaveValue('AT&T Hall <2>');
  });
});

/**
 * Two tabs open on the same site is ordinary — one on the hall being planned,
 * one on a hall being checked. Both wrote the same storage key on a 400 ms
 * debounce with no awareness of each other, so whichever typed last silently
 * overwrote the other's halls, SLAs and scenarios. Nothing warned anyone.
 */
test.describe('a second tab', () => {
  test('an outside write is adopted when this tab is idle', async ({ page }) => {
    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.fill('#hall-name', 'Tab One Hall');
    await page.dispatchEvent('#hall-name', 'input');
    // Let this tab's own debounced save land, so it has nothing in flight.
    await page.waitForTimeout(700);

    // Simulate the other tab: rewrite the key, then fire the event the browser
    // would deliver here. `storage` never fires in the tab that wrote, which
    // is why this cannot loop.
    await page.evaluate(() => {
      const key = 'sdc_hep_v4'; // src/state/persistence.js
      const raw = localStorage.getItem(key);
      const next = raw.replace('Tab One Hall', 'Tab Two Hall');
      localStorage.setItem(key, next);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: next }));
    });

    await expect(page.locator('#hall-name')).toHaveValue('Tab Two Hall');
  });

  test('unsaved edits here are kept, and the operator is told', async ({ page }) => {
    await page.goto('./planner.html');
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
    await page.fill('#hall-name', 'Mine In Progress');
    await page.dispatchEvent('#hall-name', 'input');

    // No wait: a save is still pending, so this tab has work the other tab
    // has never seen. Adopting would be the same data loss pointing the other way.
    await page.evaluate(() => {
      const key = 'sdc_hep_v4'; // src/state/persistence.js
      const raw = localStorage.getItem(key) || '{}';
      window.dispatchEvent(new StorageEvent('storage', {
        key, newValue: raw.replace('Mine In Progress', 'Theirs'),
      }));
    });

    await expect(page.locator('#hall-name')).toHaveValue('Mine In Progress');
    await expect(page.locator('.ntf-toast').filter({ hasText: /another tab/i }))
      .toBeVisible();
  });
});
