/**
 * QR encoder — round-trip oracle against an independent decoder.
 *
 * The encoder is hand-written (repo rule: zero runtime dependencies), so its
 * correctness is proven the same way the physics is: against an independent
 * implementation. jsqr (devDependency only) decodes real camera frames in
 * production apps; if it reads back exactly what we encoded, the format
 * tables, Reed–Solomon math, masking and format bits are all right — any slip
 * anywhere breaks the round trip loudly.
 */

import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix } from '../src/lib/qr.js';

/** Rasterize a matrix to RGBA the way a camera would see it (with quiet zone). */
function rasterize(q, scale = 4) {
  const quiet = 4;
  const px = (q.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < q.size; y++)
    for (let x = 0; x < q.size; x++) {
      if (!q.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { data, px };
}

function roundTrip(text) {
  const q = qrMatrix(text);
  const { data, px } = rasterize(q);
  const decoded = jsQR(data, px, px);
  return { q, decoded };
}

describe('QR encoder', () => {
  it('round-trips a realistic scenario share-link', () => {
    const url = 'https://thorhale.github.io/Psychro/#v=1&a=68,45&b=75,35&u=F&elev=1066&sla=Base%20SLA';
    const { decoded } = roundTrip(url);
    expect(decoded).not.toBeNull();
    expect(decoded.data).toBe(url);
  });

  it('round-trips at every version 1–10 (each capacity table row proven)', () => {
    // Payload sized to force each version; a table error in any row fails here.
    const targets = [10, 20, 40, 60, 80, 100, 120, 150, 175, 210];
    const seen = new Set();
    for (const n of targets) {
      const text = 'Q'.repeat(n);
      const { q, decoded } = roundTrip(text);
      seen.add(q.version);
      expect(decoded, `version ${q.version} (${n} bytes)`).not.toBeNull();
      expect(decoded.data, `version ${q.version}`).toBe(text);
    }
    // The ten payloads must actually have exercised all ten versions.
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('round-trips UTF-8 beyond ASCII', () => {
    const text = 'Hall 2 · 20 °C → 24 °C · ΔW −1.3 g/kg';
    const { decoded } = roundTrip(text);
    expect(decoded).not.toBeNull();
    expect(decoded.data).toBe(text);
  });

  it('refuses payloads beyond version 10 instead of silently truncating', () => {
    expect(() => qrMatrix('x'.repeat(214))).toThrow(/too long/);
    expect(() => qrMatrix('x'.repeat(213))).not.toThrow();
  });

  it('survives fuzzed printable payloads (seeded)', () => {
    let s = 0xc0ffee;
    const rand = () => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 25; i++) {
      const len = 1 + Math.floor(rand() * 200);
      const text = Array.from({ length: len }, () => String.fromCharCode(32 + Math.floor(rand() * 95))).join('');
      const { decoded } = roundTrip(text);
      expect(decoded, `fuzz #${i} len ${len}`).not.toBeNull();
      expect(decoded.data, `fuzz #${i}`).toBe(text);
    }
  });
});
