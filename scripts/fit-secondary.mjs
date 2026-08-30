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
// Per-component dilute-gas polynomials combined by the Wilke rule, times an
// empirical closure term carrying the pressure and composition dependence the
// component model cannot express.
//
// This replaced Sutherland two-parameter components, which were worth 0.32 %
// and 0.43 %. Decomposing that error showed where it actually lived:
//
//   * At 1 % RH — essentially pure air, Wilke barely participating — the error
//     still averaged 0.24 %. The mixing rule was not the problem; a
//     two-parameter Sutherland cannot track CoolProp's dry-air viscosity over
//     the domain. A degree-4 polynomial tracks it to 1.8e-4 %.
//   * What remained was a symmetric spread growing with water content and
//     moving systematically with PRESSURE at fixed temperature and RH — which
//     a temperature-only component model has no term for.
//
// Fitting is two stages: Levenberg–Marquardt on the component polynomials
// (a monomial basis over this narrow range is badly conditioned, hence the
// centred `u` and the damping), then a linear least-squares closure term
// refined by IRLS toward a minimax solution — least squares alone leaves the
// peak error almost untouched, which is the number the tolerance is set from.
//
// As with the Sutherland fit before it, the φ terms and the mixture value must
// come from the SAME constants, or the fitted numbers will not reproduce once
// shipped.
const M_AIR = 28.9645;
const M_H2O = 18.01528;
const trU = (T) => (T - 300) / 50;
const trPi = (pk) => (pk - 101.325) / 101.325;
const trPoly = (c, u) => { let v = 0; for (let j = c.length - 1; j >= 0; j--) v = v * u + c[j]; return v; };
const phiOf = (mi, mj, Mi, Mj) =>
  Math.pow(1 + Math.sqrt(mi / mj) * Math.pow(Mj / Mi, 0.25), 2) / Math.sqrt(8 * (1 + Mi / Mj));

const pts = rows
  .filter((r) => r[col.mu_pas] != null && r[col.k_wmk] != null)
  .map((r) => {
    const t = r[col.t_c], rh = r[col.rh_pct], pk = r[col.p_kpa];
    const xv = Math.min(Math.max(vaporPressure(t, rh) / pk, 0), 1);
    return { u: trU(t + 273.15), pi: trPi(pk), xa: 1 - xv, xv, mu: r[col.mu_pas], k: r[col.k_wmk] };
  });

/** Solve a symmetric normal-equation system by Gaussian elimination. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((r) => Array.from(r)), y = Array.from(b);
  for (let i = 0; i < n; i++) {
    let pi = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[pi][i])) pi = r;
    [M[i], M[pi]] = [M[pi], M[i]]; [y[i], y[pi]] = [y[pi], y[i]];
    if (Math.abs(M[i][i]) < 1e-300) continue;
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / M[i][i];
      for (let c = i; c < n; c++) M[r][c] -= f * M[i][c];
      y[r] -= f * y[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sm = y[i];
    for (let c = i + 1; c < n; c++) sm -= M[i][c] * x[c];
    x[i] = Math.abs(M[i][i]) < 1e-300 ? 0 : sm / M[i][i];
  }
  return x;
}
/** Weighted linear least squares over an explicit design matrix. */
function lsq(G, ys, w) {
  const n = G[0].length;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let i = 0; i < G.length; i++) {
    const g = G[i], wi = w ? w[i] : 1;
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) A[j][k] += wi * wi * g[j] * g[k];
      b[j] += wi * wi * g[j] * ys[i];
    }
  }
  for (let i = 0; i < n; i++) A[i][i] *= 1 + 1e-12;
  return solve(A, b);
}
/** Least-squares polynomial of the given degree in u. */
const polyLS = (us, ys, deg) =>
  lsq(us.map((u) => Array.from({ length: deg + 1 }, (_, j) => Math.pow(u, j))), ys, null);

/** Levenberg–Marquardt on a residual vector. */
function lm(p0, resid, iters = 200) {
  let p = p0.slice(); const n = p.length; let lam = 1e-3;
  const cost = (q) => resid(q).reduce((a, v) => a + v * v, 0);
  let c0 = cost(p);
  for (let it = 0; it < iters; it++) {
    const r0 = resid(p), m = r0.length;
    const J = Array.from({ length: n }, () => new Float64Array(m));
    for (let j = 0; j < n; j++) {
      const h = Math.abs(p[j]) * 1e-7 + 1e-14, q = p.slice(); q[j] += h;
      const r1 = resid(q);
      for (let i = 0; i < m; i++) J[j][i] = (r1[i] - r0[i]) / h;
    }
    const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) { let sm = 0; for (let i = 0; i < m; i++) sm += J[j][i] * J[k][i]; A[j][k] = sm; }
      let sm = 0; for (let i = 0; i < m; i++) sm -= J[j][i] * r0[i]; b[j] = sm;
    }
    let improved = false;
    for (let tries = 0; tries < 30; tries++) {
      const damped = A.map((r, i) => r.map((v, k) => (i === k ? v * (1 + lam) : v)));
      const dx = solve(damped, b);
      const q = p.map((v, i) => v + dx[i]), c1 = cost(q);
      if (isFinite(c1) && c1 < c0) { p = q; c0 = c1; lam = Math.max(lam * 0.3, 1e-12); improved = true; break; }
      lam *= 10; if (lam > 1e12) break;
    }
    if (!improved) break;
  }
  return p;
}

const basis = (d) => [
  1, d.u, d.u * d.u, d.pi, d.pi * d.pi, d.xv, d.xv * d.xv,
  d.u * d.pi, d.u * d.xv, d.pi * d.xv, d.u * d.u * d.pi, d.xv * d.pi * d.pi, d.u * d.xv * d.pi,
];

// Stage 1 — component polynomials, seeded from the old Sutherland forms so the
// optimiser starts somewhere physical.
const sutA = (T) => (1.483059e-6 * Math.pow(T, 1.5)) / (T + 114.626);
const sutV = (T) => (1.954312e-6 * Math.pow(T, 1.5)) / (T + 650.245);
const seedGrid = [];
for (let t = -25; t <= 60; t += 0.5) seedGrid.push(t + 273.15);
const mixWith = (ca, cv, d, va, vv) => {
  const ma = trPoly(ca, d.u), mv = trPoly(cv, d.u);
  const A = va ?? ma, V = vv ?? mv;
  return (d.xa * A) / (d.xa + d.xv * phiOf(ma, mv, M_AIR, M_H2O))
       + (d.xv * V) / (d.xv + d.xa * phiOf(mv, ma, M_H2O, M_AIR));
};
const muResid = (q) => pts.map((d) => (mixWith(q.slice(0, 5), q.slice(5, 10), d) - d.mu) / d.mu);
const muFit = lm([
  ...polyLS(seedGrid.map(trU), seedGrid.map(sutA), 4),
  ...polyLS(seedGrid.map(trU), seedGrid.map(sutV), 4),
], muResid);
const MU_AIR = muFit.slice(0, 5), MU_VAP = muFit.slice(5, 10);

const dryish = pts.filter((d) => d.xv < 0.004);
const kSeedA = polyLS(dryish.map((d) => d.u), dryish.map((d) => d.k), 4);
const kResid = (q) =>
  pts.map((d) => (mixWith(MU_AIR, MU_VAP, d, trPoly(q.slice(0, 5), d.u), trPoly(q.slice(5, 10), d.u)) - d.k) / d.k);
const kFit = lm([...kSeedA, ...kSeedA.map((v) => v * 0.7)], kResid);
const K_AIR = kFit.slice(0, 5), K_VAP = kFit.slice(5, 10);

// Stage 2 — closure term, IRLS toward minimax.
function fitClosure(base, target, label) {
  const G = pts.map(basis);
  let w = pts.map(() => 1), best = null;
  for (let it = 0; it < 40; it++) {
    const c = lsq(G, pts.map((d) => target(d) / base(d) - 1), w);
    const res = pts.map((d, i) => (base(d) * (1 + G[i].reduce((a, v, j) => a + v * c[j], 0)) - target(d)) / target(d));
    const mx = Math.max(...res.map(Math.abs));
    if (!best || mx < best.mx) best = { mx, c: c.slice() };
    w = res.map((r, i) => w[i] * (1 + 3 * Math.abs(r) / mx));
    const mean = w.reduce((a, b) => a + b, 0) / w.length;
    w = w.map((v) => v / mean);
  }
  const res = pts.map((d, i) => (base(d) * (1 + G[i].reduce((a, v, j) => a + v * best.c[j], 0)) - target(d)) / target(d));
  const rms = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / res.length);
  console.log(`\n── ${label} ──`);
  console.log(`  max relative error over the core grid: ${(best.mx * 100).toExponential(3)} %`);
  console.log(`  RMS:                                   ${(rms * 100).toExponential(3)} %`);
  return best.c;
}
const MU_CORR = fitClosure((d) => mixWith(MU_AIR, MU_VAP, d), (d) => d.mu, 'dynamic viscosity');
const K_CORR = fitClosure(
  (d) => mixWith(MU_AIR, MU_VAP, d, trPoly(K_AIR, d.u), trPoly(K_VAP, d.u)), (d) => d.k, 'thermal conductivity');

const emit = (name, a) =>
  console.log(`const ${name} = [\n  ${a.map((v) => v.toExponential(12)).join(',\n  ')},\n];`);
console.log('\n── paste into src/core/psychro.js ──');
emit('MU_AIR', MU_AIR); emit('MU_VAP', MU_VAP);
emit('K_AIR', K_AIR); emit('K_VAP', K_VAP);
emit('MU_CORR', MU_CORR); emit('K_CORR', K_CORR);
console.log('');
