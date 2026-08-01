/**
 * Saturated-salt reference (Greenspan 1977) — oracle tests.
 *
 * The polynomials in src/core/saltref.js are the paper's own Table 1
 * coefficients. These tests pin them to the paper's TABULATED values at three
 * temperatures per salt (0, 25, 50 °C — intercept, the universally cited
 * anchor, and the endpoint), so a transcription slip in any coefficient fails
 * loudly. Tolerance ±0.02 %RH: the tables are printed to two decimals, so the
 * polynomial and the table can differ by rounding alone, never more.
 */

import { describe, it, expect } from 'vitest';
import { SALTS, saltRh, SALT_T_MIN_C, SALT_T_MAX_C } from '../src/core/saltref.js';

/** Greenspan (1977), Table 2 — %RH at 0 / 25 / 50 °C per salt. */
const ORACLE = {
  licl: { 0: 11.23, 25: 11.3, 50: 11.1 },
  mgcl2: { 0: 33.66, 25: 32.78, 50: 30.54 },
  mgno32: { 0: 60.35, 25: 52.89, 50: 45.44 },
  nacl: { 0: 75.51, 25: 75.29, 50: 74.43 },
  kcl: { 0: 88.61, 25: 84.34, 50: 81.2 },
  k2so4: { 0: 98.77, 25: 97.3, 50: 95.82 },
};

describe('Greenspan saturated-salt fixed points', () => {
  it('reproduces the published table at 0, 25 and 50 °C for every salt', () => {
    for (const [id, points] of Object.entries(ORACLE)) {
      for (const [t, expected] of Object.entries(points)) {
        const r = saltRh(id, Number(t));
        expect(r, `${id} @ ${t}°C`).not.toBeNull();
        expect(Math.abs(r.rh - expected), `${id} @ ${t}°C: got ${r.rh.toFixed(3)}, table ${expected}`)
          .toBeLessThanOrEqual(0.02);
      }
    }
  });

  it('every salt is defined, uniquely identified, and carries an uncertainty', () => {
    const ids = SALTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(SALTS.length);
    for (const s of SALTS) {
      expect(s.u, `${s.id} uncertainty`).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(3);
      expect(s.poly.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('uncertainties are conservative: at least the cited 25 °C values', () => {
    // Greenspan's own 25 °C uncertainties — ours must never be tighter.
    const cited25 = { licl: 0.27, mgcl2: 0.16, mgno32: 0.22, nacl: 0.12, kcl: 0.26, k2so4: 0.45 };
    for (const [id, u25] of Object.entries(cited25)) {
      const salt = SALTS.find((s) => s.id === id);
      expect(salt.u, `${id}: conservative u must be ≥ the paper's 25 °C value`).toBeGreaterThanOrEqual(u25);
    }
  });

  it('curves are smooth and physically ordered across the validity window', () => {
    // The six salts never cross: their RH ordering is the same at every
    // temperature, which is what makes them usable as distinct fixed points.
    for (let t = SALT_T_MIN_C; t <= SALT_T_MAX_C; t += 1) {
      const values = SALTS.map((s) => saltRh(s.id, t).rh);
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `ordering @ ${t}°C: ${SALTS[i].id} vs ${SALTS[i - 1].id}`)
          .toBeGreaterThan(values[i - 1]);
      }
    }
  });

  it('refuses to extrapolate outside 0–50 °C and rejects unknown salts', () => {
    expect(saltRh('nacl', -1)).toBeNull();
    expect(saltRh('nacl', 51)).toBeNull();
    expect(saltRh('nacl', NaN)).toBeNull();
    expect(saltRh('kryptonite', 25)).toBeNull();
    expect(saltRh('nacl', 0)).not.toBeNull();
    expect(saltRh('nacl', 50)).not.toBeNull();
  });
});
