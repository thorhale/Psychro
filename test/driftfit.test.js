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
    const f = driftFit(
      [{ date: day(0), err: 3 }, { date: day(5), err: 2 }, { date: day(10), err: 1 }], 5);
    expect(f.slopePerDay).toBeCloseTo(-0.2, 10);
    expect(f.daysToBand).toBeCloseTo(30, 8);
  });

  it('a perfectly flat fit reports null — never, at this trend', () => {
    const f = driftFit(
      [{ date: day(0), err: 1 }, { date: day(5), err: 1 }, { date: day(10), err: 1 }], 5);
    expect(f.slopePerDay).toBe(0);
    expect(f.daysToBand).toBeNull();
  });

  it('negative drift toward the negative band extrapolates correctly', () => {
    const f = driftFit(
      [{ date: day(0), err: -1 }, { date: day(5), err: -1.5 }, { date: day(10), err: -2 }], 5);
    expect(f.slopePerDay).toBeCloseTo(-0.1, 10);
    expect(f.daysToBand).toBeCloseTo(30, 8); // −2 → −5 at −0.1/day
  });

  it('two points fit a line exactly, so they earn no forecast at all', () => {
    // n = 2 has zero residuals — any claimed precision is fiction. The slope
    // is still reported (it is arithmetic), but the days-to-band forecast and
    // the standard error require a third, independent check.
    const f = driftFit([{ date: day(0), err: 1 }, { date: day(10), err: 2 }], 5);
    expect(f.slopePerDay).toBeCloseTo(0.1, 10);
    expect(f.daysToBand).toBeNull();
    expect(f.seSlope).toBeNull();
    expect(f.residualSd).toBeNull();
  });

  it('with scatter, the forecast is a range from slope ± its standard error', () => {
    // Alternating noise around +0.1/day: seSlope > 0, so the ETA spreads into
    // [sooner, later] around the central estimate — and the steeper edge is
    // always the sooner one.
    const noise = [0.2, -0.2, 0.2, -0.2, 0.2, -0.2];
    const entries = noise.map((nz, i) => ({ date: day(i * 10), err: 0.1 * i * 10 + nz }));
    const f = driftFit(entries, 10);
    expect(f.seSlope).toBeGreaterThan(0);
    expect(f.daysToBand).toBeGreaterThan(0);
    expect(f.daysToBandLo).toBeLessThan(f.daysToBand);
    expect(f.daysToBandHi).toBeGreaterThan(f.daysToBand);
  });

  it('a clean exact fit has zero standard error and a degenerate range', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ date: day(i * 10), err: i }));
    const f = driftFit(entries, 100);
    expect(f.residualSd).toBeCloseTo(0, 8);
    expect(f.daysToBandLo).toBeCloseTo(f.daysToBand, 6);
    expect(f.daysToBandHi).toBeCloseTo(f.daysToBand, 6);
  });

  it('refuses to fit what cannot be fitted', () => {
    expect(driftFit([], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }, { date: day(0), err: 2 }], 5)).toBeNull(); // zero span
    expect(driftFit([{ date: 'garbage', err: 1 }, { date: day(1), err: 2 }], 5)).toBeNull();
    expect(driftFit([{ date: day(0), err: 1 }, { date: day(1), err: 2 }], 0)).toBeNull();
  });
});
