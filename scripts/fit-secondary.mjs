#!/usr/bin/env node
/**
 * Calibrate the two secondary property groups against the CoolProp grid:
 *
 *   1. Entropy reference-state offsets. The functional form is the ideal-gas
 *      mixture expression; only the two integration constants are free, and they
 *      exist to put our entropy on CoolProp's reference convention rather than an
 *      arbitrary one.
 *   2. Transport-property correlation constants. ASHRAE Ch.1 publishes neither
 *      viscosity nor conductivity for moist air, so these are Sutherland-form
 *      correlations per component combined by the Wilke mixing rule, with the
 *      component constants fitted here.
 *
 *   node scripts/fit-secondary.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { humidityRatio, vaporPressure, P_STD } from '../src/core/psychro.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(
  readFileSync(join(here, '..', 'test', 'reference', 'coolprop-reference.json'), 'utf8'),
);
const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));
const rows = ref.rows.filter((r) => r[col.core] === 1);

const R_DA = 0.287042;
const R_V = 0.4615;

// ── 1. Entropy offsets ──────────────────────────────────────────────────────
// s = [1.006·ln(T/T0) − Rda·ln(pda/P0)] + W·[1.86·ln(T/T0) − Rv·ln(pw/P0) + Sv0] + Sda0
// Linear in (Sda0, Sv0), so a 2×2 least squares gets both exactly.
{
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const r of rows) {
    const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
    const T = t + 273.15, T0 = 273.15;
    const W = humidityRatio(t, rh, p);
    const pw = vaporPressure(t, rh);
    const pda = p - pw;
    const base =
      1.006 * Math.log(T / T0) -
      R_DA * Math.log(pda / P_STD) +
      W * (1.86 * Math.log(T / T0) - R_V * Math.log(Math.max(pw, 1e-12) / P_STD));
    const resid = r[col.s_kjkgk] - base;
    // resid ≈ Sda0·1 + Sv0·W
    a11 += 1; a12 += W; a22 += W * W; b1 += resid; b2 += resid * W;
  }
  const det = a11 * a22 - a12 * a12;
  const sda0 = (b1 * a22 - b2 * a12) / det;
  const sv0 = (a11 * b2 - a12 * b1) / det;

  let max = 0, sum = 0;
  for (const r of rows) {
    const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
    const T = t + 273.15, T0 = 273.15;
    const W = humidityRatio(t, rh, p);
    const pw = vaporPressure(t, rh);
    const pda = p - pw;
    const s =
      1.006 * Math.log(T / T0) - R_DA * Math.log(pda / P_STD) +
      W * (1.86 * Math.log(T / T0) - R_V * Math.log(Math.max(pw, 1e-12) / P_STD) + sv0) + sda0;
    const d = Math.abs(s - r[col.s_kjkgk]);
    max = Math.max(max, d); sum += d * d;
  }
  console.log('\n── entropy offsets ──');
  console.log(`  const S_DA0 = ${sda0.toExponential(9)};`);
  console.log(`  const S_V0  = ${sv0.toExponential(9)};`);
  console.log(`  residual: max ${max.toExponential(3)}  RMS ${Math.sqrt(sum / rows.length).toExponential(3)} kJ/(kg·K)`);
}

// ── 2. Transport properties ─────────────────────────────────────────────────
// Fit Sutherland constants for each pure component by minimising the mixture
// error through the Wilke rule. Two parameters per component per property, found
// by a coarse-to-fine grid search — cheap, and the surface is smooth and convex
// enough that this lands on the optimum.
const M_AIR = 28.9645;
const M_H2O = 18.01528;

function wilke(xa, xv, va, vv, pa, pv, Ma, Mv) {
  const phi_av = Math.pow(1 + Math.sqrt(pa / pv) * Math.pow(Mv / Ma, 0.25), 2) / Math.sqrt(8 * (1 + Ma / Mv));
  const phi_va = Math.pow(1 + Math.sqrt(pv / pa) * Math.pow(Ma / Mv, 0.25), 2) / Math.sqrt(8 * (1 + Mv / Ma));
  return (xa * va) / (xa + xv * phi_av) + (xv * vv) / (xv + xa * phi_va);
}

const pts = rows.map((r) => {
  const t = r[col.t_c], rh = r[col.rh_pct], p = r[col.p_kpa];
  const pw = vaporPressure(t, rh);
  const xv = Math.min(Math.max(pw / p, 0), 1);
  return { T: t + 273.15, xa: 1 - xv, xv, mu: r[col.mu_pas], k: r[col.k_wmk] };
});

function sutherland(T, C, S) {
  return (C * Math.pow(T, 1.5)) / (T + S);
}

/**
 * Grid-search four Sutherland constants (air C,S and vapour C,S) for one property.
 *
 * `muParams` supplies the viscosities that drive the Wilke φ terms. For the
 * viscosity fit that is the candidate parameter set itself (φ and the mixture
 * value must come from the same constants, or the fitted numbers will not
 * reproduce in the module — which is exactly the trap that made a "0.68 %" fit
 * measure 5.9 % once shipped). For conductivity it is the already-fitted
 * viscosity constants.
 */
function fitTransport(target, seed, label, muParams) {
  let best = { err: Infinity, params: seed };
  let ranges = seed.map((v) => [v * 0.3, v * 3]);

  for (let pass = 0; pass < 7; pass++) {
    const N = 9;
    const grids = ranges.map(([lo, hi]) =>
      Array.from({ length: N }, (_, i) => lo + ((hi - lo) * i) / (N - 1)),
    );
    for (const Ca of grids[0])
      for (const Sa of grids[1])
        for (const Cv of grids[2])
          for (const Sv of grids[3]) {
            const mp = muParams ?? [Ca, Sa, Cv, Sv];
            let max = 0;
            for (const q of pts) {
              const muA = sutherland(q.T, mp[0], mp[1]);
              const muV = sutherland(q.T, mp[2], mp[3]);
              const va = sutherland(q.T, Ca, Sa);
              const vv = sutherland(q.T, Cv, Sv);
              const m = wilke(q.xa, q.xv, va, vv, muA, muV, M_AIR, M_H2O);
              const d = Math.abs(m - q[target]) / q[target];
              if (d > max) max = d;
              if (max > best.err) break;
            }
            if (max < best.err) best = { err: max, params: [Ca, Sa, Cv, Sv] };
          }
    ranges = best.params.map((v, i) => {
      const span = (ranges[i][1] - ranges[i][0]) / 4;
      return [v - span, v + span];
    });
  }

  const [Ca, Sa, Cv, Sv] = best.params;
  console.log(`\n── ${label} ──`);
  console.log(`  dry air:  C = ${Ca.toExponential(6)}, S = ${Sa.toFixed(3)}`);
  console.log(`  vapour:   C = ${Cv.toExponential(6)}, S = ${Sv.toFixed(3)}`);
  console.log(`  max relative error over the core grid: ${(best.err * 100).toFixed(3)} %`);
  return best.params;
}

// Viscosity first (self-consistent φ), then conductivity using those viscosities.
const muFit = fitTransport('mu', [1.458e-6, 110.4, 1.12e-6, 1064], 'dynamic viscosity', null);
fitTransport('k', [2.334e-3, 164.54, 1.5e-3, 300], 'thermal conductivity', muFit);
console.log('');
