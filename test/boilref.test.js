/**
 * Boiling-point reference — steam-table oracle.
 *
 * boilingPointC inverts the ASHRAE Eq. 5 water-saturation curve, which lives
 * OUTSIDE the app's CoolProp-validated −20…55 °C core domain — so this module
 * gets its own oracle: standard IF-97 steam-table saturation points. Measured
 * agreement is within 0.023 °C over the whole window; the fixtures assert
 * ±0.05 °C so a regression is caught long before it could matter against the
 * ±0.5 °C practical uncertainty of a real field check.
 */

import { describe, it, expect } from 'vitest';
import {
  boilingPointC,
  U_EQUATION_C,
  U_PRACTICAL_C,
  BOIL_P_MIN_KPA,
  BOIL_P_MAX_KPA,
} from '../src/core/boilref.js';
import { pressureFromAltitude } from '../src/core/psychro.js';

/** IF-97 saturation temperatures (standard steam tables), °C at kPa. */
const STEAM_TABLE = [
  [60, 85.94],
  [70, 89.95],
  [80, 93.5],
  [90, 96.71],
  [100, 99.61],
  [101.325, 99.97],
];

describe('boiling-point reference', () => {
  it('matches IF-97 steam-table saturation points within ±0.05 °C', () => {
    for (const [p, tRef] of STEAM_TABLE) {
      const t = boilingPointC(p);
      expect(t, `${p} kPa`).not.toBeNull();
      expect(Math.abs(t - tRef), `${p} kPa: got ${t.toFixed(3)}, table ${tRef}`).toBeLessThanOrEqual(
        0.05,
      );
    }
  });

  it('is strictly increasing in pressure (more pressure, hotter boil)', () => {
    let prev = -Infinity;
    for (let p = BOIL_P_MIN_KPA; p <= BOIL_P_MAX_KPA; p += 1) {
      const t = boilingPointC(p);
      expect(t, `${p} kPa`).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('covers every site elevation the app itself supports', () => {
    // pressureFromAltitude spans the app's hall elevations (−1,000…15,000 ft
    // stays inside 55–110 kPa); the reference must answer for all of them.
    for (const ft of [-1000, 0, 1066, 5380, 10000, 15000]) {
      const p = pressureFromAltitude(ft);
      expect(p).toBeGreaterThanOrEqual(BOIL_P_MIN_KPA);
      expect(p).toBeLessThanOrEqual(BOIL_P_MAX_KPA);
      expect(boilingPointC(p), `${ft} ft`).not.toBeNull();
    }
  });

  it('declares honest uncertainties: practical dominates equation', () => {
    expect(U_EQUATION_C).toBeGreaterThan(0);
    expect(U_PRACTICAL_C).toBeGreaterThan(U_EQUATION_C);
  });

  it('refuses pressures outside the vouched window', () => {
    expect(boilingPointC(BOIL_P_MIN_KPA - 1)).toBeNull();
    expect(boilingPointC(BOIL_P_MAX_KPA + 1)).toBeNull();
    expect(boilingPointC(NaN)).toBeNull();
  });
});
