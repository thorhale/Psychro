/**
 * Accuracy oracle: every core property asserted against the committed CoolProp
 * (ASHRAE RP-1485) reference grid, plus the classic ASHRAE Fundamentals table
 * checks migrated from the v1 in-app self-test.
 *
 * Tolerances are per-property and deliberately documented here — they are the
 * numbers quoted in docs/coolprop-comparison.md. If a change trips one, either
 * the change is wrong or the doc needs updating; both deserve a human look.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  pressureFromAltitude,
  satPressure,
  humidityRatio,
  humidityRatioG,
  enthalpy,
  specificVolume,
  moistAirDensity,
  dewPoint,
  dewPointFrom,
  wetBulb,
  wetBulbSolve,
  wetBulbRoots,
  rhFromWetBulb,
  entropy,
  viscosity,
  thermalConductivity,
  degreeOfSaturation,
  rhFromW,
  rhFromPsychrometer,
} from '../src/core/psychro.js';
import { CORE_DOMAIN } from '../src/core/domain.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'reference', 'coolprop-reference.json'), 'utf8'));
const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));
const core = ref.rows.filter((r) => r[col.core] === 1);

/** Per-property tolerance vs CoolProp over the core operating domain. */
const TOL = {
  w_rel: 2e-5, //      humidity ratio, relative  (measured max 1.3e-5)
  h_abs: 0.05, //      enthalpy kJ/kg            (real-gas fit; measured max 0.031)
  v_rel: 2e-4, //      specific volume, relative (Z-corrected; measured max 1.15e-4)
  rho_rel: 2e-4, //    density, relative         (follows v; measured max 1.15e-4)
  // Dew point solves its real definition — Ws(tdp, p) = W — rather than
  // inverting the saturation curve alone, which drops the enhancement factor.
  // Loosening this toward 0.03 means someone has reverted that.
  tdp_abs: 1e-3, //    dew point °C              (measured max 3.8e-4)
  // Wet bulb is solved as a real-gas adiabatic-saturation energy balance, not
  // by ASHRAE Eq. 35's ideal-gas closed form, so the tolerance is two orders
  // tighter than a Eq. 35 solver could hold. Loosening this back toward 0.05
  // means someone has reverted the balance to the ideal-gas one.
  twb_abs: 3e-3, //    wet bulb °C, unambiguous points (measured max 1.6e-3)
  twb_amb_abs: 1.0, // wet bulb °C, flagged near-freezing ambiguity (max 0.85).
  //                   Not an accuracy figure: both wick states are physical
  //                   and this solver reproduces WHICHEVER root CoolProp
  //                   reports to 4e-4 °C — see twb_amb_bestof below.
  twb_amb_bestof: 1e-3, // closer of the two roots, vs CoolProp (measured 4e-4)
  s_abs: 5e-4, //      entropy kJ/(kg·K)         (measured max 3.7e-4)
  // Transport properties were 5e-3 / 6e-3 while the components were Sutherland
  // two-parameter forms. Refitting them (degree-4 components plus a pressure
  // and composition closure term) moved both into the same accuracy class as
  // specific volume, so the tolerances follow the measurement down — a loose
  // tolerance over an accurate fit hides the next regression.
  mu_rel: 2e-4, //     viscosity, relative       (measured max 1.27e-4)
  k_rel: 3e-4, //      conductivity, relative    (measured max 1.90e-4)
};

describe('CoolProp oracle grid', () => {
  it('covers the declared core domain and stays in sync with domain.js', () => {
    expect(ref.core_domain.t_c).toEqual([CORE_DOMAIN.tMinC, CORE_DOMAIN.tMaxC]);
    expect(ref.core_domain.p_kpa).toEqual([CORE_DOMAIN.pMinKpa, CORE_DOMAIN.pMaxKpa]);
    expect(ref.core_domain.w_max_kgkg).toBe(CORE_DOMAIN.wMaxKgKg);
    expect(core.length).toBeGreaterThan(3000);
  });

  it('humidity ratio within tolerance at every core point', () => {
    for (const r of core) {
      const ours = humidityRatio(r[col.t_c], r[col.rh_pct], r[col.p_kpa]);
      const theirs = r[col.w];
      if (theirs < 1e-6) continue; // relative error meaningless at ~zero
      expect(Math.abs(ours - theirs) / theirs, `W at ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toBeLessThan(TOL.w_rel);
    }
  });

  it('enthalpy within tolerance at every core point', () => {
    for (const r of core) {
      const W = humidityRatio(r[col.t_c], r[col.rh_pct], r[col.p_kpa]);
      const ours = enthalpy(r[col.t_c], W, r[col.p_kpa]);
      expect(Math.abs(ours - r[col.h_kjkg]), `h at ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toBeLessThan(TOL.h_abs);
    }
  });

  it('specific volume and density within tolerance at every core point', () => {
    for (const r of core) {
      const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
      const W = humidityRatio(t, rh, p);
      const v = specificVolume(t, W, p);
      expect(Math.abs(v - r[col.v_m3kg]) / r[col.v_m3kg], `v at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.v_rel);
      const rho = moistAirDensity(t, rh, p);
      expect(Math.abs(rho - r[col.rho_kgm3]) / r[col.rho_kgm3], `ρ at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.rho_rel);
    }
  });

  it('dew point within tolerance at every core point', () => {
    for (const r of core) {
      const ours = dewPointFrom(r[col.t_c], r[col.rh_pct], r[col.p_kpa]);
      expect(ours).not.toBeNull();
      expect(Math.abs(ours - r[col.tdp_c]), `Tdp at ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toBeLessThan(TOL.tdp_abs);
    }
  });

  it('wet bulb within tolerance, with the near-freezing ambiguity flagged not silent', () => {
    let ambiguous = 0;
    for (const r of core) {
      if (r[col.twb_c] === null) continue;
      const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
      const s = wetBulbSolve(t, rh, p);
      const err = Math.abs(s.value - r[col.twb_c]);
      if (s.ambiguous) {
        ambiguous++;
        expect(err, `ambiguous Twb at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.twb_amb_abs);
        // The real claim about this band. Both wick states are physical, and
        // CoolProp's iterative solver lands in whichever basin its initial
        // guess falls into — so "which root" is not an accuracy question. What
        // IS an accuracy question is whether we can compute the root it picked,
        // and the answer must stay 4e-4 °C. If this ever loosens, the solver
        // has genuinely lost precision rather than merely chosen a wick.
        const both = wetBulbRoots(t, rh, p);
        const best = Math.min(...both.map((v) => Math.abs(v - r[col.twb_c])));
        expect(best, `neither root reproduces CoolProp at ${t}°C ${rh}% ${p}kPa`)
          .toBeLessThan(TOL.twb_amb_bestof);
      } else {
        expect(s.converged, `Twb convergence at ${t}°C ${rh}% ${p}kPa`).toBe(true);
        expect(err, `Twb at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.twb_abs);
      }
    }
    // The flag must actually fire on the near-freezing band — if it never does,
    // the branch logic has been broken, not improved.
    expect(ambiguous).toBeGreaterThan(0);
    expect(ambiguous).toBeLessThan(60);
  });

  it('entropy within tolerance at every core point', () => {
    for (const r of core) {
      const ours = entropy(r[col.t_c], r[col.rh_pct], r[col.p_kpa]);
      expect(Math.abs(ours - r[col.s_kjkgk]), `s at ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toBeLessThan(TOL.s_abs);
    }
  });

  it('transport properties within their (looser) engineering tolerance', () => {
    for (const r of core) {
      const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
      const mu = viscosity(t, rh, p);
      expect(Math.abs(mu - r[col.mu_pas]) / r[col.mu_pas], `μ at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.mu_rel);
      const k = thermalConductivity(t, rh, p);
      expect(Math.abs(k - r[col.k_wmk]) / r[col.k_wmk], `k at ${t}°C ${rh}% ${p}kPa`).toBeLessThan(TOL.k_rel);
    }
  });
});

describe('ASHRAE Fundamentals table checks (migrated from the v1 self-test)', () => {
  const near = (got, want, tol) => expect(Math.abs(got - want)).toBeLessThan(tol);

  it('saturation pressure vs Table 2', () => {
    near(satPressure(0), 0.6112, 0.001);
    near(satPressure(10), 1.228, 0.002);
    near(satPressure(20), 2.3388, 0.003);
    near(satPressure(25), 3.1692, 0.003);
    near(satPressure(40), 7.3835, 0.006);
    near(satPressure(-10), 0.2599, 0.001);
  });

  it('pressure vs altitude, Table 1', () => {
    near(pressureFromAltitude(0), 101.325, 0.01);
    near(pressureFromAltitude(3280.84), 89.875, 0.05);
    near(pressureFromAltitude(6561.68), 79.495, 0.05);
  });

  it('saturation humidity ratio (RP-1485 corrected values)', () => {
    near(humidityRatioG(20, 100, 101.325), 14.76, 0.02);
    near(humidityRatioG(25, 100, 101.325), 20.173, 0.02);
    near(humidityRatioG(30, 100, 101.325), 27.333, 0.03);
  });

  it('dew point — Newton inversion is exact where v1 tolerated 0.12 °C', () => {
    // Round trip: the dew point of saturated air IS the dry bulb.
    near(dewPoint(satPressure(20)), 20.0, 1e-6);
    near(dewPoint(satPressure(-15)), -15.0, 1e-6);
    near(dewPointFrom(25, 50), 13.87, 0.02); // CoolProp: 13.8669
    near(dewPointFrom(30, 60), 21.39, 0.02);
  });

  it('wet bulb vs CoolProp spot values', () => {
    near(wetBulb(25, 50, 101.325), 17.88, 0.02); // CoolProp: 17.8835
    near(wetBulb(30, 40, 101.325), 20.06, 0.02);
    near(wetBulb(35, 50, 101.325), 26.14, 0.02);
  });

  it('enthalpy and specific volume spot values', () => {
    const W = humidityRatio(25, 50, 101.325);
    near(enthalpy(25, W, 101.325), 50.423, 0.05); // CoolProp Hda: 50.423
    near(specificVolume(25, W, 101.325), 0.857788, 2e-4); // CoolProp Vda
    near(specificVolume(20, 0, 101.325), 0.830149, 2e-4); // CoolProp Vda, dry
  });

  it('rh ⇄ wet bulb round-trips exactly on both saturation branches', () => {
    for (const [tc, rh, p] of [
      [25, 50, 101.325],
      [30, 40, 101.325],
      [20, 60, 85],
      [-5, 40, 101.325], // over-ice branch — v1 got this pair wrong
      [-15, 70, 79.5],
    ]) {
      const s = wetBulbSolve(tc, rh, p);
      expect(s.converged).toBe(true);
      const back = rhFromWetBulb(tc, s.value, p);
      near(back, rh, 1e-6);
    }
  });

  it('physical sanity: impossible and edge inputs', () => {
    expect(rhFromWetBulb(25, 26, 101.325)).toBeNull(); // twb > tdb
    expect(dewPoint(0)).toBeNull();
    expect(dewPoint(-1)).toBeNull();
    expect(rhFromWetBulb(25, 25, 101.325)).toBeCloseTo(100, 2);

    // WMO psychrometer formula: an instrument reading run through the
    // thermodynamic inverse reads systematically high — the psychrometric
    // formula must sit 0.3–0.7 RH points below it at ordinary conditions.
    const twb = wetBulb(24, 45, 101.325);
    const offset = rhFromWetBulb(24, twb, 101.325) - rhFromPsychrometer(24, twb, 101.325);
    expect(offset).toBeGreaterThan(0.3);
    expect(offset).toBeLessThan(0.7);
    expect(rhFromPsychrometer(25, 25, 101.325)).toBeCloseTo(100, 2);
    expect(rhFromPsychrometer(25, 26, 101.325)).toBeNull(); // twb > tdb impossible
    expect(humidityRatio(25, 0, 101.325)).toBe(0);
    expect(degreeOfSaturation(25, 100, 101.325)).toBeCloseTo(1, 9);
    // rhFromW inverts humidityRatio
    const W = humidityRatio(25, 47, 101.325);
    expect(rhFromW(25, W, 101.325)).toBeCloseTo(47, 6);
  });

  it('pressureFromAltitude never returns NaN, even for absurd input', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1e9, -1e9, '12abc']) {
      const p = pressureFromAltitude(bad);
      expect(isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });
});
