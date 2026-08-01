/**
 * Drift fit — least squares with honest edge behavior.
 */

import { describe, it, expect } from 'vitest';
import { driftFit } from '../src/core/driftfit.js';

const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

describe('driftFit', () => {
  it('recovers a clean linear drift exactly', () => {
    // +0.1 %RH per day for 30 days, starting at 0.
    const entries = Array.from({ length: 7 }, (_, i) => ({ date: day(i * 5), err: i * 5 * 0.1 }));
    const f = driftFit(entries, 5);
    expect(f).not.toBeNull();
    expect(f.slopePerDay).toBeCloseTo(0.1, 10);
    expect(f.perMonth).toBeCloseTo(3, 10);
    expect(f.latestErr).toBeCloseTo(3, 10);
    // Latest 3.0, band 5, slope 0.1 → 20 more days.
    expect(f.daysToBand).toBeCloseTo(20, 8);
  });

  it('fits through noise without bias (symmetric residuals)', () => {
    const noise = [0.05, -0.05, 0.04, -0.04, 0.03, -0.03];
    const entries = noise.map((n, i) => ({ date: day(i * 10), err: 0.05 * i * 10 + n }));
    const f = driftFit(entries, 5);
    expect(f.slopePerDay).toBeCloseTo(0.05, 2);
  });

  it('a sensor already outside the band reports 0 days', () => {
    const f = driftFit([{ date: day(0), err: 1 }, { date: day(10), err: 6 }], 5);
    expect(f.daysToBand).toBe(0);
  });

  it('an "improving" sensor still gets a crossing time for the far band', () => {
    // err 3 → 1 over 10 days: slope −0.2/day. The trend passes through zero
    // and exits at −5 in (−5 − 1)/(−0.2) = 30 days. A linear model owes that
    // number — "improving" is just drift that hasn't crossed zero yet.
    const f = driftFit([{ date: day(0), err: 3 }, { date: day(10), err: 1 }], 5);
    expect(f.slopePerDay).toBeCloseTo(-0.2, 10);
    expect(f.daysToBand).toBeCloseTo(30, 8);
  });

  it('a perfectly flat fit reports null — never, at this trend', () => {
    const f = driftFit([{ date: day(0), err: 1 }, { date: day(10), err: 1 }], 5);
    expect(f.slopePerDay).toBe(0);
    expect(f.daysToBand).toBeNull();
  });

  it('negative drift toward the negative band extrapolates correctly', () => {
    const f = driftFit([{ date: day(0), err: -1 }, { date: day(10), err: -2 }], 5);
    expect(f.slopePerDay).toBeCloseTo(-0.1, 10);
    expect(f.daysToBand).toBeCloseTo(30, 8); // −2 → −5 at −0.1/day
  });

  it('refuses to fit what cannot be fitted', () => {
    expect(driftFit([], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }, { date: day(0), err: 2 }], 5)).toBeNull(); // zero span
    expect(driftFit([{ date: 'garbage', err: 1 }, { date: day(1), err: 2 }], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }, { date: day(1), err: 2 }], 0)).toBeNull();
  });
});
