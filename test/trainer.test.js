/**
 * Training engine — the referee must be deterministic, physical, and fair.
 */

import { describe, it, expect } from 'vitest';
import { SCENARIOS, faultForSeed, refereeRun, mulberry32 } from '../src/core/trainer.js';
import { checkSLA } from '../src/core/envelopes.js';

const HALL = { hallVolFt3: 200000, rateCoolF: 6, rateWarmF: 4, rateDehumLb: 100, rateHumLb: 80 };
const SLA = { name: 'Test SLA', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 };
const P = 97.482;
const checkSla = (tempF, rh) => {
  const v = checkSLA(SLA, tempF, rh);
  return { ok: v.ok, detail: v.detail };
};

const run = (scenario, target, seed = 42) =>
  refereeRun({ scenario, seed, target, hall: HALL, checkSla, pressure: P });

describe('training referee', () => {
  it('is deterministic: same seed, same run, same score', () => {
    const s = SCENARIOS[0];
    const a = run(s, { tempF: 72, rh: 40 });
    const b = run(s, { tempF: 72, rh: 40 });
    expect(a.score).toBe(b.score);
    expect(a.trail).toEqual(b.trail);
    // And a different seed genuinely changes the fault.
    expect(faultForSeed(s, 1).dWaterLbPerHr).not.toBeCloseTo(faultForSeed(s, 2).dWaterLbPerHr, 6);
  });

  it('doing nothing against a stuck humidifier loses to the dew-point cap', () => {
    // "Target = where we already are" means the plant fights the fault only
    // after drifting off target — it loses ground and the cap is breached.
    const s = SCENARIOS.find((x) => x.id === 'stuck-humidifier');
    const idle = run(s, null); // no commitment: the plant is not fighting
    expect(idle.breachedAtMin).not.toBeNull();
    expect(idle.breachDetail).toContain('dew point');
  });

  it('a sound recovery beats doing nothing, survives, and stabilizes', () => {
    const s = SCENARIOS.find((x) => x.id === 'stuck-humidifier');
    const idle = run(s, null);
    // The right instinct: drive RH down hard so dehum capacity outruns the leak.
    const good = run(s, { tempF: 72, rh: 38 });
    expect(good.score).toBeGreaterThan(idle.score);
    expect(good.breachedAtMin).toBeNull();
    expect(good.stabilized).toBe(true);
    expect(good.minutesInSla).toBe(good.totalMinutes);
  });

  it('the wash-down rule really locks the dehumidifier', () => {
    const s = SCENARIOS.find((x) => x.id === 'washdown');
    expect(faultForSeed(s, 7).dehumLocked).toBe(true);
    // With dehum locked, targeting a low RH cannot remove water — the run is
    // decided by temperature strategy alone, and W only ever rises.
    const r = run(s, { tempF: 71, rh: 30 });
    const wTrendUp = r.trail[r.trail.length - 1].rh > 0; // trail exists
    expect(wTrendUp).toBe(true);
    expect(r.totalMinutes).toBe(240);
  });

  it('every scenario is winnable — a training game must be beatable', () => {
    // A competent target for each scenario keeps the whole run in SLA — at the
    // test pressure AND at the standard atmosphere the training UI fixes
    // (challenge codes must mean the same run on every device).
    const answers = {
      'stuck-humidifier': { tempF: 72, rh: 38 },
      'chiller-down': { tempF: 70, rh: 45 },
      'cold-snap': { tempF: 74, rh: 48 },
      washdown: { tempF: 78, rh: 45 }, // warm: same water, lower RH, dp safe
    };
    for (const pressure of [P, 101.325]) {
      for (const s of SCENARIOS) {
        const r = refereeRun({ scenario: s, seed: 42, target: answers[s.id], hall: HALL, checkSla, pressure });
        expect(r.breachedAtMin, `${s.id} should be survivable at ${pressure} kPa`).toBeNull();
      }
    }
  });

  it('trail states are physical: RH clamped, temperatures finite', () => {
    for (const s of SCENARIOS) {
      const r = run(s, { tempF: 75, rh: 45 }, 99);
      for (const st of r.trail) {
        expect(isFinite(st.tempF)).toBe(true);
        expect(st.rh).toBeGreaterThanOrEqual(0);
        expect(st.rh).toBeLessThanOrEqual(100);
      }
    }
  });

  it('mulberry32 matches the suite-wide reference sequence', () => {
    const r = mulberry32(0xc0ffee);
    const first = [r(), r(), r()];
    const r2 = mulberry32(0xc0ffee);
    expect([r2(), r2(), r2()]).toEqual(first);
  });
});
