// Physics + drift checks for the CDU model.  Run:  node tools/validate.mjs
//
// Three layers, tightest first:
//   1. the shipped page and this test core carry IDENTICAL numbers
//   2. every property fit lands on its committed CoolProp grid
//   3. thermodynamic invariants hold over the whole control envelope —
//      at the default site AND at sites nothing was hand-tuned for.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as M from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = [];
const fail = m => failures.push(m);

// ---- 1. the page and the model core must not drift apart --------------------
// The page's literals are EXTRACTED and evaluated, not regex-parsed number by
// number, so nested tables compare exactly. Function() here evaluates our own
// committed source in our own test process — nothing external reaches it.
function extract(name, open, close) {
  const start = page.search(new RegExp(`\\b${name}\\s*=\\s*\\${open}`));
  if (start < 0) { fail(`index.html: ${name} not found`); return null; }
  const from = page.indexOf(open, start);
  let depth = 0, end = -1;
  for (let i = from; i < page.length; i++) {
    if (page[i] === open) depth++;
    else if (page[i] === close && --depth === 0) { end = i; break; }
  }
  if (end < 0) { fail(`index.html: ${name} literal never closes`); return null; }
  try { return Function(`"use strict"; return (${page.slice(from, end + 1)});`)(); }
  catch { fail(`index.html: ${name} does not evaluate`); return null; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const name of ['RC_PRI', 'PH_PRI']) {
  const got = extract(name, '[', ']');
  if (got && !same(got, M[name])) fail(`drift: ${name} differs between index.html and model.mjs`);
}
for (const name of ['N_EXP', 'DP_GLY']) {
  const m = page.match(new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.eE+-]+)`));
  if (!m) fail(`index.html: constant ${name} not found`);
  else if (Number(m[1]) !== M[name]) fail(`drift: ${name} is ${m[1]} in index.html, ${M[name]} in model.mjs`);
}
{
  const gly = extract('GLY', '{', '}');
  if (gly && !same(gly, M.GLY)) fail('drift: GLY property tables differ between index.html and model.mjs');
  const site = extract('SITE_DEFAULTS', '{', '}');
  if (site && !same(site, M.SITE_DEFAULTS)) fail('drift: SITE_DEFAULTS differ between index.html and model.mjs');
}

// ---- 2a. water fits still land on CoolProp ----------------------------------
// 2.7e-4 % is where the fits sit; the tolerance is an order above so it flags
// a real regression rather than float noise.
{
  const ref = JSON.parse(readFileSync(join(here, 'property-reference.json'), 'utf8'));
  const TOL_PCT = 3e-3;
  const horner = (c, t) => c.reduce((v, a) => v * t + a, 0);
  for (const [name, key] of [['RC_PRI', 'rc_pri'], ['PH_PRI', 'ph_pri']]) {
    let worst = 0, at = 0;
    for (const r of ref.rows) {
      const e = Math.abs(horner(M[name], r.t_c) - r[key]) / r[key] * 100;
      if (e > worst) { worst = e; at = r.t_c; }
    }
    if (worst > TOL_PCT) fail(`${name}: ${worst.toExponential(2)}% off CoolProp at ${at} C (max ${TOL_PCT}%)`);
    else console.log(`${name.padEnd(7)} vs CoolProp  max ${worst.toExponential(2)}%`);
  }

  // The old single-mixture PG25 grid doubles as an independent check on the
  // 2-D glycol surface at one slice: secProps at conc 25 must reproduce the
  // same CoolProp numbers the retired RC_SEC/PH_SEC fits were pinned against.
  const site25 = { ...M.SITE_DEFAULTS };
  let wRc = 0, wPh = 0;
  for (const r of ref.rows) {
    if (r.t_c > 60) continue; // the 2-D surface is fitted to -10..60 C
    const p = M.secProps(site25, r.t_c);
    wRc = Math.max(wRc, Math.abs(p.rc - r.rc_sec) / r.rc_sec * 100);
    wPh = Math.max(wPh, Math.abs(p.phi - r.ph_sec) / r.ph_sec * 100);
  }
  if (wRc > 1e-4 || wPh > 1e-4)
    fail(`PG25 slice of the glycol surface off its grid: rc ${wRc.toExponential(2)}%, phi ${wPh.toExponential(2)}%`);
  else console.log(`PG25 2-D slice vs grid    max ${Math.max(wRc, wPh).toExponential(2)}%`);
}

// ---- 2b. the glycol surface lands on CoolProp at EVERY fluid and strength ---
// 705 committed points, MPG and MEG, 0..60 % by mass, -10..60 C. The fits
// RECOVER CoolProp's own polynomial model (~1e-8), so the tolerance is tight
// enough that any re-fit sloppier than exact fails.
{
  const ref = JSON.parse(readFileSync(join(here, 'coolant-reference.json'), 'utf8'));
  const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));
  let worst = 0, at = '';
  for (const r of ref.rows) {
    const site = { fluid: r[col.fluid], conc: r[col.conc_pct] };
    const t = r[col.t_c];
    const F = M.GLY[site.fluid];
    const tn = t / 50, cn = site.conc / 60;
    const p2 = (C) => { let v = 0; for (let i = 0; i < 36; i += 6) { let w = 0; for (let j = 0; j < 6; j++) w = w * cn + C[i + j]; v = v * tn + w; } return v; };
    for (const [prop, key, log] of [['rho', 'rho_kgm3', false], ['cp', 'cp_kjkgk', false],
                                    ['k', 'k_wmk', false], ['mu', 'mu_mpas', true]]) {
      const got = log ? Math.exp(p2(F[prop])) : p2(F[prop]);
      const e = Math.abs(got - r[col[key]]) / Math.abs(r[col[key]]) * 100;
      if (e > worst) { worst = e; at = `${site.fluid}-${site.conc}% ${prop} at ${t} C`; }
    }
  }
  if (worst > 1e-5) fail(`glycol surface off CoolProp: ${worst.toExponential(2)}% at ${at}`);
  else console.log(`glycol surface vs grid    max ${worst.toExponential(2)}%  (${ref.rows.length} pts x 4 props)`);
}

// ---- 2c. the anchor still reproduces the original tool ----------------------
// The geometry used to be constants K_GEO = 0.34703 / R_WALL = 1.82048e-7,
// derived offline by tools/cdu_reference.py. The live anchor must land on
// them at the default site, or the parameterization changed the physics.
{
  const g = M.anchor(M.SITE_DEFAULTS);
  if (g.VsD !== 940 || g.VpD !== 720) fail(`default design flows ${g.VsD}/${g.VpD}, expected 940/720`);
  if (Math.abs(g.K - 0.34703) / 0.34703 > 0.005) fail(`default K ${g.K} drifted >0.5% from 0.34703`);
  if (Math.abs(g.Rw - 1.82048e-7) / 1.82048e-7 > 0.005) fail(`default R_wall ${g.Rw} drifted >0.5%`);
  const d = M.solve(M.SITE_DEFAULTS, g.VsD, g.VpD, M.SITE_DEFAULTS.qDes * 1000, g);
  // "3 K" holds exactly only under the anchor's design assumptions; solving at
  // the rounded flows with live property means lands at 3.02 K — the same
  // figure the ORIGINAL constants produced, which is the point of the check.
  if (Math.abs(d.approach - M.SITE_DEFAULTS.approach) > 0.1)
    fail(`design approach ${d.approach.toFixed(4)} K, expected ~${M.SITE_DEFAULTS.approach}`);
  if (Math.abs(d.chip - 45.70) > 0.05) fail(`design die ${d.chip.toFixed(3)} C, expected 45.70±0.05`);
  if (Math.abs(d.pump - 1) > 1e-9) fail(`design pump ${d.pump}, expected exactly x1.00`);
}

// ---- 3. thermodynamic invariants, at the default site and at strangers ------
// The default site sweeps the full envelope. The alternates exist because a
// parameterized model's bugs live where nobody hand-tuned: a strong cold-site
// mix, and plain water at four times the capacity.
const SITES = [
  ['default (PG25, W27, 500 kW)', M.SITE_DEFAULTS, 20],
  ['cold site (MEG-40, 12 C, 800 kW)', { ...M.SITE_DEFAULTS, fluid: 'MEG', conc: 40, tFws: 12, qDes: 800 }, 60],
  ['water-water (0 %, 2 MW)', { ...M.SITE_DEFAULTS, conc: 0, qDes: 2000 }, 60],
];

let n = 0, maxBal = 0, maxQ = 0, gMono = true, hMono = true;
for (const [label, site, step] of SITES) {
  const g = M.anchor(site);
  const vs = [Math.round(g.VsD * 0.43), Math.round(g.VsD * 2.02)];
  const vp = [Math.round(g.VpD * 0.35), Math.round(g.VpD * 2.08)];
  const qs = [Math.round(site.qDes * 0.2), Math.round(site.qDes * 1.2)];
  const dq = Math.max(10, Math.round((qs[1] - qs[0]) / 25));
  for (let Vs = vs[0]; Vs <= vs[1]; Vs += step)
    for (let Vp = vp[0]; Vp <= vp[1]; Vp += step)
      for (let q = qs[0]; q <= qs[1]; q += dq) {
        n++;
        const Q = q * 1000, r = M.solve(site, Vs, Vp, Q, g);
        maxBal = Math.max(maxBal, Math.abs(r.Qsec - r.Qpri));
        maxQ   = Math.max(maxQ,   Math.abs(r.Qsec - r.q));
        if (!(r.e > 0 && r.e < 1))          fail(`[${label}] effectiveness outside (0,1) at ${Vs}/${Vp}/${q}`);
        if (r.hotOut < site.tFws - 1e-9)    fail(`[${label}] rack supply below facility supply at ${Vs}/${Vp}/${q}`);
        if (r.facOut > r.hotIn + 1e-9)      fail(`[${label}] facility return above hot end at ${Vs}/${Vp}/${q}`);
        if (r.hotIn  < r.hotOut - 1e-9)     fail(`[${label}] rack return below rack supply at ${Vs}/${Vp}/${q}`);
        if (r.chip   > site.tTrip + 1e-6)   fail(`[${label}] die above throttle setpoint at ${Vs}/${Vp}/${q}`);
        if (r.q      > Q + 1e-6)            fail(`[${label}] rejecting more than demanded at ${Vs}/${Vp}/${q}`);
      }

  // The claim the sim exists to make: conductance rises with EITHER flow, so
  // the hottest die falls with either flow — at every site, not just the one
  // the constants were tuned for.
  for (let Vs = vs[0]; Vs <= vs[1]; Vs += Math.round((vs[1] - vs[0]) / 12)) {
    let pg = -Infinity, pc = Infinity;
    for (let Vp = vp[0]; Vp <= vp[1]; Vp += 10) {
      const r = M.solve(site, Vs, Vp, site.qDes * 1000, g);
      if (r.G < pg - 1e-6) gMono = false;
      if (r.chip > pc + 1e-6) hMono = false;
      pg = r.G; pc = r.chip;
    }
  }
  for (let Vp = vp[0]; Vp <= vp[1]; Vp += Math.round((vp[1] - vp[0]) / 12)) {
    let pg = -Infinity, pc = Infinity;
    for (let Vs = vs[0]; Vs <= vs[1]; Vs += 10) {
      const r = M.solve(site, Vs, Vp, site.qDes * 1000, g);
      if (r.G < pg - 1e-6) gMono = false;
      if (r.chip > pc + 1e-6) hMono = false;
      pg = r.G; pc = r.chip;
    }
  }
}
if (maxBal > 1e-6) fail(`energy balance residual ${maxBal.toExponential(2)} W`);
if (maxQ   > 1e-6) fail(`heat across plates does not equal IT load (${maxQ.toExponential(2)} W)`);
if (!gMono) fail('conductance G is not monotonic in flow');
if (!hMono) fail('hottest die is not monotonically decreasing in flow');

// ---- report ----------------------------------------------------------------
console.log(`swept ${n.toLocaleString()} operating points across ${SITES.length} sites`);
console.log(`energy balance residual   max ${maxBal.toExponential(2)} W`);
console.log(`heat across plates vs load max ${maxQ.toExponential(2)} W`);
console.log(`conductance rises with either flow : ${gMono}`);
console.log(`hottest die falls with either flow : ${hMono}`);
console.log('');
console.log('preset                  rack dT  fac dT   hot end     die  fac ret   pump');
{
  const s = M.SITE_DEFAULTS, g = M.anchor(s);
  for (const [name, Vs, Vp] of [['design point', g.VsD, g.VpD],
                                ['fast glycol/slow water', 1400, 360],
                                ['tuned', 1120, 450]]) {
    const r = M.solve(s, Vs, Vp, 500e3, g);
    console.log(`${name.padEnd(22)} ${r.rackDT.toFixed(2).padStart(6)} K ${r.facDT.toFixed(2).padStart(6)} K`
              + ` ${r.hotIn.toFixed(1).padStart(6)} C ${r.chip.toFixed(1).padStart(7)} C`
              + ` ${r.facOut.toFixed(1).padStart(6)} C  x${r.pump.toFixed(2)}`);
  }
}
console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');
