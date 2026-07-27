#!/usr/bin/env node
/**
 * Measure the JS core against the committed CoolProp reference grid and print a
 * per-property deviation table.
 *
 * This is the number generator behind `docs/coolprop-comparison.md` — run it,
 * paste the table. `npm run analyze` (add `--all` to include points outside the
 * declared core operating domain).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Namespace import (not named) so this script still runs against a core that
// hasn't grown the newer properties yet — missing ones report "not implemented"
// rather than crashing the run.
import * as P from '../src/core/psychro.js';

const {
  vaporPressure,
  humidityRatio,
  enthalpy,
  specificVolume,
  dewPoint,
  wetBulb,
  moistAirDensity,
  entropy,
  viscosity,
  thermalConductivity,
} = P;

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(
  readFileSync(join(here, '..', 'test', 'reference', 'coolprop-reference.json'), 'utf8'),
);

const coreOnly = !process.argv.includes('--all');
const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));
const rows = ref.rows.filter((r) => (coreOnly ? r[col.core] === 1 : true));

/** Each metric: how to compute ours, how to read CoolProp's, and how to compare. */
const METRICS = [
  {
    key: 'humidity ratio W',
    unit: 'g/kg',
    scale: 1000,
    ours: (t, rh, p) => humidityRatio(t, rh, p),
    theirs: (r) => r[col.w],
    rel: true,
  },
  {
    key: 'enthalpy h',
    unit: 'kJ/kg',
    ours: (t, rh, p) => enthalpy(t, humidityRatio(t, rh, p)),
    theirs: (r) => r[col.h_kjkg],
    rel: false,
  },
  {
    key: 'specific volume v',
    unit: 'm³/kg',
    ours: (t, rh, p) => specificVolume(t, humidityRatio(t, rh, p), p),
    theirs: (r) => r[col.v_m3kg],
    rel: true,
  },
  {
    key: 'density ρ',
    unit: 'kg/m³',
    ours: (t, rh, p) => moistAirDensity?.(t, rh, p),
    theirs: (r) => r[col.rho_kgm3],
    rel: true,
    optional: true,
  },
  {
    key: 'dew point Tdp',
    unit: '°C',
    ours: (t, rh) => dewPoint(vaporPressure(t, rh)),
    theirs: (r) => r[col.tdp_c],
    rel: false,
  },
  {
    key: 'wet bulb Twb',
    unit: '°C',
    ours: (t, rh, p) => wetBulb(t, rh, p),
    theirs: (r) => r[col.twb_c],
    rel: false,
  },
  {
    key: 'entropy s',
    unit: 'kJ/kg·K',
    ours: (t, rh, p) => entropy?.(t, rh, p),
    theirs: (r) => r[col.s_kjkgk],
    rel: false,
    optional: true,
  },
  {
    key: 'viscosity μ',
    unit: 'µPa·s',
    scale: 1e6,
    ours: (t, rh, p) => viscosity?.(t, rh, p),
    theirs: (r) => r[col.mu_pas],
    rel: true,
    optional: true,
  },
  {
    key: 'conductivity k',
    unit: 'mW/m·K',
    scale: 1000,
    ours: (t, rh, p) => thermalConductivity?.(t, rh, p),
    theirs: (r) => r[col.k_wmk],
    rel: true,
    optional: true,
  },
];

const fmt = (x, d = 4) =>
  x === null || x === undefined || !isFinite(x) ? '—' : x.toExponential(d).replace('e', 'e');

// Relative error is only meaningful for strictly-positive properties. Reporting
// it for dew point, wet bulb or enthalpy produces nonsense the moment the value
// crosses zero, so those metrics carry `rel: false` and print "—" instead.

console.log(`\nCoolProp reference: ${ref.source}`);
console.log(`CoolProp version:   ${ref.coolprop_version}`);
console.log(
  `Grid:               ${rows.length} points ` +
    `(${coreOnly ? 'core operating domain only' : 'full grid incl. out-of-domain'})\n`,
);

const head = `${'property'.padEnd(20)} ${'unit'.padEnd(9)} ${'max abs'.padStart(11)} ${'RMS abs'.padStart(11)} ${'max rel'.padStart(10)} ${'worst point'.padStart(24)}`;
console.log(head);
console.log('-'.repeat(head.length));

for (const m of METRICS) {
  if (m.skip) continue;
  let maxAbs = 0,
    sumSq = 0,
    n = 0,
    maxRel = 0,
    worst = null,
    unsupported = false;

  for (const r of rows) {
    const t = r[col.t_c],
      rh = r[col.rh_pct],
      p = r[col.p_kpa];
    let ours;
    try {
      ours = m.ours(t, rh, p);
    } catch {
      unsupported = true;
      break;
    }
    if (ours === undefined) {
      unsupported = true;
      break;
    }
    const theirs = m.theirs(r);
    if (theirs === null || ours === null || !isFinite(ours) || !isFinite(theirs)) continue;

    const s = m.scale ?? 1;
    const d = Math.abs(ours * s - theirs * s);
    const rel = Math.abs(theirs) > 1e-12 ? Math.abs((ours - theirs) / theirs) : 0;
    sumSq += d * d;
    n++;
    if (d > maxAbs) {
      maxAbs = d;
      worst = `${t}°C ${rh}% ${p}kPa`;
    }
    if (rel > maxRel) maxRel = rel;
  }

  if (unsupported) {
    console.log(`${m.key.padEnd(20)} ${(m.unit ?? '').padEnd(9)} ${'not implemented'.padStart(11)}`);
    continue;
  }
  const rms = Math.sqrt(sumSq / Math.max(n, 1));
  const relCol = m.rel ? `${(maxRel * 100).toFixed(4)}%`.padStart(10) : '—'.padStart(10);
  console.log(
    `${m.key.padEnd(20)} ${(m.unit ?? '').padEnd(9)} ${fmt(maxAbs, 3).padStart(11)} ${fmt(rms, 3).padStart(11)} ${relCol} ${String(worst ?? '—').padStart(24)}`,
  );
}
console.log('');
