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
import { dominantColors, derivePalette } from '../src/config/palette.js';
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
// Lives in src/config/palette.js, shared with the in-app Branding card, so the
// button in the app and this script cannot disagree about what a logo's
// palette is. This file keeps only what the browser gets for free from a
// canvas: PNG decoding.

const all = [];
for (const rel of SOURCES) {
  try {
    const { width, height, px } = decodePng(readFileSync(join(root, rel)));
    const top = dominantColors(px);
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

const palette = derivePalette(all.flatMap((s) => s.top));
if (!palette) {
  console.error('The artwork holds no colour to build a brand from.');
  process.exit(1);
}

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
