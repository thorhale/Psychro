/**
 * QR code encoder — self-contained, zero dependencies, byte mode, EC level M,
 * versions 1–10 (up to 213 payload bytes: ample for a scenario share-link).
 *
 * Written from the ISO/IEC 18004 structure rather than vendored, to keep the
 * repo's no-runtime-dependencies rule intact. Correctness is NOT taken on
 * faith: `test/qr.test.js` round-trips every version through an independent
 * decoder (jsqr, devDependency only) — a table slip anywhere in here fails
 * that oracle, exactly like the physics fails CoolProp.
 *
 *   qrMatrix(text)          → {size, get(x,y)}   modules as booleans
 *   drawQr(canvas, text, px) → renders with quiet zone (4 modules)
 */

// ── Capacity tables, EC level M ─────────────────────────────────────────────
// [totalCodewords, [count, totalPerBlock, dataPerBlock], ...blocks]
const BLOCKS_M = [
  null,
  [[1, 26, 16]],
  [[1, 44, 28]],
  [[1, 70, 44]],
  [[2, 50, 32]],
  [[2, 67, 43]],
  [[4, 43, 27]],
  [[4, 49, 31]],
  [[2, 60, 38], [2, 61, 39]],
  [[3, 58, 36], [2, 59, 37]],
  [[4, 69, 43], [1, 70, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataCapacityBytes = (v) => {
  const dataCW = BLOCKS_M[v].reduce((n, [c, , d]) => n + c * d, 0);
  return dataCW - (v <= 9 ? 2 : 3); // mode nibble + length field + terminator margin
};

// ── GF(256) arithmetic for Reed–Solomon ─────────────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reed–Solomon generator polynomial of degree n. */
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gmul(g[j], EXP[i]);
      next[j + 1] ^= g[j];
    }
    g = next;
  }
  return g.reverse(); // highest degree first
}

/** ECC codewords for a data block. */
function rsEncode(data, eccLen) {
  const gen = rsGenerator(eccLen);
  const rem = new Uint8Array(eccLen);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.copyWithin(0, 1);
    rem[eccLen - 1] = 0;
    if (factor) for (let i = 0; i < eccLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ── Bit assembly ────────────────────────────────────────────────────────────
class BitBuf {
  constructor() {
    this.bits = [];
  }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Build the final codeword stream (data + interleaved ECC) for a version. */
function buildCodewords(bytes, version) {
  const blocksDef = BLOCKS_M[version];
  const dataCW = blocksDef.reduce((n, [c, , d]) => n + c * d, 0);

  const bb = new BitBuf();
  bb.push(0b0100, 4); // byte mode
  bb.push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bb.push(b, 8);
  bb.push(0, Math.min(4, dataCW * 8 - bb.bits.length)); // terminator
  while (bb.bits.length % 8) bb.bits.push(0);
  const data = [];
  for (let i = 0; i < bb.bits.length; i += 8)
    data.push(bb.bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let pad = 0xec; data.length < dataCW; pad ^= 0xfd) data.push(pad); // EC 11 EC 11…

  // Split into blocks, compute ECC, interleave.
  const blocks = [];
  let off = 0;
  for (const [count, total, dlen] of blocksDef)
    for (let i = 0; i < count; i++) {
      const d = data.slice(off, off + dlen);
      off += dlen;
      blocks.push({ d, e: rsEncode(d, total - dlen) });
    }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  const eccLen = blocks[0].e.length;
  for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ── Matrix construction ─────────────────────────────────────────────────────
function placeFunctionPatterns(m, size, version) {
  const set = (x, y, v) => {
    m.mod[y * size + x] = v;
    m.fun[y * size + x] = 1;
  };
  const finder = (cx, cy) => {
    for (let dy = -1; dy <= 7; dy++)
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const on =
          dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        set(x, y, on ? 1 : 0);
      }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (!m.fun[6 * size + i]) set(i, 6, v);
    if (!m.fun[i * size + 6]) set(6, i, v);
  }
  // Alignment patterns: drawn at every grid position EXCEPT the three finder
  // corners. Centers on the timing row/column (e.g. (6,22) in v7) ARE drawn
  // and overwrite timing modules — the spec's precedence, and decoders sample
  // by them. (Skipping anything "already functional" was a real bug here:
  // harmless at v2–6 only because decoders are forgiving on clean images.)
  const pos = ALIGN[version];
  const last = pos.length - 1;
  pos.forEach((cy, i) =>
    pos.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1 ? 1 : 0);
    }),
  );
  // Reserve format-info areas (values written later) + the dark module.
  for (let i = 0; i < 9; i++) {
    if (!m.fun[8 * size + i]) set(i, 8, 0);
    if (!m.fun[i * size + 8]) set(8, i, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!m.fun[8 * size + (size - 1 - i)]) set(size - 1 - i, 8, 0);
    if (!m.fun[(size - 1 - i) * size + 8]) set(8, size - 1 - i, 0);
  }
  set(8, size - 8, 1); // dark module
  if (version >= 7) {
    const vi = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vi >>> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
}

/** BCH-protected 18-bit version information (versions ≥ 7). */
function versionInfoBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** BCH-protected 15-bit format information for EC-M + mask. */
function formatInfoBits(mask) {
  const data = (0b00 << 3) | mask; // EC level M = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function placeData(m, size, codewords) {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (m.fun[y * size + x]) continue;
        const bit = bitIdx < totalBits ? (codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1 : 0;
        m.mod[y * size + x] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, size, mask) {
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (!m.fun[y * size + x] && MASKS[mask](x, y)) m.mod[y * size + x] ^= 1;
}

function writeFormatInfo(m, size, mask) {
  const bits = formatInfoBits(mask);
  const b = (i) => (bits >>> i) & 1;
  // Around the top-left finder.
  const coordsA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  coordsA.forEach(([x, y], i) => {
    m.mod[y * size + x] = b(14 - i);
  });
  // Split copy: below top-right finder and right of bottom-left finder.
  for (let i = 0; i < 8; i++) m.mod[8 * size + (size - 1 - i)] = b(i);
  for (let i = 8; i < 15; i++) m.mod[(size - 15 + i) * size + 8] = b(i);
  m.mod[(size - 8) * size + 8] = 1; // dark module stays dark
}

/** Standard four-rule mask penalty (lower is better). */
function penalty(m, size) {
  const at = (x, y) => m.mod[y * size + x];
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    // Rule 1: runs ≥5; Rule 3: finder-like 1011101 with 4-light flank.
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = pass ? at(a, b) : at(b, a);
        const prev = pass ? at(a, b - 1) : at(b - 1, a);
        if (cur === prev) {
          run++;
          if (b === size - 1 && run >= 5) score += run - 2;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      for (let b = 0; b + 11 <= size; b++) {
        const bit = (i) => (pass ? at(a, b + i) : at(b + i, a));
        const pat = [1, 0, 1, 1, 1, 0, 1];
        const fw = pat.every((v, i) => bit(i) === v) && [7, 8, 9, 10].every((i) => bit(i) === 0);
        const bw = pat.every((v, i) => bit(4 + i) === v) && [0, 1, 2, 3].every((i) => bit(i) === 0);
        if (fw || bw) score += 40;
      }
    }
  }
  // Rule 2: 2×2 blocks.
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++)
      if (at(x, y) === at(x + 1, y) && at(x, y) === at(x, y + 1) && at(x, y) === at(x + 1, y + 1))
        score += 3;
  // Rule 4: dark-module balance.
  const dark = m.mod.reduce((n, v) => n + v, 0);
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * Encode text (UTF-8) as a QR module matrix, EC level M, auto version 1–10.
 * @returns {{size:number, get:(x:number,y:number)=>number, version:number}}
 */
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++)
    if (bytes.length <= dataCapacityBytes(v)) {
      version = v;
      break;
    }
  if (!version) throw new Error(`QR payload too long: ${bytes.length} bytes (max ${dataCapacityBytes(10)})`);

  const size = 17 + 4 * version;
  const codewords = buildCodewords(bytes, version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = { mod: new Uint8Array(size * size), fun: new Uint8Array(size * size) };
    placeFunctionPatterns(m, size, version);
    placeData(m, size, codewords);
    applyMask(m, size, mask);
    writeFormatInfo(m, size, mask);
    const p = penalty(m, size);
    if (!best || p < best.p) best = { m, p };
  }
  const { m } = best;
  return { size, version, get: (x, y) => m.mod[y * size + x] };
}

/**
 * Render a QR for `text` onto a canvas, dark-on-light with the standard
 * 4-module quiet zone (the light border is part of the spec — scanners rely
 * on it, so the canvas paints it rather than trusting the page background).
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {number} [scale] pixels per module
 */
export function drawQr(canvas, text, scale = 4) {
  const q = qrMatrix(text);
  const quiet = 4;
  const px = (q.size + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++)
      if (q.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
  return q;
}
