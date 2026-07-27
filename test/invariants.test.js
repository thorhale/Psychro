/**
 * Physical invariants over randomized states.
 *
 * The CoolProp oracle (`psychro.test.js`) pins accuracy at 3,898 *specific*
 * points. These tests assert the laws that must hold at *every* point — round
 * trips closing, orderings, monotonicity, saturation limits. Together they cover
 * different failure modes: the oracle catches "wrong by this much here", the
 * invariants catch "wrong in a new way somewhere we never sampled".
 *
 * The sampler is a seeded mulberry32 PRNG, not `Math.random`, so a failure is
 * reproducible from the printed seed and CI can never flake on input choice.
 */

import { describe, it, expect } from 'vitest';
import {
  satPressure,
  satPressureWater,
  satPressureIce,
  vaporPressure,
  rhFromVapor,
  humidityRatio,
  saturationHumidityRatio,
  vaporPressureFromW,
  rhFromW,
  degreeOfSaturation,
  dewPoint,
  dewPointFrom,
  rhFromDewPoint,
  wetBulbSolve,
  rhFromWetBulb,
  enthalpy,
  specificVolume,
  moistAirDensity,
  entropy,
  viscosity,
  thermalConductivity,
  pressureFromAltitude,
} from '../src/core/psychro.js';
import { CORE_DOMAIN, checkDomain } from '../src/core/domain.js';
import { deriveState } from '../src/core/derive.js';
import { ASHRAE_ENVELOPES, upperW, lowerW, envelopePolygon } from '../src/core/envelopes.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Seeded sampler ──────────────────────────────────────────────────────────

const SEED = 0x5eed1234;

/** mulberry32 — small, fast, and deterministic across engines. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sample the declared core domain. RH starts at 1 % so vapour pressure stays
 * strictly positive; points whose humidity ratio exceeds the domain ceiling are
 * rejected, since that is the band `checkDomain` exists to flag rather than serve.
 */
function sampleStates(n, seed = SEED) {
  const rand = mulberry32(seed);
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 20) {
    const tc = CORE_DOMAIN.tMinC + rand() * (CORE_DOMAIN.tMaxC - CORE_DOMAIN.tMinC);
    const rh = 1 + rand() * 99;
    const p = CORE_DOMAIN.pMinKpa + rand() * (CORE_DOMAIN.pMaxKpa - CORE_DOMAIN.pMinKpa);
    const W = humidityRatio(tc, rh, p);
    if (!isFinite(W) || W > CORE_DOMAIN.wMaxKgKg) continue;
    out.push({ tc, rh, p, W });
  }
  return out;
}

const STATES = sampleStates(2000);
/** Context string so a failure names the exact state that broke. */
const at = (s) => `seed ${SEED} @ ${s.tc.toFixed(4)}°C ${s.rh.toFixed(4)}% ${s.p.toFixed(4)}kPa`;

describe('sampler', () => {
  it('produces a deterministic, well-spread set inside the domain', () => {
    expect(STATES.length).toBe(2000);
    expect(sampleStates(50).map((s) => s.tc)).toEqual(sampleStates(50).map((s) => s.tc));
    // Spread: every quarter of the temperature range gets hit.
    const span = CORE_DOMAIN.tMaxC - CORE_DOMAIN.tMinC;
    for (let q = 0; q < 4; q++) {
      const lo = CORE_DOMAIN.tMinC + (span * q) / 4;
      const hi = lo + span / 4;
      expect(STATES.some((s) => s.tc >= lo && s.tc < hi), `quarter ${q}`).toBe(true);
    }
    // Both saturation branches are exercised.
    expect(STATES.some((s) => s.tc < 0)).toBe(true);
    expect(STATES.some((s) => s.tc >= 0)).toBe(true);
  });
});

// ── Round trips ─────────────────────────────────────────────────────────────

describe('round trips close', () => {
  it('rh → W → rh', () => {
    for (const s of STATES) {
      expect(rhFromW(s.tc, s.W, s.p), at(s)).toBeCloseTo(s.rh, 8);
    }
  });

  it('rh → pw → rh', () => {
    for (const s of STATES) {
      expect(rhFromVapor(s.tc, vaporPressure(s.tc, s.rh)), at(s)).toBeCloseTo(s.rh, 8);
    }
  });

  it('W → pw → W', () => {
    for (const s of STATES) {
      const pw = vaporPressureFromW(s.W, s.p, s.tc);
      expect(humidityRatio(s.tc, rhFromVapor(s.tc, pw), s.p), at(s)).toBeCloseTo(s.W, 12);
    }
  });

  it('rh → dew point → rh', () => {
    for (const s of STATES) {
      const tdp = dewPointFrom(s.tc, s.rh);
      expect(tdp, at(s)).not.toBeNull();
      expect(rhFromDewPoint(s.tc, tdp), at(s)).toBeCloseTo(s.rh, 6);
    }
  });

  it('dew point of saturated air is the dry bulb, on both branches', () => {
    for (const s of STATES) {
      expect(dewPoint(satPressure(s.tc)), at(s)).toBeCloseTo(s.tc, 8);
    }
  });

  it('rh → wet bulb → rh (skipping the flagged ambiguous band)', () => {
    let checked = 0;
    for (const s of STATES) {
      const wb = wetBulbSolve(s.tc, s.rh, s.p);
      if (wb.ambiguous || !wb.converged) continue;
      const back = rhFromWetBulb(s.tc, wb.value, s.p);
      expect(back, at(s)).not.toBeNull();
      expect(back, at(s)).toBeCloseTo(s.rh, 6);
      checked++;
    }
    // Guard against the test silently degenerating to "skipped everything".
    expect(checked).toBeGreaterThan(STATES.length * 0.95);
  });
});

// ── Orderings ───────────────────────────────────────────────────────────────

describe('orderings that must hold everywhere', () => {
  it('dew point ≤ wet bulb ≤ dry bulb', () => {
    for (const s of STATES) {
      const d = deriveState(s.tc, s.rh, s.p);
      if (d.twbAmbiguous) continue; // near-freezing band is documented as flagged
      // 1e-9 slack absorbs float noise as the three converge at saturation.
      expect(d.tdpC, `tdp ≤ twb — ${at(s)}`).toBeLessThanOrEqual(d.twbC + 1e-9);
      expect(d.twbC, `twb ≤ tdb — ${at(s)}`).toBeLessThanOrEqual(d.tc + 1e-9);
    }
  });

  it('partial vapour pressure never exceeds saturation pressure', () => {
    for (const s of STATES) {
      expect(vaporPressure(s.tc, s.rh), at(s)).toBeLessThanOrEqual(satPressure(s.tc) + 1e-12);
    }
  });

  it('humidity ratio never exceeds the saturation value at the same T and p', () => {
    for (const s of STATES) {
      expect(s.W, at(s)).toBeLessThanOrEqual(saturationHumidityRatio(s.tc, s.p) + 1e-12);
    }
  });

  it('degree of saturation lies in [0, 1] and tracks RH', () => {
    for (const s of STATES) {
      const mu = degreeOfSaturation(s.tc, s.rh, s.p);
      expect(mu, at(s)).toBeGreaterThanOrEqual(0);
      expect(mu, at(s)).toBeLessThanOrEqual(1 + 1e-12);
      // μ = W/Ws is always slightly below RH/100 for unsaturated moist air.
      expect(mu, at(s)).toBeLessThanOrEqual(s.rh / 100 + 1e-9);
    }
  });

  it('every derived property is finite', () => {
    for (const s of STATES) {
      const d = deriveState(s.tc, s.rh, s.p);
      for (const [k, v] of Object.entries(d)) {
        if (typeof v !== 'number') continue;
        expect(isFinite(v), `${k} finite — ${at(s)}`).toBe(true);
      }
    }
  });
});

// ── Monotonicity ────────────────────────────────────────────────────────────

describe('monotonicity in each variable', () => {
  /** Assert f is strictly increasing (or decreasing) across a swept variable. */
  const sweepStrict = (label, values, f, direction) => {
    let prev = null;
    for (const v of values) {
      const y = f(v);
      if (prev !== null) {
        if (direction > 0) expect(y, `${label} ↑ at ${v}`).toBeGreaterThan(prev);
        else expect(y, `${label} ↓ at ${v}`).toBeLessThan(prev);
      }
      prev = y;
    }
  };
  const range = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

  it('saturation pressure rises with temperature on each branch', () => {
    // Swept per branch: p_ws has a genuine 9.7e-5 step at the 0 °C seam where
    // ASHRAE switches Eq. 5 for Eq. 6, so a cross-seam sweep is not monotone.
    sweepStrict('p_ws over ice', range(-60, -0.01, 200), satPressureIce, +1);
    sweepStrict('p_ws over water', range(0, 60, 200), satPressureWater, +1);
  });

  it('humidity ratio rises with RH, rises with T, and falls with pressure', () => {
    for (const s of STATES.slice(0, 200)) {
      sweepStrict('W vs RH', range(1, 100, 25), (rh) => humidityRatio(s.tc, rh, s.p), +1);
      sweepStrict(
        'W vs T',
        range(Math.max(CORE_DOMAIN.tMinC, s.tc - 8), s.tc + 8, 25),
        (tc) => humidityRatio(tc, s.rh, s.p),
        +1,
      );
      sweepStrict(
        'W vs p',
        range(CORE_DOMAIN.pMinKpa, CORE_DOMAIN.pMaxKpa, 25),
        (p) => humidityRatio(s.tc, s.rh, p),
        -1,
      );
    }
  });

  it('enthalpy rises with temperature and with moisture', () => {
    for (const s of STATES.slice(0, 200)) {
      sweepStrict('h vs T', range(s.tc - 8, s.tc + 8, 25), (tc) => enthalpy(tc, s.W), +1);
      sweepStrict('h vs W', range(0, 0.05, 25), (W) => enthalpy(s.tc, W), +1);
    }
  });

  it('specific volume rises with temperature and falls with pressure', () => {
    for (const s of STATES.slice(0, 200)) {
      sweepStrict('v vs T', range(s.tc - 8, s.tc + 8, 25), (tc) => specificVolume(tc, s.W, s.p), +1);
      sweepStrict(
        'v vs p',
        range(CORE_DOMAIN.pMinKpa, CORE_DOMAIN.pMaxKpa, 25),
        (p) => specificVolume(s.tc, s.W, p),
        -1,
      );
    }
  });

  it('density falls as temperature rises and rises with pressure', () => {
    for (const s of STATES.slice(0, 200)) {
      sweepStrict(
        'ρ vs T',
        range(Math.max(CORE_DOMAIN.tMinC, s.tc - 8), Math.min(CORE_DOMAIN.tMaxC, s.tc + 8), 25),
        (tc) => moistAirDensity(tc, s.rh, s.p),
        -1,
      );
      sweepStrict(
        'ρ vs p',
        range(CORE_DOMAIN.pMinKpa, CORE_DOMAIN.pMaxKpa, 25),
        (p) => moistAirDensity(s.tc, s.rh, p),
        +1,
      );
    }
  });

  it('dew point and wet bulb rise with RH', () => {
    for (const s of STATES.slice(0, 150)) {
      sweepStrict('tdp vs RH', range(1, 100, 20), (rh) => dewPointFrom(s.tc, rh), +1);
      const wbs = range(1, 100, 20).map((rh) => wetBulbSolve(s.tc, rh, s.p));
      if (wbs.some((w) => w.ambiguous || !w.converged)) continue;
      let prev = null;
      for (const w of wbs) {
        if (prev !== null) expect(w.value, `twb ↑ — ${at(s)}`).toBeGreaterThan(prev);
        prev = w.value;
      }
    }
  });

  it('barometric pressure falls with altitude', () => {
    sweepStrict('p vs altitude', range(-1000, 30000, 200), pressureFromAltitude, -1);
  });

  it('transport properties rise with temperature at FIXED COMPOSITION', () => {
    // Deliberately swept at constant vapour mole fraction, not constant RH.
    // At fixed RH the mixture viscosity is genuinely NON-monotonic: warming pulls
    // in more water vapour, which is less viscous than air, and above ~42 °C that
    // composition shift overtakes the kinetic rise. CoolProp shows exactly the
    // same turnover (18.45 µPa·s at 40 °C, peak ~42 °C, 18.21 at 54 °C for
    // 80 % RH / 60 kPa), so this is physics to reproduce, not a bug to fix.
    // Holding composition isolates the kinetic term, which IS monotone.
    for (const s of STATES.slice(0, 100)) {
      const xv = vaporPressure(s.tc, s.rh) / s.p; // vapour mole fraction to hold
      const rhAt = (tc) => Math.min(100, (xv * s.p * 100) / satPressure(tc));
      const span = range(Math.max(CORE_DOMAIN.tMinC, s.tc), Math.min(CORE_DOMAIN.tMaxC, s.tc + 10), 15);
      if (span.length < 3 || rhAt(span[0]) > 100) continue;
      sweepStrict('μ vs T', span, (tc) => viscosity(tc, rhAt(tc), s.p), +1);
      sweepStrict('k vs T', span, (tc) => thermalConductivity(tc, rhAt(tc), s.p), +1);
    }
  });

  it('reproduces the fixed-RH viscosity turnover CoolProp shows', () => {
    // The converse of the test above: pin the non-monotonic behaviour so nobody
    // "fixes" it into a monotone curve that would disagree with the oracle.
    const at60kPa = [40, 42, 44, 46, 48, 50, 52, 54].map((tc) => viscosity(tc, 80, 60));
    const peak = at60kPa.indexOf(Math.max(...at60kPa));
    expect(peak, 'viscosity should peak in the low 40s °C, not at an endpoint').toBeGreaterThan(0);
    expect(peak).toBeLessThan(at60kPa.length - 1);
    expect(at60kPa[at60kPa.length - 1]).toBeLessThan(at60kPa[0]);
  });
});

// ── Saturation limits ───────────────────────────────────────────────────────

describe('saturation limits', () => {
  it('at RH = 100 the three temperatures coincide', () => {
    for (const s of STATES.slice(0, 300)) {
      const d = deriveState(s.tc, 100, s.p);
      expect(d.tdpC, `tdp = tdb at saturation — ${at(s)}`).toBeCloseTo(s.tc, 6);
      expect(d.twbC, `twb = tdb at saturation — ${at(s)}`).toBeCloseTo(s.tc, 6);
      expect(d.mu, `μ = 1 at saturation — ${at(s)}`).toBeCloseTo(1, 9);
    }
  });

  it('at RH = 0 there is no moisture and no dew point', () => {
    for (const s of STATES.slice(0, 100)) {
      expect(humidityRatio(s.tc, 0, s.p)).toBe(0);
      expect(dewPointFrom(s.tc, 0)).toBeNull();
      expect(degreeOfSaturation(s.tc, 0, s.p)).toBe(0);
      // Dry-air enthalpy and volume stay finite and physical.
      expect(isFinite(enthalpy(s.tc, 0))).toBe(true);
      expect(specificVolume(s.tc, 0, s.p)).toBeGreaterThan(0);
    }
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('every core function is bit-identical on repeat calls', () => {
    // Guards against a Date, Math.random or cached-state leak sneaking into what
    // must be pure functions — the property that makes the oracle meaningful.
    const fns = [
      ['satPressure', (s) => satPressure(s.tc)],
      ['humidityRatio', (s) => humidityRatio(s.tc, s.rh, s.p)],
      ['dewPointFrom', (s) => dewPointFrom(s.tc, s.rh)],
      ['wetBulb', (s) => wetBulbSolve(s.tc, s.rh, s.p).value],
      ['enthalpy', (s) => enthalpy(s.tc, s.W)],
      ['specificVolume', (s) => specificVolume(s.tc, s.W, s.p)],
      ['entropy', (s) => entropy(s.tc, s.rh, s.p)],
      ['viscosity', (s) => viscosity(s.tc, s.rh, s.p)],
      ['thermalConductivity', (s) => thermalConductivity(s.tc, s.rh, s.p)],
      ['moistAirDensity', (s) => moistAirDensity(s.tc, s.rh, s.p)],
    ];
    for (const s of STATES.slice(0, 300)) {
      for (const [name, f] of fns) {
        expect(Object.is(f(s), f(s)), `${name} — ${at(s)}`).toBe(true);
      }
    }
  });

  it('deriveState is order-independent and non-mutating', () => {
    const s = STATES[0];
    const a = deriveState(s.tc, s.rh, s.p);
    // Interleave other work, then re-derive: nothing may have been cached.
    for (const other of STATES.slice(1, 50)) deriveState(other.tc, other.rh, other.p);
    expect(deriveState(s.tc, s.rh, s.p)).toEqual(a);
  });
});

// ── Envelopes at every pressure ─────────────────────────────────────────────

describe('envelope geometry holds at every site pressure', () => {
  const PRESSURES = [60, 79.5, 85, 101.325, 108];

  it('A1 ⊂ A2 ⊂ A3 ⊂ A4 at all pressures', () => {
    const order = ['A1', 'A2', 'A3', 'A4'];
    for (const p of PRESSURES) {
      for (let i = 0; i < order.length - 1; i++) {
        const inner = ASHRAE_ENVELOPES[order[i]];
        const outer = ASHRAE_ENVELOPES[order[i + 1]];
        for (let t = inner.tMin; t <= inner.tMax; t += 0.5) {
          const ctx = `${order[i]} ⊂ ${order[i + 1]} at ${t}°C ${p}kPa`;
          expect(upperW(t, outer, p), ctx).toBeGreaterThanOrEqual(upperW(t, inner, p) - 1e-9);
          expect(lowerW(t, outer, p), ctx).toBeLessThanOrEqual(lowerW(t, inner, p) + 1e-9);
        }
      }
    }
  });

  it('every polygon vertex is finite, non-negative and correctly ordered', () => {
    for (const p of PRESSURES) {
      for (const [name, env] of Object.entries(ASHRAE_ENVELOPES)) {
        const pts = envelopePolygon(env, p);
        expect(pts.length, `${name}@${p}`).toBeGreaterThan(20);
        for (const [t, w] of pts) {
          expect(isFinite(t) && isFinite(w), `${name}@${p} vertex (${t}, ${w})`).toBe(true);
          expect(w, `${name}@${p} W ≥ 0`).toBeGreaterThanOrEqual(0);
          expect(t, `${name}@${p} within temp bounds`).toBeGreaterThanOrEqual(env.tMin - 1e-9);
          expect(t, `${name}@${p} within temp bounds`).toBeLessThanOrEqual(env.tMax + 1e-9);
        }
        // Lower boundary is below upper across the whole span.
        for (let t = env.tMin; t <= env.tMax; t += 1) {
          expect(lowerW(t, env, p), `${name}@${p} lower < upper at ${t}`).toBeLessThan(
            upperW(t, env, p),
          );
        }
      }
    }
  });

  it('a fixed RH boundary holds more water as pressure falls', () => {
    // Physical: W ∝ 1/p at fixed vapour pressure — this is why the same 45 % RH
    // reading means different absolute moisture in Denver than in Houston, and
    // why every envelope is regenerated per site pressure. Checked at the cold
    // end where the RH curve binds, away from the dew-point cap.
    for (const [name, env] of Object.entries(ASHRAE_ENVELOPES)) {
      const t = env.tMin;
      let prev = -Infinity;
      for (const p of [...PRESSURES].sort((a, b) => b - a)) {
        const w = upperW(t, env, p);
        expect(w, `${name} W ↑ as p ↓ at ${p}kPa`).toBeGreaterThan(prev);
        prev = w;
      }
    }
  });
});

// ── Domain guard completeness ───────────────────────────────────────────────

describe('domain guard is tied to the oracle grid', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const ref = JSON.parse(readFileSync(join(here, 'reference', 'coolprop-reference.json'), 'utf8'));
  const col = Object.fromEntries(ref.columns.map((c, i) => [c, i]));

  it('accepts every in-domain grid row and flags every out-of-domain one', () => {
    // This is what stops the declared band from drifting away from the band that
    // is actually validated: the guard must agree with the grid's own labelling.
    let inOk = 0;
    let outFlagged = 0;
    for (const r of ref.rows) {
      const res = checkDomain(r[col.t_c], r[col.rh_pct], r[col.p_kpa]);
      const hardFlags = res.warnings.filter(
        (w) => !['wetbulb-ambiguous', 'pressure-eq'].includes(w.code),
      );
      if (r[col.core] === 1) {
        expect(hardFlags, `in-domain must not be flagged: ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toEqual([]);
        inOk++;
      } else {
        expect(hardFlags.length, `out-of-domain must be flagged: ${r[col.t_c]}°C ${r[col.rh_pct]}% ${r[col.p_kpa]}kPa`).toBeGreaterThan(0);
        outFlagged++;
      }
    }
    expect(inOk).toBeGreaterThan(3000);
    expect(outFlagged).toBeGreaterThan(500);
  });

  it('rejects non-numeric and impossible inputs outright', () => {
    for (const bad of [
      [NaN, 50, 101.325],
      [25, NaN, 101.325],
      [25, 50, NaN],
      [25, -5, 101.325],
      [25, 150, 101.325],
    ]) {
      expect(checkDomain(...bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
