/**
 * The energy and mass chains, checked against hand arithmetic.
 *
 * The psychrometric functions are already validated against CoolProp. What
 * these tests check is the plumbing BUILT ON them — the steps that turn a
 * nameplate figure into a rate an operator acts on:
 *
 *     kW installed → °F/hr the room can move
 *     CFM over wet media → lb/hr of water
 *
 * Nothing here re-derives psychrometrics. Each test computes the answer a
 * second, independent way — from first principles, with the units written
 * out — and requires the app to agree. A sign error, a missing 3600, or a
 * Kelvin/Fahrenheit mix-up in either chain shows up as a factor, not a nudge.
 */

import { describe, it, expect } from 'vitest';
import { humidityRatio, specificVolume, wetBulb } from '../src/core/psychro.js';
import { fToC, ft3ToM3, cfmToM3s, kgToLb } from '../src/core/units.js';
import { ratesFromTotals, inventoryTotals, normalizeInventory } from '../src/core/equipment.js';
import { evapMediaOutput, effectivenessFromOutput } from '../src/core/evapmedia.js';

const P = 101.325; //   sea level, kPa
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ── kW → °F/hr ──────────────────────────────────────────────────────────────

describe('the thermal chain: kilowatts become °F per hour', () => {
  /**
   * The hall's heat capacity, computed here from scratch:
   *   volume ft³ → m³ → ÷ specific volume → kg dry air
   *   × (1.006 + 1.86·W) kJ/kg·K → kJ/K
   */
  function capacity(volFt3, tempF, rh) {
    const w = humidityRatio(fToC(tempF), rh, P);
    const v = specificVolume(fToC(tempF), w, P);
    const kgDryAir = ft3ToM3(volFt3) / v;
    return kgDryAir * (1.006 + 1.86 * w);
  }

  it('one kilowatt-hour raises the room by exactly its own heat capacity', () => {
    const C = capacity(200000, 68, 45); //  kJ/K
    // 100 kW for one hour is 100 × 3600 = 360 000 kJ. Divided by kJ/K that is
    // a rise in KELVIN; ×1.8 converts a temperature DIFFERENCE to Fahrenheit.
    const expectedF = ((100 * 3600) / C) * 1.8;

    const r = ratesFromTotals({ ...inventoryTotals([]), heatKW: 100 }, { cKJperK: C });
    expect(rel(r.rateWarmF, expectedF)).toBeLessThan(1e-3); // rounded to 0.1
  });

  it('uses the DELTA conversion, not the absolute one', () => {
    // The classic bug: converting a rise of 10 K as if it were a temperature,
    // giving 10 × 9/5 + 32. That would add a fixed 32 °F/hr to every rate, so
    // halving the power would not halve the answer.
    const C = capacity(200000, 68, 45);
    const at100 = ratesFromTotals({ ...inventoryTotals([]), heatKW: 100 }, { cKJperK: C });
    const at50 = ratesFromTotals({ ...inventoryTotals([]), heatKW: 50 }, { cKJperK: C });
    expect(rel(at100.rateWarmF, at50.rateWarmF * 2)).toBeLessThan(2e-3);
  });

  it('a bigger, damper hall is harder to move — in the right proportion', () => {
    const small = capacity(100000, 68, 45);
    const big = capacity(200000, 68, 45);
    expect(rel(big, small * 2)).toBeLessThan(1e-9); //  capacity scales with volume

    // Moist air holds more heat per kilogram, so a damp hall moves slower even
    // at the same volume — and it is also less dense, which partly offsets.
    const dry = capacity(200000, 68, 10);
    const damp = capacity(200000, 68, 90);
    expect(damp).toBeGreaterThan(dry);
    expect(rel(damp, dry)).toBeLessThan(0.02); // a small effect, not a large one
  });

  it('a real inventory produces a rate that matches the hand figure', () => {
    // Four 30-ton CRAHs against a 200 kW IT load, in a 200 000 ft³ hall.
    const inv = normalizeInventory([{ kind: 'cool', count: 4, cap: 30, unit: 'ton' }]);
    const C = capacity(200000, 68, 45);
    const r = ratesFromTotals(inventoryTotals(inv), { cKJperK: C, itKW: 200 });

    const installedKW = 4 * 30 * 3.51685; //   422.02 kW
    const spare = installedKW - 200; //        222.02 kW available to pull down
    expect(rel(r.rateCoolF, ((spare * 3600) / C) * 1.8)).toBeLessThan(1e-3);
  });
});

// ── CFM over wet media → lb/hr ──────────────────────────────────────────────

describe('the moisture chain: airflow over media becomes pounds per hour', () => {
  /**
   * Water picked up, computed here from scratch:
   *   CFM → m³/s → ÷ specific volume → kg dry air/s
   *   × Δw (kg water / kg dry air) → kg water/s → lb/hr
   */
  function waterLbHr(cfm, tempF, rh, effPct) {
    const tc = fToC(tempF);
    const wIn = humidityRatio(tc, rh, P);
    const wSat = humidityRatio(wetBulb(tc, rh, P), 100, P);
    const dw = (wSat - wIn) * (effPct / 100);
    const kgDaPerS = cfmToM3s(cfm) / specificVolume(tc, wIn, P);
    return kgToLb(kgDaPerS * dw) * 3600;
  }

  it('agrees with the mass balance written out longhand', () => {
    for (const [t, rh] of [[75, 20], [68, 45], [70, 30], [85, 15], [60, 60]]) {
      const got = evapMediaOutput({ cfm: 10000, tempF: t, rh, effPct: 85, pressure: P });
      expect(rel(got.lbPerHr, waterLbHr(10000, t, rh, 85)), `${t}F/${rh}%`).toBeLessThan(1e-9);
    }
  });

  it('is linear in airflow and in effectiveness, and nothing else', () => {
    const base = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 30, effPct: 85, pressure: P });
    const twiceAir = evapMediaOutput({ cfm: 20000, tempF: 70, rh: 30, effPct: 85, pressure: P });
    const halfEff = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 30, effPct: 42.5, pressure: P });
    expect(rel(twiceAir.lbPerHr, base.lbPerHr * 2)).toBeLessThan(1e-12);
    expect(rel(halfEff.lbPerHr, base.lbPerHr / 2)).toBeLessThan(1e-12);
  });

  it('cannot exceed saturation, and stops at it', () => {
    // Perfect media into already-saturated air can pick up nothing.
    const sat = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 100, effPct: 100, pressure: P });
    expect(sat.lbPerHr).toBeCloseTo(0, 6);
    // At 100 % effectiveness the leaving air IS at its wet bulb.
    const full = evapMediaOutput({ cfm: 10000, tempF: 80, rh: 20, effPct: 100, pressure: P });
    expect(full.leavingTempF).toBeCloseTo(full.twbF, 6);
    expect(full.wOut).toBeCloseTo(full.wMax, 12);
  });

  it('conserves energy: the air leaves cooler by the evaporation it did', () => {
    // Adiabatic saturation — the latent heat comes out of the airstream, so
    // the drop toward wet bulb tracks the effectiveness exactly.
    const r = evapMediaOutput({ cfm: 10000, tempF: 85, rh: 15, effPct: 60, pressure: P });
    const drop = 85 - r.leavingTempF;
    expect(rel(drop, (85 - r.twbF) * 0.6)).toBeLessThan(1e-12);
  });

  it('inverts: a measured output reveals the effectiveness actually achieved', () => {
    // The mineral-scaling case, and the only honest way to find it.
    const clean = evapMediaOutput({ cfm: 9000, tempF: 72, rh: 25, effPct: 90, pressure: P });
    const fouled = evapMediaOutput({ cfm: 9000, tempF: 72, rh: 25, effPct: 55, pressure: P });
    expect(
      effectivenessFromOutput({ cfm: 9000, tempF: 72, rh: 25, lbPerHr: fouled.lbPerHr, pressure: P }),
    ).toBeCloseTo(55, 6);
    expect(
      effectivenessFromOutput({ cfm: 9000, tempF: 72, rh: 25, lbPerHr: clean.lbPerHr, pressure: P }),
    ).toBeCloseTo(90, 6);
  });

  it('at altitude the same media moves LESS water, and says why', () => {
    // Two effects pull opposite ways, and the direction is not obvious:
    //
    //   moisture gain per kg  RISES — thinner air holds more at the same RH,
    //                                 so Δw goes 3.30 → 3.65 g/kg (+10 %)
    //   dry air per CFM       FALLS — specific volume goes 0.840 → 1.072 m³/kg,
    //                                 so a fixed VOLUME carries 22 % less mass
    //
    // Mass flow wins. A humidifier sized by CFM at sea level delivers about
    // 14 % less at 7 000 ft, which is why this is computed at the hall's own
    // pressure rather than rated once.
    const low = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 30, effPct: 85, pressure: 101.325 });
    const high = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 30, effPct: 85, pressure: 79.5 });
    expect(high.lbPerHr).toBeLessThan(low.lbPerHr);
    expect(high.lbPerHr / low.lbPerHr).toBeCloseTo(0.864, 2);

    // The mechanism, pinned so a future change cannot get the right total for
    // the wrong reason: more moisture per kilogram, fewer kilograms.
    expect(high.wIn).toBeGreaterThan(low.wIn);
    expect(high.wMax - high.wIn).toBeGreaterThan(low.wMax - low.wIn);

    // Monotonic across the whole supported range — no crossover hiding in it.
    let prev = Infinity;
    for (const p of [101.325, 95, 90, 85, 79.5, 70, 60]) {
      const out = evapMediaOutput({ cfm: 10000, tempF: 70, rh: 30, effPct: 85, pressure: p }).lbPerHr;
      expect(out, `${p} kPa`).toBeLessThan(prev);
      prev = out;
    }
  });
});
