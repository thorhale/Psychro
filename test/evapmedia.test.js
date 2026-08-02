/**
 * Wetted-media humidifier output.
 *
 * No manufacturer's curve is encoded here — effectiveness is an input. What
 * these fixtures pin is that the MODEL is the standard adiabatic one and that
 * it behaves correctly where an operator's intuition would be tested: thirsty
 * air absorbs more, fouled media delivers less, and the arithmetic inverts so
 * a measured output reveals the effectiveness actually being achieved.
 */

import { describe, it, expect } from 'vitest';
import { evapMediaOutput, effectivenessFromOutput } from '../src/core/evapmedia.js';
import { humidityRatio, wetBulb } from '../src/core/psychro.js';
import { fToC } from '../src/core/units.js';

const P0 = 101.325;
const base = { cfm: 10000, tempF: 70, rh: 30, effPct: 85, pressure: P0 };

describe('evapMediaOutput', () => {
  it('matches the adiabatic definition it claims to implement', () => {
    // Recompute from the core directly: ṁ_da · ε · (W_sat(T_wb) − W_in).
    const r = evapMediaOutput(base);
    const tc = fToC(base.tempF);
    const wIn = humidityRatio(tc, base.rh, P0);
    const wMax = humidityRatio(wetBulb(tc, base.rh, P0), 100, P0);
    expect(r.wIn).toBeCloseTo(wIn, 12);
    expect(r.wMax).toBeCloseTo(wMax, 12);
    expect(r.gainG / 1000).toBeCloseTo((wMax - wIn) * 0.85, 12);
    // Leaving air is cooler and wetter — evaporation is not free.
    expect(r.leavingTempF).toBeLessThan(base.tempF);
    expect(r.wOut).toBeGreaterThan(r.wIn);
  });

  it('output scales exactly with effectiveness — which is what fouling attacks', () => {
    const clean = evapMediaOutput({ ...base, effPct: 90 });
    const fouled = evapMediaOutput({ ...base, effPct: 60 });
    expect(fouled.lbPerHr / clean.lbPerHr).toBeCloseTo(60 / 90, 10);
    // Zero effectiveness is no humidifier at all, not a negative one.
    expect(evapMediaOutput({ ...base, effPct: 0 })).toBeNull();
  });

  it('thirsty air absorbs far more than damp air — the reason a nameplate lies', () => {
    // Same unit, same airflow, same effectiveness: only the entering air
    // differs. 75 °F/20 % yields ~187 lb/hr against ~108 lb/hr at 68 °F/45 %
    // — a 70 % swing that no single nameplate figure can represent, which is
    // the whole argument for computing this instead of typing it.
    const dry = evapMediaOutput({ ...base, tempF: 75, rh: 20 });
    const damp = evapMediaOutput({ ...base, tempF: 68, rh: 45 });
    expect(dry.lbPerHr / damp.lbPerHr).toBeGreaterThan(1.6);
    // Air already saturated cannot take any more, at any effectiveness.
    const wet = evapMediaOutput({ ...base, rh: 100 });
    expect(wet.lbPerHr).toBeCloseTo(0, 6);
  });

  it('doubling the airflow doubles the water', () => {
    const a = evapMediaOutput({ ...base, cfm: 5000 });
    const b = evapMediaOutput({ ...base, cfm: 10000 });
    expect(b.lbPerHr / a.lbPerHr).toBeCloseTo(2, 6);
  });

  it('is pressure-aware, like everything else in this app', () => {
    const sea = evapMediaOutput(base);
    const denver = evapMediaOutput({ ...base, pressure: 84 });
    // Thinner air carries less mass per ft³ but each kg takes on more water at
    // a given RH; the two do not cancel, so the answers must differ.
    expect(denver.lbPerHr).not.toBeCloseTo(sea.lbPerHr, 3);
    expect(denver.lbPerHr).toBeGreaterThan(0);
  });

  it('refuses inputs that cannot produce an answer', () => {
    for (const bad of [
      { cfm: 0 }, { cfm: -100 }, { pressure: 0 },
      { tempF: NaN }, { rh: NaN }, { effPct: null },
    ]) {
      expect(evapMediaOutput({ ...base, ...bad }), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('effectivenessFromOutput', () => {
  it('round-trips: the effectiveness that produced an output is recovered', () => {
    for (const eff of [95, 85, 62, 40]) {
      const out = evapMediaOutput({ ...base, effPct: eff });
      expect(effectivenessFromOutput({ ...base, lbPerHr: out.lbPerHr })).toBeCloseTo(eff, 8);
    }
  });

  it('quantifies fouling: a measured shortfall becomes a percentage', () => {
    // Commissioned at 90 %, now measured at two thirds of that output.
    const clean = evapMediaOutput({ ...base, effPct: 90 });
    const nowEff = effectivenessFromOutput({ ...base, lbPerHr: clean.lbPerHr * (2 / 3) });
    expect(nowEff).toBeCloseTo(60, 6);
  });

  it('cannot solve when the air could not absorb anything anyway', () => {
    // Saturated entering air: no output is achievable, so no effectiveness is
    // implied by measuring none. Saying "0 %" there would blame the media for
    // physics.
    expect(effectivenessFromOutput({ ...base, rh: 100, lbPerHr: 0 })).toBeNull();
    expect(effectivenessFromOutput({ ...base, cfm: 0, lbPerHr: 5 })).toBeNull();
  });
});
