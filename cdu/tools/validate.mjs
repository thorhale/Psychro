// Physics + drift checks for the CDU model.  Run:  node tools/validate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as M from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, '..', 'index.html'), 'utf8');

let failures = [];
const fail = m => failures.push(m);

// ---- 1. the page and the model core must not drift apart --------------------
const scalars = { N_EXP:'N_EXP', K_GEO:'K_GEO', R_WALL:'R_WALL', T_FWS:'T_FWS',
                  T_TRIP:'T_TRIP', N_DEV:'N_DEV', R_CP:'R_CP', DP_GLY:'DP_GLY',
                  VS_D:'VS_D', VP_D:'VP_D' };
for (const [k, name] of Object.entries(scalars)) {
  const m = page.match(new RegExp(`\\b${name}\\s*=\\s*(-?[\\d.eE+-]+)`));
  if (!m) { fail(`index.html: constant ${name} not found`); continue; }
  if (Number(m[1]) !== M[k]) fail(`drift: ${name} is ${m[1]} in index.html, ${M[k]} in model.mjs`);
}
for (const name of ['RC_SEC','PH_SEC','RC_PRI','PH_PRI']) {
  const m = page.match(new RegExp(`\\b${name}\\s*=\\s*\\[([^\\]]+)\\]`));
  if (!m) { fail(`index.html: polynomial ${name} not found`); continue; }
  const got = m[1].split(',').map(Number);
  if (got.length !== M[name].length || got.some((v, i) => v !== M[name][i]))
    fail(`drift: ${name} differs between index.html and model.mjs`);
}

// ---- 2. thermodynamic invariants over the full control envelope -------------
let n = 0, maxBal = 0, maxQ = 0;
for (let Vs = 400; Vs <= 1900; Vs += 20)
  for (let Vp = 250; Vp <= 1500; Vp += 20)
    for (let q = 100; q <= 600; q += 20) {
      n++;
      const Q = q * 1000, r = M.solve(Vs, Vp, Q);
      maxBal = Math.max(maxBal, Math.abs(r.Qsec - r.Qpri));
      maxQ   = Math.max(maxQ,   Math.abs(r.Qsec - r.q));
      if (!(r.e > 0 && r.e < 1))        fail(`effectiveness outside (0,1) at ${Vs}/${Vp}/${q}`);
      if (r.hotOut < M.T_FWS - 1e-9)    fail(`rack supply below facility supply at ${Vs}/${Vp}/${q}`);
      if (r.facOut > r.hotIn + 1e-9)    fail(`facility return above hot end at ${Vs}/${Vp}/${q}`);
      if (r.hotIn  < r.hotOut - 1e-9)   fail(`rack return below rack supply at ${Vs}/${Vp}/${q}`);
      if (r.chip   > M.T_TRIP + 1e-6)   fail(`die above throttle setpoint at ${Vs}/${Vp}/${q}`);
      if (r.q      > Q + 1e-6)          fail(`rejecting more than demanded at ${Vs}/${Vp}/${q}`);
    }
if (maxBal > 1e-6) fail(`energy balance residual ${maxBal.toExponential(2)} W`);
if (maxQ   > 1e-6) fail(`heat across plates does not equal IT load (${maxQ.toExponential(2)} W)`);

// ---- 3. the claim the sim exists to make -----------------------------------
// Conductance G must rise with EITHER flow, so the hottest die must fall with
// either flow.  This is what refutes "slow the chilled water to cool harder".
let gMono = true, hMono = true;
for (let Vs = 400; Vs <= 1900; Vs += 100) {
  let pg = -Infinity, ph = Infinity;
  for (let Vp = 250; Vp <= 1500; Vp += 10) {
    const r = M.solve(Vs, Vp, 500e3);
    if (r.G < pg - 1e-6)   gMono = false;
    if (r.chip > ph + 1e-6) hMono = false;
    pg = r.G; ph = r.chip;
  }
}
for (let Vp = 250; Vp <= 1500; Vp += 100) {
  let pg = -Infinity, ph = Infinity;
  for (let Vs = 400; Vs <= 1900; Vs += 10) {
    const r = M.solve(Vs, Vp, 500e3);
    if (r.G < pg - 1e-6)   gMono = false;
    if (r.chip > ph + 1e-6) hMono = false;
    pg = r.G; ph = r.chip;
  }
}
if (!gMono) fail('conductance G is not monotonic in flow');
if (!hMono) fail('hottest die is not monotonically decreasing in flow');

// ---- report ----------------------------------------------------------------
console.log(`swept ${n.toLocaleString()} operating points`);
console.log(`energy balance residual   max ${maxBal.toExponential(2)} W`);
console.log(`heat across plates vs load max ${maxQ.toExponential(2)} W`);
console.log(`conductance rises with either flow : ${gMono}`);
console.log(`hottest die falls with either flow : ${hMono}`);
console.log('');
console.log('preset                  rack dT  fac dT   hot end     die  fac ret   pump');
for (const [name, Vs, Vp] of [['design point', M.VS_D, M.VP_D],
                              ['fast glycol/slow water', 1400, 360],
                              ['tuned', 1120, 450]]) {
  const r = M.solve(Vs, Vp, 500e3);
  console.log(`${name.padEnd(22)} ${r.rackDT.toFixed(2).padStart(6)} K ${r.facDT.toFixed(2).padStart(6)} K`
            + ` ${r.hotIn.toFixed(1).padStart(6)} C ${r.chip.toFixed(1).padStart(7)} C`
            + ` ${r.facOut.toFixed(1).padStart(6)} C  x${r.pump.toFixed(2)}`);
}
console.log('');
if (failures.length) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures.slice(0, 20)) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');
