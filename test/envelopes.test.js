/**
 * TC 9.9 envelope geometry: containment ordering, boundary correctness,
 * pressure sensitivity, and SLA polygon behaviour.
 */

import { describe, it, expect } from 'vitest';
import {
  ASHRAE_ENVELOPES,
  envelopePolygon,
  slaPolygon,
  upperW,
  lowerW,
  ashraeZone,
  checkSLA,
} from '../src/core/envelopes.js';
import { humidityRatioG, dewPointFrom } from '../src/core/psychro.js';

const P0 = 101.325;

describe('envelope polygons', () => {
  it('produce a closed, non-degenerate loop for every class', () => {
    for (const [name, env] of Object.entries(ASHRAE_ENVELOPES)) {
      const pts = envelopePolygon(env, P0);
      expect(pts.length, name).toBeGreaterThan(20);
      for (const [t, w] of pts) {
        expect(isFinite(t), name).toBe(true);
        expect(isFinite(w), name).toBe(true);
        expect(w, name).toBeGreaterThanOrEqual(0);
      }
      // Bottom edge below top edge at the midpoint temperature.
      const midT = (env.tMin + env.tMax) / 2;
      expect(lowerW(midT, env, P0), name).toBeLessThan(upperW(midT, env, P0));
    }
  });

  it('nest: A1 ⊂ A2 ⊂ A3 ⊂ A4 across each shared temperature range', () => {
    const order = ['A1', 'A2', 'A3', 'A4'];
    for (let i = 0; i < order.length - 1; i++) {
      const inner = ASHRAE_ENVELOPES[order[i]];
      const outer = ASHRAE_ENVELOPES[order[i + 1]];
      expect(outer.tMin).toBeLessThanOrEqual(inner.tMin);
      expect(outer.tMax).toBeGreaterThanOrEqual(inner.tMax);
      for (let t = inner.tMin; t <= inner.tMax; t += 1) {
        expect(upperW(t, outer, P0)).toBeGreaterThanOrEqual(upperW(t, inner, P0) - 1e-9);
        expect(lowerW(t, outer, P0)).toBeLessThanOrEqual(lowerW(t, inner, P0) + 1e-9);
      }
    }
  });

  it('upper boundary switches from RH curve to dew-point cap where they cross', () => {
    const env = ASHRAE_ENVELOPES.A1; // rhMax 80, dpMax 17 °C
    // Cold end: RH curve binds (W at 80 % RH is below the 17 °C-dew-point line).
    expect(upperW(15, env, P0)).toBeCloseTo(humidityRatioG(15, 80, P0), 6);
    // Hot end: dew-point cap binds — a near-constant-W line. (Not exactly
    // constant: the enhancement factor is evaluated at the dry bulb, so W along
    // a fixed-dew-point line drifts by ~0.01 % per °C. That is the physics of
    // the real-gas correction, not an error.)
    expect(upperW(32, env, P0)).toBeLessThan(humidityRatioG(32, 80, P0));
    expect(upperW(30, env, P0)).toBeCloseTo(upperW(32, env, P0), 2);
  });

  it('polygons are pressure-aware: same RH boundary holds more water at altitude', () => {
    const env = ASHRAE_ENVELOPES.A2;
    const denver = 79.5;
    // RH-curve region (cold end): W at fixed RH rises as pressure falls.
    expect(upperW(10, env, denver)).toBeGreaterThan(upperW(10, env, P0));
  });
});

describe('ashraeZone', () => {
  it('classifies canonical points', () => {
    expect(ashraeZone(22, 45, P0)).toBe('A1');
    expect(ashraeZone(34, 30, P0)).toBe('A2');
    expect(ashraeZone(38, 30, P0)).toBe('A3');
    expect(ashraeZone(44, 30, P0)).toBe('A4');
    expect(ashraeZone(50, 30, P0)).toBe('Out');
    expect(ashraeZone(22, 95, P0)).toBe('Out');
  });

  it('respects the dew-point discriminators, not just RH', () => {
    // 30 °C / 62 %: dew point ≈ 21.4 °C — above A2's 21 °C cap but inside A3's 24.
    const dp = dewPointFrom(30, 62);
    expect(dp).toBeGreaterThan(21);
    expect(ashraeZone(30, 62, P0)).toBe('A3');
  });
});

describe('SLA polygons and compliance', () => {
  const sla = { tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 };

  it('slaPolygon traces the same shape family as the built-ins', () => {
    const pts = slaPolygon(sla, P0);
    expect(pts.length).toBeGreaterThan(20);
    for (const [t, w] of pts) {
      expect(isFinite(t)).toBe(true);
      expect(isFinite(w)).toBe(true);
    }
  });

  it('checkSLA reports the specific violated bound', () => {
    expect(checkSLA(sla, 72, 45, P0).ok).toBe(true);
    expect(checkSLA(sla, 50, 45, P0)).toEqual({ ok: false, reason: 'below temp min' });
    expect(checkSLA(sla, 95, 45, P0)).toEqual({ ok: false, reason: 'above temp max' });
    expect(checkSLA(sla, 72, 5, P0)).toEqual({ ok: false, reason: 'below RH min' });
    expect(checkSLA(sla, 72, 90, P0)).toEqual({ ok: false, reason: 'above RH max' });
    // 85 °F / 75 %: inside the temp/RH box but past the 62.6 °F dew-point cap.
    expect(checkSLA(sla, 85, 75, P0)).toEqual({ ok: false, reason: 'above dew point cap' });
  });

  it('a missing dew-point cap disables that check', () => {
    const noCap = { ...sla, dpMaxF: null };
    expect(checkSLA(noCap, 85, 75, P0).ok).toBe(true);
  });
});
