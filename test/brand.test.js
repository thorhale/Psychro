/**
 * Branding is only "one place" if nothing else hardcodes it.
 *
 * The previous BRAND object was correct and completely inert: the real hex
 * codes lived in the stylesheet, the toast styles and the PDF renderer, so
 * editing it changed nothing. These tests fail if that happens again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND, PALETTE, CSS_VARS, applyBrand } from '../src/config/brand.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

describe('brand palette', () => {
  it('is a complete set of usable colours', () => {
    for (const [name, value] of Object.entries(PALETTE)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
    // The accent has to be distinguishable from the primary or it is not an
    // accent — a swap that produced two near-identical colours would leave
    // every interactive element invisible against its own surface.
    const lum = (h) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    expect(Math.abs(lum(PALETTE.accent) - lum(PALETTE.primary))).toBeGreaterThan(0.15);
    expect(lum(PALETTE.primaryDark)).toBeLessThan(lum(PALETTE.primary));
    expect(lum(PALETTE.primaryLight)).toBeGreaterThan(lum(PALETTE.primary));
  });

  it('keeps the sampler markers the writer needs', () => {
    // `npm run brand:sample -- --write` rewrites between these; losing them
    // silently turns a re-sample into a no-op.
    const src = read('src/config/brand.js');
    expect(src).toContain('/* SAMPLED:start */');
    expect(src).toContain('/* SAMPLED:end */');
  });
});

describe('nothing hardcodes the brand', () => {
  // Everything that renders brand colour, other than the file that defines it
  // and the stylesheet's no-JavaScript fallback.
  const appFiles = readdirSync('src/app')
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/app/${f}`);
  const uiFiles = readdirSync('src/ui')
    .filter((f) => f.endsWith('.js'))
    .map((f) => `src/ui/${f}`);

  it('no module repeats a palette hex code', () => {
    const hexes = Object.values(PALETTE).map((h) => h.toLowerCase());
    for (const file of [...appFiles, ...uiFiles]) {
      const src = read(file).toLowerCase();
      for (const h of hexes) {
        // A CSS custom-property fallback is allowed: it is what renders when
        // this module has not run, and it names the variable beside it.
        const bare = src.split(`var(--brand-accent, ${h})`).join('');
        expect(bare, `${file} hardcodes ${h}`).not.toContain(h);
      }
    }
  });

  it('the stylesheet fallback agrees with the sampled palette', () => {
    // planner.html carries literals so the app renders before applyBrand runs.
    // If they drift, a swap produces a visible flash of the old brand.
    const html = read('planner.html');
    expect(html).toContain(`--brand-primary:${PALETTE.primary}`);
    expect(html).toContain(`--brand-accent:${PALETTE.accent}`);
    expect(html).toContain(`--stream-teal:${PALETTE.accent}`);
  });

  it('the launcher paints the same brand as the planner', () => {
    // The launcher is static by design — it cannot import brand.js, so it
    // repeats the tokens as literals. Two copies of a palette is exactly how a
    // product ends up with two different blues, so the copies are asserted
    // rather than trusted. This is the test the launcher's own comment cites.
    const home = read('index.html');
    expect(home).toContain(`--brand-primary:${PALETTE.primary}`);
    expect(home).toContain(`--brand-primary-dark:${PALETTE.primaryDark}`);
    expect(home).toContain(`--brand-accent:${PALETTE.accent}`);
  });

  it('the wording lives here too, not in the markup', () => {
    // The markup keeps readable defaults, but each is tagged so applyBrand
    // can replace it. A string with no hook is a string that cannot be swapped.
    const html = read('planner.html');
    for (const key of ['company', 'companySub', 'product']) {
      expect(html, key).toContain(`data-brand="${key}"`);
    }
  });
});

describe('applyBrand', () => {
  /** The smallest document stand-in these two operations need. */
  const fakeDoc = () => {
    const set = {};
    const nodes = { company: { textContent: 'old' }, product: { textContent: 'old' } };
    return {
      set,
      nodes,
      documentElement: { style: { setProperty: (k, v) => { set[k] = v; } } },
      querySelector: (sel) => nodes[sel.replace(/\[data-brand="(.*)"\]/, '$1')] || null,
    };
  };

  it('installs every variable and swaps the wording', () => {
    const doc = fakeDoc();
    applyBrand(/** @type {any} */ (doc));
    for (const [k, v] of Object.entries(CSS_VARS)) expect(doc.set[k]).toBe(v);
    expect(doc.nodes.company.textContent).toBe(BRAND.company);
    expect(doc.nodes.product.textContent).toBe(BRAND.product);
  });

  it('survives a document missing every brand hook', () => {
    // The placard and the export canvas render in documents that have none of
    // these nodes; applyBrand must not be the thing that throws there.
    const doc = fakeDoc();
    doc.querySelector = () => null;
    expect(() => applyBrand(/** @type {any} */ (doc))).not.toThrow();
  });
});
