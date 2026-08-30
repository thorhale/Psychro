/**
 * Accessibility.
 *
 * This is a tool people use standing in a data hall, sometimes on a phone,
 * sometimes with gloves, and sometimes with a screen reader. The app had 191
 * interactive controls and six accessible names between them: every setpoint
 * slider announced as a bare "slider", with the visible "Temp" being a plain
 * <span> that no assistive technology associates with it — and no way to tell
 * Current's temperature from Target's.
 *
 * Two kinds of check here. Axe catches the mechanical violations. The
 * hand-written tests below cover the thing axe cannot know: that the SLA
 * verdict, which is the whole point of the tool, is announced when it changes
 * and stays quiet when it does not.
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('accessibility', () => {
  test('no serious or critical axe violations on the planner', async ({ page }) => {
    await page.goto('./planner.html');
    await page.locator('#selftest-badge').filter({ hasText: 'passed' }).waitFor();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    const detail = bad
      .map((v) => `${v.impact} · ${v.id}: ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n    ')}`)
      .join('\n  ');
    expect(bad, `axe violations:\n  ${detail}`).toEqual([]);
  });

  test('no serious or critical axe violations on the launcher', async ({ page }) => {
    await page.goto('./index.html');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    expect(bad, bad.map((v) => `${v.id}: ${v.help}`).join('; ')).toEqual([]);
  });

  test('every setpoint control says which point it belongs to', async ({ page }) => {
    await page.goto('./planner.html');
    // "Temp" alone is useless — there are two temperatures on this screen.
    for (const [id, name] of [
      ['slider-a-temp', /current.*temperature/i],
      ['slider-b-temp', /target.*temperature/i],
      ['slider-a-rh', /current.*humidity/i],
      ['slider-b-rh', /target.*humidity/i],
      ['slider-a-dp', /current.*dew/i],
      ['slider-b-dp', /target.*dew/i],
      ['a-temp', /current.*temperature/i],
      ['b-rh', /target.*humidity/i],
    ]) {
      await expect(page.locator(`#${id}`), id).toHaveAttribute('aria-label', name);
    }
  });

  test('a verdict change is announced, and an unchanged one is not', async ({ page }) => {
    await page.goto('./planner.html');
    const live = page.locator('#a11y-status');
    await expect(live).toHaveAttribute('aria-live', 'polite');

    // Put Target somewhere comfortably inside the contract.
    await page.fill('#b-temp', '72');
    await page.dispatchEvent('#b-temp', 'input');
    await page.fill('#b-rh', '45');
    await page.dispatchEvent('#b-rh', 'input');
    await expect(live).toContainText(/target inside sla/i);

    // Nudging within the envelope must NOT re-announce: a screen reader that
    // talks through a whole slider drag is worse than one that stays quiet.
    const quiet = await live.textContent();
    await page.fill('#b-temp', '72.5');
    await page.dispatchEvent('#b-temp', 'input');
    expect(await live.textContent()).toBe(quiet);

    // Crossing the contract is exactly what must be spoken, with the reason.
    await page.fill('#b-temp', '120');
    await page.dispatchEvent('#b-temp', 'input');
    await expect(live).toContainText(/target outside sla/i);
    await expect(live).toContainText(/above/i);
  });
});
