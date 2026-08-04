/**
 * Every conversion constant, derived from its definition and checked.
 *
 * These numbers are typed once and then trusted forever by code that has no
 * way to notice a wrong digit: a mistyped ton-to-kilowatt factor produces
 * plausible cooling capacities that are simply wrong, and no test that only
 * compares the app to itself would ever catch it.
 *
 * So each constant below is rebuilt here from EXACT SI definitions — the
 * international foot, the pound, the thermochemical/IT BTU, the ton of
 * refrigeration — and compared against what the app actually uses. The
 * tolerance on each says how much rounding the shipped value is allowed.
 *
 * Sources, all exact by definition unless noted:
 *   1 in      = 25.4 mm                     (international yard & pound, 1959)
 *   1 lb      = 0.45359237 kg               (ibid.)
 *   1 BTU_IT  = 1055.05585262 J             (ISO 31-4 / IT calorie)
 *   1 ton ref = 12 000 BTU_IT/hr            (ASHRAE)
 *   1 inHg    = 3386.389 Pa at 0 °C         (NIST SP 811)
 */

import { describe, it, expect } from 'vitest';
import {
  ftToM, mToFt, ft3ToM3, lbToKg, kgToLb, kPaToInHg, cfmToM3s,
  THERMAL_TO_KW, WATER_TO_LBHR, AIR_TO_CFM, LATENT_BTU_PER_LB,
  fToC, cToF,
} from '../src/core/units.js';

// ── Exact definitions ───────────────────────────────────────────────────────
const M_PER_FT = 0.3048; //                 exact: 12 × 25.4 mm
const M3_PER_FT3 = M_PER_FT ** 3; //        exact: 0.028316846592
const KG_PER_LB = 0.45359237; //            exact
const J_PER_BTU = 1055.05585262; //         exact (IT)
const W_PER_TON = (12000 * J_PER_BTU) / 3600; // 3516.8528…
const PA_PER_INHG = 3386.389;

/** Relative difference, for tolerances stated as "parts per". */
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

describe('length, volume and mass', () => {
  it('the foot and its cube are the international definitions', () => {
    expect(ftToM(1)).toBe(M_PER_FT); //     exact, not rounded
    expect(mToFt(M_PER_FT)).toBeCloseTo(1, 12);
    // ft3ToM3 ships a 6-digit value; the truncation must stay under 1 ppm so
    // a 200 000 ft³ hall's air mass is right to well under a kilogram.
    expect(rel(ft3ToM3(1), M3_PER_FT3)).toBeLessThan(2e-6);
  });

  it('the pound round-trips exactly', () => {
    expect(lbToKg(1)).toBe(KG_PER_LB);
    expect(kgToLb(lbToKg(12345.678))).toBeCloseTo(12345.678, 9);
  });

  it('inches of mercury match the NIST value', () => {
    // kPaToInHg(1) should be 1000 Pa ÷ 3386.389 Pa/inHg.
    expect(rel(kPaToInHg(1), 1000 / PA_PER_INHG)).toBeLessThan(3e-5);
  });
});

describe('airflow', () => {
  it('CFM → m³/s is the cubic foot over sixty seconds', () => {
    expect(rel(cfmToM3s(1), M3_PER_FT3 / 60)).toBeLessThan(2e-6);
  });

  it('every airflow unit lands on CFM correctly', () => {
    const CFM_PER_M3S = 60 / M3_PER_FT3; //  2118.88…
    expect(AIR_TO_CFM.cfm).toBe(1);
    // 1 m³/hr = (1/3600) m³/s
    expect(rel(AIR_TO_CFM.m3h, CFM_PER_M3S / 3600)).toBeLessThan(2e-6);
    // 1 m³/min = (1/60) m³/s
    expect(rel(AIR_TO_CFM.cmm, CFM_PER_M3S / 60)).toBeLessThan(2e-6);
    // 1 L/s = 0.001 m³/s
    expect(rel(AIR_TO_CFM.lps, CFM_PER_M3S / 1000)).toBeLessThan(2e-6);
    // Internally consistent: a cubic metre a minute is sixty an hour.
    expect(AIR_TO_CFM.cmm / AIR_TO_CFM.m3h).toBeCloseTo(60, 4);
    // …and a litre a second is 3.6 m³/hr.
    expect(AIR_TO_CFM.lps / AIR_TO_CFM.m3h).toBeCloseTo(3.6, 4);
  });
});

describe('thermal capacity', () => {
  it('a ton of refrigeration is 12 000 BTU/hr', () => {
    expect(THERMAL_TO_KW.kw).toBe(1);
    expect(rel(THERMAL_TO_KW.ton, W_PER_TON / 1000)).toBeLessThan(1e-6);
  });

  it('BTU/hr and MBH agree with the IT BTU', () => {
    const KW_PER_BTUH = J_PER_BTU / 3600 / 1000; //  1 BTU/hr in kW
    expect(rel(THERMAL_TO_KW.btu, KW_PER_BTUH)).toBeLessThan(1e-6);
    // MBH is a THOUSAND BTU/hr — the classic trap is treating it as one.
    expect(rel(THERMAL_TO_KW.mbh, 1000 * KW_PER_BTUH)).toBeLessThan(1e-6);
    expect(THERMAL_TO_KW.mbh / THERMAL_TO_KW.btu).toBeCloseTo(1000, 6);
    // And a ton is 12 MBH.
    expect(THERMAL_TO_KW.ton / THERMAL_TO_KW.mbh).toBeCloseTo(12, 4);
  });
});

describe('water output', () => {
  // Water's density is temperature-dependent, so 8.34 lb/gal is a nominal
  // figure (it is exact near 17 °C). Anything a humidifier is rated at
  // carries more uncertainty than this does.
  const LB_PER_GAL = 8.34;

  it('gallons and pints reduce to the same pound', () => {
    expect(WATER_TO_LBHR.lbhr).toBe(1);
    expect(WATER_TO_LBHR.gph).toBe(LB_PER_GAL);
    expect(WATER_TO_LBHR.gpd).toBeCloseTo(LB_PER_GAL / 24, 12); //   per day
    expect(WATER_TO_LBHR.pintday).toBeCloseTo(LB_PER_GAL / 8 / 24, 12); // 8 pints/gal
    // Internal consistency, which is what a typo would break.
    expect(WATER_TO_LBHR.gph / WATER_TO_LBHR.gpd).toBeCloseTo(24, 9);
    expect(WATER_TO_LBHR.gpd / WATER_TO_LBHR.pintday).toBeCloseTo(8, 9);
  });

  it('the nominal gallon is within a percent of real water', () => {
    // 1 US gal = 231 in³ exactly; water at 20 °C is 998.2 kg/m³.
    const GAL_M3 = 231 * (0.0254 ** 3);
    const realLb = (GAL_M3 * 998.2) / KG_PER_LB;
    expect(rel(LB_PER_GAL, realLb)).toBeLessThan(0.01);
  });

  it('latent heat of vaporization is a sane coil figure', () => {
    // ~1060 BTU/lb near typical coil temperatures; the true value runs
    // 1075 at 32 °F to 1054 at 100 °F, so this is mid-range, not exact.
    expect(LATENT_BTU_PER_LB).toBeGreaterThan(1040);
    expect(LATENT_BTU_PER_LB).toBeLessThan(1080);
  });
});

describe('temperature', () => {
  it('the fixed points are exact', () => {
    expect(fToC(32)).toBe(0);
    expect(fToC(212)).toBe(100);
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(fToC(-40)).toBeCloseTo(-40, 12); // the crossing point
  });

  it('round-trips without drift over the working range', () => {
    for (let f = -60; f <= 250; f += 0.5) {
      expect(cToF(fToC(f))).toBeCloseTo(f, 9);
    }
  });
});
