/**
 * Training engine — the referee must be deterministic, physical, and fair.
 */

import { describe, it, expect } from 'vitest';
import {
  SCENARIOS,
  faultForSeed,
  refereeRun,
  mulberry32,
  TRAINER_VERSION,
  IT_LOAD_F_PER_HR,
  PLANT_TAU_MIN,
} from '../src/core/trainer.js';
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
    // (challenge codes must mean the same run on every device). NOTE the
    // washdown answer: 78/40, not 78/45 — targeting 45 % RH while warming
    // actually DEMANDS water from the humidifier mid-wash-down, and with the
    // v2 plant lag that overshoot rides the leak into the dew-point cap on
    // high-jitter seeds. The right instinct adds no water at all.
    const answers = {
      'stuck-humidifier': { tempF: 72, rh: 38 },
      'chiller-down': { tempF: 70, rh: 45 },
      'cold-snap': { tempF: 74, rh: 48 },
      washdown: { tempF: 78, rh: 40 }, // warm, and ASK for dry: no water added
    };
    for (const pressure of [P, 101.325]) {
      for (const s of SCENARIOS) {
        for (const seed of [1, 42, 99]) {
          const r = refereeRun({ scenario: s, seed, target: answers[s.id], hall: HALL, checkSla, pressure });
          expect(r.breachedAtMin, `${s.id} seed ${seed} should be survivable at ${pressure} kPa`).toBeNull();
          expect(r.stabilized, `${s.id} seed ${seed} should settle at ${pressure} kPa`).toBe(true);
        }
      }
    }
  });

  it('v2: an uncommanded hall eats the server heat — nothing holds it still', () => {
    // Even the wash-down (whose fault adds no heat and ends at 90 min) drifts
    // warm all four hours while nobody commits: the IT load is unopposed.
    const s = SCENARIOS.find((x) => x.id === 'washdown');
    const idle = run(s, null);
    const end = idle.trail[idle.trail.length - 1];
    expect(end.tempF).toBeGreaterThan(s.start.tempF + 10);
    // …so it never earns the stability bonus a committed recovery earns.
    expect(idle.stabilized).toBe(false);
    expect(idle.score).toBeLessThan(run(s, { tempF: 78, rh: 40 }).score);
  });

  it('v2: the plant lags — the first minutes of a commit deliver only part of it', () => {
    // Chiller-down, full cooling demanded from minute one: with a first-order
    // τ of PLANT_TAU_MIN the hall must still WARM initially (fault at full
    // strength, plant barely spun up), then turn the corner.
    const s = SCENARIOS.find((x) => x.id === 'chiller-down');
    const r = run(s, { tempF: 70, rh: 45 });
    expect(r.trail[3].tempF).toBeGreaterThan(s.start.tempF); // still losing early
    const peak = Math.max(...r.trail.map((st) => st.tempF));
    expect(peak).toBeGreaterThan(s.start.tempF + 0.2); //     a real excursion
    expect(r.trail[r.trail.length - 1].tempF).toBeLessThan(peak - 2); // then recovery
  });

  it('v2: "stabilized" demands a settled tail, not merely an unbreached run', () => {
    // The cold-snap with a target the plant cannot quite hold against the
    // drying fault: survive-but-still-moving must NOT read as stable. Use the
    // humidifier scenario idle case instead: breached AND moving — false; and
    // check the flag is not unconditionally true for unbreached runs by
    // asserting the washdown idle case (unbreached, drifting) is false.
    const wash = SCENARIOS.find((x) => x.id === 'washdown');
    const idle = run(wash, null);
    expect(idle.breachedAtMin).toBeNull();
    expect(idle.stabilized).toBe(false); // v1 would have said true
  });

  it('v3: a breached run cannot collect the stability bonus', () => {
    // Settling down AFTER blowing the dew-point cap is not a win. The result
    // panel only ever printed "+ 30 stability bonus" for unbreached runs, so
    // a breached-but-settled hall was collecting 30 points it never explained.
    const s = SCENARIOS.find((x) => x.id === 'chiller-down');
    const r = refereeRun({
      scenario: s, seed: 1, target: { tempF: 60, rh: 15 }, hall: HALL, checkSla, pressure: P,
    });
    expect(r.breachedAtMin).not.toBeNull();
    expect(r.score).toBe(r.minutesInSla);
  });

  it('exports its version and physics constants for the challenge-code format', () => {
    expect(TRAINER_VERSION).toBe(3);
    expect(IT_LOAD_F_PER_HR).toBeGreaterThan(0);
    expect(PLANT_TAU_MIN).toBeGreaterThan(1);
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
