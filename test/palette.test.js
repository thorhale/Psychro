/**
 * The palette derivation — the one implementation behind both the build-time
 * sampler and the in-app Branding card.
 *
 * Synthetic pixels, chosen so every rule in the derivation has a test that
 * fails if it is removed: the background exclusion, the anti-alias bucketing,
 * the saturation gate on the primary, and the fixed-S/L accent that keeps an
 * arbitrary logo legible on a dark interface.
 */

import { describe, it, expect } from 'vitest';
import { dominantColors, derivePalette, toHsl, isValidPalette } from '../src/config/palette.js';
import { PALETTE } from '../src/config/brand.js';

/** RGBA buffer: n pixels of each [r,g,b] run, alpha 255. */
function px(...runs) {
  const out = [];
  for (const [n, r, g, b, a = 255] of runs) {
    for (let i = 0; i < n; i++) out.push(r, g, b, a);
  }
  return new Uint8ClampedArray(out);
}

describe('dominantColors', () => {
  it('ignores the paper: white grounds, black outlines, transparency', () => {
    const colors = dominantColors(px(
      [500, 255, 255, 255],   // background
      [300, 5, 5, 5],         // outline
      [200, 25, 60, 118],     // the mark (Stream navy)
      [400, 200, 30, 30, 40], // transparent red — behind the mark, not of it
    ));
    expect(colors).toHaveLength(1);
    expect(colors[0].hex).toBe('#193c76');
  });

  it('folds anti-aliased edges into the solid they belong to', () => {
    // 16-level bucketing: 0x19/0x3c/0x76 and a pixel two steps off share a
    // bucket, so an aliased edge strengthens the solid instead of splitting it.
    const colors = dominantColors(px(
      [100, 0x19, 0x3c, 0x76],
      [50, 0x1b, 0x3e, 0x74],
    ));
    expect(colors).toHaveLength(1);
    expect(colors[0].n).toBe(150);
  });

  it('orders by count, most-used first', () => {
    const colors = dominantColors(px([10, 200, 40, 40], [90, 40, 90, 200]));
    expect(colors[0].hex).toBe('#285ac8');
    expect(colors[1].hex).toBe('#c82828');
  });
});

describe('derivePalette', () => {
  it('reproduces the committed brand from Stream-navy pixels', () => {
    // The real chain: the committed PALETTE was produced by this exact
    // derivation from the committed artwork, so navy in must give the
    // committed palette out. If this fails, the button in the app and the
    // script in the repo have stopped being the same feature.
    const p = derivePalette(dominantColors(px([100, 0x19, 0x3c, 0x76])));
    expect(p).toEqual(PALETTE);
  });

  it('prefers a saturated solid over a bigger grey', () => {
    const p = derivePalette(dominantColors(px(
      [500, 120, 120, 125], //  a big near-grey (a photo background, a shadow)
      [100, 139, 26, 26],   //  the actual mark, dark red
    )));
    expect(p.primary).toBe('#8b1a1a');
  });

  it('pins the accent to fixed saturation and lightness, any input hue', () => {
    // The contract that keeps an arbitrary logo usable: whatever hue comes in,
    // the accent leaves at S=0.85, L=0.42 — never an unreadable dark brown.
    for (const rgb of [[139, 26, 26], [26, 139, 26], [90, 26, 139]]) {
      const p = derivePalette(dominantColors(px([100, ...rgb])));
      const [, s, l] = toHsl(p.accent.slice(1).match(/../g).map((h) => parseInt(h, 16)));
      expect(s).toBeCloseTo(0.85, 2);
      expect(l).toBeCloseTo(0.42, 2);
    }
  });

  it('rotates toward cyan, not blindly around the wheel', () => {
    // Navy (~220°) must come DOWN toward 190°, a warm red up toward it —
    // +30° off navy is violet, which reads as a second brand.
    const fromNavy = derivePalette(dominantColors(px([100, 0x19, 0x3c, 0x76])));
    const [hN] = toHsl(fromNavy.accent.slice(1).match(/../g).map((h) => parseInt(h, 16)));
    expect(hN).toBeCloseTo(190, 0);
  });

  it('returns null for an image with no brand in it', () => {
    expect(derivePalette(dominantColors(px([100, 255, 255, 255], [100, 0, 0, 0])))).toBeNull();
  });
});

describe('isValidPalette', () => {
  it('accepts exactly five #rrggbb strings and nothing weaker', () => {
    expect(isValidPalette(PALETTE)).toBe(true);
    expect(isValidPalette(null)).toBe(false);
    expect(isValidPalette({ ...PALETTE, accent: 'red' })).toBe(false);
    expect(isValidPalette({ ...PALETTE, accent: '#12345' })).toBe(false);
    expect(isValidPalette({ ...PALETTE, accent: 'url(x)' })).toBe(false);
    const { accent: _accent, ...missing } = PALETTE;
    expect(isValidPalette(missing)).toBe(false);
  });
});
