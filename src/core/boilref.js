/**
 * Boiling-point temperature reference, corrected for site pressure.
 *
 * Water boils where its saturation pressure equals the ambient pressure — so
 * at altitude it boils measurably below 100 °C, and since this app already
 * knows the site pressure, a pot of boiling water becomes a temperature
 * reference for checking a sensor. (The companion 0 °C ice-point check needs
 * no computation at all.)
 *
 * Physics: Newton inversion of the ASHRAE Eq. 5 (Hyland–Wexler) saturation
 * curve, whose published validity is 0–200 °C — comfortably covering boiling
 * at any survivable site pressure. This is deliberately OUTSIDE the app's
 * CoolProp-validated core domain (−20…55 °C), so this module carries its own
 * oracle: `test/boilref.test.js` pins the inversion against standard IF-97
 * steam-table saturation points, where it agrees within 0.023 °C across
 * 60–101.325 kPa.
 *
 * Uncertainty, honestly stated: the EQUATION is good to ~±0.05 °C here, but a
 * field boiling check is limited by technique — dissolved solids raise the
 * boiling point, the pot superheats near the element, and a probe touching
 * metal reads the pot, not the water. `U_PRACTICAL_C` reflects that and is
 * what verdicts use; the UI says why.
 */

import { satPressureWater } from './psychro.js';

/** Equation-level agreement with IF-97 steam tables over 60–101.325 kPa, °C. */
export const U_EQUATION_C = 0.05;

/** Field-technique uncertainty for a real boiling check, °C (impurities,
 *  superheat, probe placement — dominates the equation error). */
export const U_PRACTICAL_C = 0.5;

/** Pressure window we vouch for: spans every site the app itself supports. */
export const BOIL_P_MIN_KPA = 55;
export const BOIL_P_MAX_KPA = 110;

/**
 * Boiling temperature of pure water at a total pressure.
 *
 * @param {number} pKpa site pressure, kPa
 * @returns {number|null} °C, or null outside the vouched pressure window
 */
export function boilingPointC(pKpa) {
  if (!isFinite(pKpa) || pKpa < BOIL_P_MIN_KPA || pKpa > BOIL_P_MAX_KPA) return null;
  let t = 100;
  for (let i = 0; i < 60; i++) {
    const f = satPressureWater(t) - pKpa;
    const d = (satPressureWater(t + 1e-4) - satPressureWater(t - 1e-4)) / 2e-4;
    const step = f / d;
    t -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  return t;
}
