#!/usr/bin/env node
/**
 * Sample a brand palette straight out of the logo files.
 *
 *   npm run brand:sample                 # report what the images contain
 *   npm run brand:sample -- --write      # …and rewrite src/config/brand.js
 *
 * Swapping the branding should mean dropping new artwork in and re-running
 * this, not hunting hex codes through stylesheets. That only works if the
 * palette is DERIVED from the artwork rather than typed next to it, which is
 * what this does.
 *
 * PNG decoding is hand-rolled on node:zlib — the project carries no runtime
 * dependencies and this is not a good enough reason to start.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Artwork to sample, most authoritative first. */
const SOURCES = ['assets/icon-only.png', 'assets/icon-foreground.png', 'assets/splash.png'];

// ── PNG → pixels ────────────────────────────────────────────────────────────

/** Undo a scanline filter in place. PNG spec §9.2. */
function unfilter(type, line, prev, bpp) {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= bpp && prev ? prev[i - bpp] : 0;
    let x = line[i];
    if (type === 1) x += a;
    else if (type === 2) x += b;
    else if (type === 3) x += (a + b) >> 1;
    else if (type === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[i] = x & 0xff;
  }
  return line;
}

/**
 * Decode a PNG into RGBA pixels.
 * @returns {{width:number, height:number, px:Uint8Array}}
 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, colorType = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const px = new Uint8Array(width * height * 4);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const line = unfilter(raw[off], raw.subarray(off + 1, off + 1 + stride), prev, bpp);
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4;
      if (colorType === 3) {
        const i = line[s] * 3;
        px[d] = palette[i]; px[d + 1] = palette[i + 1]; px[d + 2] = palette[i + 2];
        px[d + 3] = trns && line[s] < trns.length ? trns[line[s]] : 255;
      } else if (colorType === 0 || colorType === 4) {
        px[d] = px[d + 1] = px[d + 2] = line[s];
        px[d + 3] = colorType === 4 ? line[s + 1] : 255;
      } else {
        px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2];
        px[d + 3] = colorType === 6 ? line[s + 3] : 255;
      }
    }
    prev = line;
  }
  return { width, height, px };
}

// ── Colour analysis ─────────────────────────────────────────────────────────

const hex = (r, g, b) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Perceived lightness, 0–1 (Rec. 709 luma). */
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Saturation in HSL terms, 0–1. */
function sat(r, g, b) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  if (mx === mn) return 0;
  const l = (mx + mn) / 2;
  return l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
}

/** Mix toward black (t<0) or white (t>0). */
function shade(rgb, t) {
  const to = t < 0 ? [0, 0, 0] : [255, 255, 255];
  const k = Math.abs(t);
  return rgb.map((v, i) => v + (to[i] - v) * k);
}

/** RGB 0–255 → HSL, h in degrees. */
function toHsl([r, g, b]) {
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
function toRgb([h, s, l]) {
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
 * The colours a brand actually uses, ignoring the paper it sits on.
 *
 * Near-white and near-black are excluded: every logo has a background and an
 * outline, and neither is the brand. Colours are bucketed at 16 levels per
 * channel so anti-aliasing along an edge counts toward the solid it belongs
 * to rather than inventing dozens of near-duplicates.
 */
function dominant(px) {
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
      rgb: [e.r / e.n, e.g / e.n, e.b / e.n],
      hex: hex(e.r / e.n, e.g / e.n, e.b / e.n),
      luma: luma(e.r / e.n, e.g / e.n, e.b / e.n),
      sat: sat(e.r / e.n, e.g / e.n, e.b / e.n),
    }));
}

// ── Build the palette ───────────────────────────────────────────────────────

const all = [];
for (const rel of SOURCES) {
  try {
    const { width, height, px } = decodePng(readFileSync(join(root, rel)));
    const top = dominant(px);
    all.push({ rel, width, height, top });
  } catch (e) {
    console.error(`  skip ${rel}: ${e.message}`);
  }
}
if (!all.length) {
  console.error('No artwork could be read — nothing to sample.');
  process.exit(1);
}

console.log('Sampled from:');
for (const s of all) {
  console.log(`  ${s.rel} (${s.width}×${s.height})`);
  for (const c of s.top.slice(0, 4)) {
    console.log(
      `      ${c.hex}  ${String(c.n).padStart(8)} px  luma ${c.luma.toFixed(2)}  sat ${c.sat.toFixed(2)}`,
    );
  }
}

// The primary is the most-used colour with real saturation — a brand mark's
// solid, not its shadow. Falls back to the most-used colour of any kind.
const pool = all.flatMap((s) => s.top);
const primary = pool.find((c) => c.sat > 0.15) || pool[0];

// The accent is the app's interactive colour — links, focus rings, the active
// series on the chart. A mark this simple carries a single hue, so the accent
// is DERIVED from it rather than invented: rotated toward cyan (the direction
// that reads as "live" beside a corporate navy), then pinned to a saturation
// and lightness that stay legible on the dark interface. Fixing S and L rather
// than nudging the sampled values is deliberate — it means a future logo in
// any hue still yields a usable accent instead of, say, an unreadable dark
// brown, and the app's contrast does not depend on the artwork's.
// Toward cyan means DOWN the wheel from a blue mark (≈220°) and up from a
// warm one, so the rotation is taken toward 190° rather than added blindly —
// +30° off navy lands in violet, which reads as a second brand, not an accent.
const [pH] = toHsl(primary.rgb);
const CYAN = 190;
const toward = (from, to, by) => from + Math.sign(to - from) * Math.min(by, Math.abs(to - from));
const accent = toRgb([toward(pH, CYAN, 40), 0.85, 0.42]);

const palette = {
  primary: primary.hex,
  primaryDark: hex(...shade(primary.rgb, -0.34)),
  primaryLight: hex(...shade(primary.rgb, 0.22)),
  accent: hex(...accent),
  accentDark: hex(...shade(accent, -0.3)),
};

console.log('\nPalette:');
for (const [k, v] of Object.entries(palette)) console.log(`  ${k.padEnd(13)} ${v}`);

if (!process.argv.includes('--write')) {
  console.log('\n(run with --write to update src/config/brand.js)');
  process.exit(0);
}

const target = join(root, 'src/config/brand.js');
const src = readFileSync(target, 'utf8');
const patched = src.replace(
  /(\/\* SAMPLED:start \*\/)[\s\S]*?(\/\* SAMPLED:end \*\/)/,
  `$1\n${Object.entries(palette)
    .map(([k, v]) => `  ${k}: '${v}',`)
    .join('\n')}\n  $2`,
);
if (patched === src) {
  console.error('\nCould not find the SAMPLED markers in src/config/brand.js.');
  process.exit(1);
}
writeFileSync(target, patched);
console.log(`\nwrote ${palette.primary} + ${palette.accent} into src/config/brand.js`);
