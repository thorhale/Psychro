#!/usr/bin/env node
/**
 * Refit the water-vapour enhancement factor used by `humidityRatio()`.
 *
 * The v1 fit was calibrated over T 0–50 °C, p 65–102 kPa, but the chart runs to
 * 54 °C and `pressureFromAltitude()` admits pressures down to ~22 kPa, so the
 * shipped tool extrapolated. This script refits over the full reachable domain
 * against the committed CoolProp grid and prints coefficients ready to paste into
 * `src/core/psychro.js`, along with the residual so the comment can state it.
 *
 * What is actually being fitted
 * -----------------------------
 * `humidityRatio(pw, p)` computes W = 0.621945·(f·pw)/(p − f·pw). Inverting
 * CoolProp's W for the same p gives the partial pressure the real-gas model
 * implies, and dividing by the ASHRAE Eq. 5/6 saturation pressure times RH gives
 * the f that would make our formula exact. So this fit absorbs BOTH the real-gas
 * enhancement and any residual error in Eq. 5/6 — which is the point: what we
 * care about is that W lands on CoolProp, not that f matches a textbook f.
 *
 *   npm run fit:enhancement
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { satPressure } from '../src/core/psychro.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(
  readFileSync(join(here, '..', 'test', 'reference', 'coolprop-reference.json'), 'utf8'),
);
const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));

// Fit over the declared core operating domain only. Points beyond it are guarded
// by `checkDomain()` at runtime rather than fitted — stretching the polynomial to
// cover W > 0.15 kg/kg would degrade accuracy where the tool is actually used.
const rows = ref.rows.filter((r) => r[col.core] === 1);

/**
 * The implied f turns out to be independent of RH to within 1e-9, so it is a
 * clean function of (T, p) and a modest tensor-product polynomial captures it.
 * Basis: t^i · dp^j for i ≤ TDEG, j ≤ PDEG, where dp = p − 101.325.
 */
const TDEG = Number(process.env.TDEG ?? 3);
const PDEG = Number(process.env.PDEG ?? 2);

// Normalise both variables to O(1) before building the design matrix. Raw t runs
// to 55 and dp to −81, so t³·dp² spans ~9 orders of magnitude and the normal
// equations lose most of their precision — which showed up as the cubic fit
// scoring WORSE than the quadratic. These scales are baked into the emitted code.
const T_SCALE = 50;
const P_SCALE = 50;
const tn = (t) => t / T_SCALE;
const dpn = (p) => (p - 101.325) / P_SCALE;

const TERMS = [];
for (let i = 0; i <= TDEG; i++) {
  for (let j = 0; j <= PDEG; j++) {
    TERMS.push({
      i,
      j,
      name: `tn^${i}*dpn^${j}`,
      f: (t, p) => Math.pow(tn(t), i) * Math.pow(dpn(p), j),
    });
  }
}

// One equation per (t, p) cell rather than per grid row: f does not depend on RH,
// so including all 21 RH values per cell would just weight cells by RH count.
const cells = new Map();
for (const r of rows) {
  const t = r[col.t_c],
    rh = r[col.rh_pct],
    p = r[col.p_kpa],
    w = r[col.w];
  const pwAshrae = (satPressure(t) * rh) / 100;
  if (pwAshrae <= 0) continue;
  // Invert W = 0.621945·Pw/(p − Pw)  →  Pw = W·p/(0.621945 + W)
  const PwReal = (w * p) / (0.621945 + w);
  const key = `${t}|${p}`;
  if (!cells.has(key)) cells.set(key, { t, p, f: PwReal / pwAshrae });
}

// Fit the two saturation branches SEPARATELY.
//
// `satPressure` switches from Eq. 5 (over water) to Eq. 6 (over ice) at 0 °C, and
// the two fits disagree by 9.7e-5 relative right at the seam. Because this factor
// absorbs Eq. 5/6 bias as well as the real-gas enhancement, a single smooth
// polynomial cannot span that step — it plateaus at ~7e-5 residual no matter how
// many terms it is given. One polynomial per branch removes the seam entirely.
const BRANCH = process.env.BRANCH ?? 'water'; // 'water' (t >= 0) | 'ice' (t < 0)
const branchCells = [...cells.values()].filter((c) =>
  BRANCH === 'ice' ? c.t < 0 : c.t >= 0,
);

const A = [];
const b = [];
for (const { t, p, f } of branchCells) {
  A.push(TERMS.map((term) => term.f(t, p)));
  b.push(f);
}

/** Solve the normal equations (AᵀA)x = Aᵀb by Gaussian elimination with pivoting. */
function leastSquares(A, b) {
  const n = A[0].length;
  const M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) for (let k = 0; k < A.length; k++) M[i][j] += A[k][i] * A[k][j];
    for (let k = 0; k < A.length; k++) M[i][n] += A[k][i] * b[k];
  }
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i] / M[i][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((_, i) => M[i][n] / M[i][i]);
}

const x = leastSquares(A, b);

let maxRes = 0,
  sumSq = 0;
for (let k = 0; k < A.length; k++) {
  const pred = A[k].reduce((s, v, i) => s + v * x[i], 0);
  const d = Math.abs(pred - b[k]);
  maxRes = Math.max(maxRes, d);
  sumSq += d * d;
}

console.log(`\nbranch: ${BRANCH}   basis: t^0..${TDEG} × dp^0..${PDEG}  (${TERMS.length} terms)`);
console.log(`fitted over ${branchCells.length} (T, p) cells drawn from ${rows.length} core-domain points`);
console.log(`f range in data: ${Math.min(...b).toFixed(6)} … ${Math.max(...b).toFixed(6)}`);
console.log(
  `residual on f: max ${maxRes.toExponential(3)}  RMS ${Math.sqrt(sumSq / b.length).toExponential(3)}`,
);
console.log(`  → implies max W error ≈ ${((maxRes / 1.004) * 100).toExponential(3)} %\n`);

// Emit as nested Horner in dp with polynomial coefficients in t — compact, and
// evaluates in a handful of multiplies on the chart's hot path.
const byJ = [];
for (let j = 0; j <= PDEG; j++) {
  const terms = [];
  for (let i = 0; i <= TDEG; i++) {
    const k = TERMS.findIndex((t) => t.i === i && t.j === j);
    terms.push(x[k]);
  }
  byJ.push(terms);
}
console.log(`  const t = tc / ${T_SCALE};`);
console.log(`  const d = (p - 101.325) / ${P_SCALE};`);
byJ.forEach((coeffs, j) => {
  // Horner in t, so each row is a few multiply-adds on the chart's hot path.
  let body = coeffs[coeffs.length - 1].toExponential(12);
  for (let i = coeffs.length - 2; i >= 0; i--) {
    const c = coeffs[i];
    body = `(${body}) * t ${c < 0 ? '-' : '+'} ${Math.abs(c).toExponential(12)}`;
  }
  console.log(`  const c${j} = ${body};`);
});
let ret = `c${PDEG}`;
for (let j = PDEG - 1; j >= 0; j--) ret = `(${ret}) * d + c${j}`;
console.log(`  return ${ret};\n`);
