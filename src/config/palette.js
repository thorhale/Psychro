/**
 * Palette derivation — from pixels to a brand.
 *
 * ONE implementation, two callers: `scripts/sample-brand-colors.mjs` feeds it
 * pixels it decoded from the committed artwork at build time, and the in-app
 * Branding card feeds it pixels a canvas decoded from an uploaded logo at
 * runtime. The derivation living here, once, is what guarantees the button in
 * the app and the script in the repo cannot disagree about what a logo's
 * palette is.
 *
 * Everything here is pure: RGBA bytes in, hex strings out, no DOM and no fs.
 */

/** #rrggbb from 0–255 channels. */
export const hexOf = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Perceived lightness, 0–1 (Rec. 709 luma). */
export const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Saturation in HSL terms, 0–1. */
export function sat(r, g, b) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

/** Mix toward black (t<0) or white (t>0). */
export function shade(rgb, t) {
  const to = t < 0 ? [0, 0, 0] : [255, 255, 255];
  const k = Math.abs(t);
  const [r, g, b] = rgb.map((v, i) => v + (to[i] - v) * k);
  return /** @type {[number, number, number]} */ ([r, g, b]);
}

/** RGB 0–255 → HSL, h in degrees. */
export function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const l = (mx + mn) / 2;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0))
    : mx === g ? (b - r) / d + 2
    : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** HSL → RGB 0–255. */
export function toRgb([h, s, l]) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/**
 * The colours a mark actually uses, ignoring the paper it sits on.
 *
 * Near-white and near-black are excluded: every logo has a background and an
 * outline, and neither is the brand. Colours are bucketed at 16 levels per
 * channel so anti-aliasing along an edge counts toward the solid it belongs
 * to rather than inventing dozens of near-duplicates.
 *
 * @param {Uint8Array|Uint8ClampedArray} px RGBA bytes
 */
export function dominantColors(px) {
  const buckets = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b, a] = [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (a < 200) continue;
    const l = luma(r, g, b);
    if (l > 0.92 || l < 0.06) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += r; e.g += g; e.b += b;
    buckets.set(key, e);
  }
  return [...buckets.values()]
    .sort((x, y) => y.n - x.n)
    .map((e) => ({
      n: e.n,
      rgb: /** @type {[number, number, number]} */ ([e.r / e.n, e.g / e.n, e.b / e.n]),
      hex: hexOf(e.r / e.n, e.g / e.n, e.b / e.n),
      luma: luma(e.r / e.n, e.g / e.n, e.b / e.n),
      sat: sat(e.r / e.n, e.g / e.n, e.b / e.n),
    }));
}

/**
 * A five-colour palette from a pool of dominant colours.
 *
 * The primary is the most-used colour with real saturation — the mark's solid,
 * not its shadow. The accent is DERIVED rather than sampled: the primary's hue
 * rotated toward cyan (≈190°, the direction that reads as "live" beside a
 * corporate navy), then pinned to a fixed saturation and lightness so a logo
 * in ANY hue still yields something legible on a dark interface. The app's
 * contrast must not depend on the artwork's.
 *
 * @param {ReturnType<typeof dominantColors>} pool
 * @returns {{primary:string, primaryDark:string, primaryLight:string,
 *            accent:string, accentDark:string}|null} null for an empty pool
 *   (an all-white or all-black image has no brand in it to find)
 */
export function derivePalette(pool) {
  const primary = pool.find((c) => c.sat > 0.15) || pool[0];
  if (!primary) return null;
  const [pH] = toHsl(primary.rgb);
  const CYAN = 190;
  const toward = (from, to, by) => from + Math.sign(to - from) * Math.min(by, Math.abs(to - from));
  const accent = toRgb([toward(pH, CYAN, 40), 0.85, 0.42]);
  return {
    primary: primary.hex,
    primaryDark: hexOf(...shade(primary.rgb, -0.34)),
    primaryLight: hexOf(...shade(primary.rgb, 0.22)),
    accent: hexOf(...accent),
    accentDark: hexOf(...shade(accent, -0.3)),
  };
}

/** True for a plausible palette object — five #rrggbb strings, nothing else. */
export function isValidPalette(p) {
  if (!p || typeof p !== 'object') return false;
  const keys = ['primary', 'primaryDark', 'primaryLight', 'accent', 'accentDark'];
  return keys.every((k) => typeof p[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p[k]));
}
