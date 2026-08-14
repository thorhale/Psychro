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
  checkRamp,
} from '../src/core/envelopes.js';
import { humidityRatioG, dewPointFrom } from '../src/core/psychro.js';

const P0 = 101.325;

/**
 * The published table, transcribed from ASHRAE TC 9.9 *Thermal Guidelines for
 * Data Processing Environments*, 5th ed. (2021), Table 2.1 — in the SI units
 * the standard is written in. This test exists because the app's contracts are
 * stored in °F and it is very easy for a °C boundary to acquire a rounding
 * error on the way through a conversion; nothing here is converted, so nothing
 * here can drift.
 *
 * The Recommended row is the one that caught a real error: its low-moisture
 * limit is "−9 °C DP AND 8 % RH" — both constraints — and the app had 0 % RH,
 * which draws a recommended envelope slightly larger than the standard's.
 */
const PUBLISHED = {
  Rec: { tMin: 18, tMax: 27, rhMin: 8, rhMax: 60, dpMin: -9, dpMax: 15 },
  A1:  { tMin: 15, tMax: 32, rhMin: 8, rhMax: 80, dpMin: -12, dpMax: 17 },
  A2:  { tMin: 10, tMax: 35, rhMin: 8, rhMax: 80, dpMin: -12, dpMax: 21 },
  A3:  { tMin: 5,  tMax: 40, rhMin: 8, rhMax: 85, dpMin: -12, dpMax: 24 },
  A4:  { tMin: 5,  tMax: 45, rhMin: 8, rhMax: 90, dpMin: -12, dpMax: 24 },
};

describe('the ASHRAE table matches the published standard', () => {
  it('carries exactly the five envelopes the standard defines', () => {
    expect(Object.keys(ASHRAE_ENVELOPES).sort()).toEqual(Object.keys(PUBLISHED).sort());
  });

  for (const [id, want] of Object.entries(PUBLISHED)) {
    it(`${id} matches TC 9.9 5th ed. in °C and %RH`, () => {
      const got = ASHRAE_ENVELOPES[id];
      for (const k of ['tMin', 'tMax', 'rhMin', 'rhMax', 'dpMin', 'dpMax']) {
        expect(got[k], `${id}.${k}`).toBe(want[k]);
      }
    });
  }

  it('the recommended low-moisture limit binds on BOTH constraints', () => {
    // At the warm end the 8 % RH curve and the −9 °C dew-point line all but
    // coincide; at reduced pressure the RH curve is the higher of the two, so
    // dropping it (rhMin: 0) quietly widened the envelope. Assert the floor is
    // the maximum of the two everywhere across the recommended band.
    const rec = ASHRAE_ENVELOPES.Rec;
    for (const p of [101.325, 90, 79.5]) {
      for (let t = rec.tMin; t <= rec.tMax; t += 1) {
        const floor = lowerW(t, rec, p);
        expect(floor).toBeGreaterThanOrEqual(humidityRatioG(t, rec.rhMin, p) - 1e-9);
      }
    }
    // …and the RH curve genuinely is the binding one somewhere, or this
    // boundary would be decoration.
    const t27 = 27, pHigh = 79.5;
    expect(lowerW(t27, rec, pHigh)).toBeCloseTo(humidityRatioG(t27, rec.rhMin, pHigh), 9);
  });
});


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

  it('agrees with the drawn polygon at every pressure — badge and plot are one truth', () => {
    // The badge once used fixed sea-level g/kg caps while the chart drew the
    // pressure-aware boundary, so at altitude a point could sit inside the
    // plotted A1 while the badge said A2. Oracle: ray-cast the point against
    // the very polygon the chart renders.
    const inPolygon = (t, w, pts) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > w !== yj > w && t < ((xj - xi) * (w - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    // Deterministic PRNG so a failure is reproducible.
    let s = 0x5eed;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const order = ['A1', 'A2', 'A3', 'A4'];
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const tc = 2 + rand() * 46;
      const rh = 5 + rand() * 90;
      const p = 70 + rand() * 33;
      const W = humidityRatioG(tc, rh, p);
      // Skip points hugging any boundary: the polygon is traced in 0.5 °C
      // steps, so right at an edge the ray-cast and the analytic boundary can
      // legitimately disagree by a hair. The property is about interiors.
      const nearEdge = order.some((id) => {
        const env = ASHRAE_ENVELOPES[id];
        return (
          Math.abs(tc - env.tMin) < 0.6 || Math.abs(tc - env.tMax) < 0.6 ||
          Math.abs(W - upperW(tc, env, p)) < 0.15 ||
          Math.abs(W - lowerW(tc, env, p)) < 0.15
        );
      });
      if (nearEdge) continue;
      checked++;
      const zone = ashraeZone(tc, rh, p);
      const tightestByPolygon =
        order.find((id) => inPolygon(tc, W, envelopePolygon(ASHRAE_ENVELOPES[id], p))) || 'Out';
      expect(zone, `at ${tc.toFixed(1)}°C ${rh.toFixed(0)}% ${p.toFixed(1)}kPa`).toBe(
        tightestByPolygon,
      );
    }
    expect(checked).toBeGreaterThan(200); // the skip filter must not eat the test
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

  it('checkSLA reports the violated bound as data, not a pre-baked string', () => {
    // The core returns which bound broke and its canonical value; formatting
    // in the operator's display unit belongs to the UI. (A previous shape
    // baked '°F' into the string and it surfaced verbatim in °C mode.)
    expect(checkSLA(sla, 72, 45)).toEqual({
      ok: true, kind: null, bound: null, unit: null, detail: 'within SLA',
    });
    expect(checkSLA(sla, 50, 45)).toEqual({
      ok: false, kind: 'tMin', bound: 59, unit: 'F', detail: 'below temp min',
    });
    expect(checkSLA(sla, 95, 45)).toEqual({
      ok: false, kind: 'tMax', bound: 89.6, unit: 'F', detail: 'above temp max',
    });
    expect(checkSLA(sla, 72, 5)).toEqual({
      ok: false, kind: 'rhMin', bound: 8, unit: '%', detail: 'below RH min',
    });
    expect(checkSLA(sla, 72, 90)).toEqual({
      ok: false, kind: 'rhMax', bound: 80, unit: '%', detail: 'above RH max',
    });
    // 85 °F / 75 %: inside the temp/RH box but past the 62.6 °F dew-point cap.
    expect(checkSLA(sla, 85, 75)).toEqual({
      ok: false, kind: 'dpMax', bound: 62.6, unit: 'F', detail: 'above dew point cap',
    });
  });

  it('checks bounds in reading order: temperature before humidity before dew point', () => {
    // A point violating several bounds reports the first an engineer would look
    // at, so the badge is stable rather than depending on evaluation order.
    expect(checkSLA(sla, 50, 90).detail).toBe('below temp min');
    expect(checkSLA(sla, 72, 95).detail).toBe('above RH max');
  });

  it('a missing dew-point cap disables that check', () => {
    for (const noCap of [
      { ...sla, dpMaxF: null },
      { ...sla, dpMaxF: '' },
      { ...sla, dpMaxF: undefined },
    ]) {
      expect(checkSLA(noCap, 85, 75).ok).toBe(true);
    }
  });

  it('checkRamp grades measured rates against the SLA ramp limits', () => {
    // These limits were printed on the door placard as DO NOT CROSS long
    // before anything checked them — this pins the check that now exists.
    const prof = { maxDtHr: 18, maxDrhHr: 20 };
    expect(checkRamp(prof, 12, 15).ok).toBe(true);
    expect(checkRamp(prof, 18, 20).ok).toBe(true); // inclusive at the limit
    const t = checkRamp(prof, 25, 5);
    expect(t).toEqual({
      ok: false, kind: 'dtHr', bound: 18, actual: 25, unit: 'F/hr',
      detail: 'temperature ramp too fast',
    });
    const h = checkRamp(prof, 5, 31);
    expect(h.kind).toBe('drhHr');
    expect(h.actual).toBe(31);
    // Direction-free: a fast cool-down breaks the limit like a fast warm-up.
    expect(checkRamp(prof, -25, 0).ok).toBe(false);
    // Absent limits disable the check; absent measurements can't fail it.
    expect(checkRamp({ maxDtHr: null, maxDrhHr: null }, 99, 99).ok).toBe(true);
    expect(checkRamp(prof, null, null).ok).toBe(true);
  });

  it('boundary points are inclusive — exactly on a limit is still compliant', () => {
    // Cap removed so this isolates the temp/RH bounds. With the cap in play,
    // 89.6 °F / 45 % has a 65.5 °F dew point and correctly fails on the cap
    // instead — which the next test covers.
    const noCap = { ...sla, dpMaxF: null };
    expect(checkSLA(noCap, noCap.tMinF, 45).ok).toBe(true);
    expect(checkSLA(noCap, noCap.tMaxF, 45).ok).toBe(true);
    expect(checkSLA(noCap, 72, noCap.rhMin).ok).toBe(true);
    expect(checkSLA(noCap, 72, noCap.rhMax).ok).toBe(true);
  });

  it('the drawn contract and the graded contract are the same contract', () => {
    // The customer SLA is the one shape the tool both DRAWS and GRADES, by two
    // different routes: slaPolygon builds its dew-point edge as a constant-W
    // line (enhancement factor at the dry bulb, pressure-aware), while
    // checkSLA inverts the saturation equation to an actual dew-point
    // temperature and compares it in °F. Those are equivalent on paper —
    // dewPoint() is a Newton inversion of the same satPressure branches the
    // W-line is built from, and both sides carry the same enhancement factor,
    // so it cancels. This asserts it in practice, at pressures from Denver to
    // sea level, because "the chart says I am inside and the badge says I am
    // out" is the single most corrosive thing this tool could do.
    const inPolygon = (t, w, pts) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > w !== yj > w && t < ((xj - xi) * (w - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    let s = 0xc0ffee;
    const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    // Three real contract shapes: a wide house SLA, an A1 transcription, and a
    // tight one whose dew-point cap bites well inside its RH box.
    const profiles = [
      { tMinF: 50, tMaxF: 95, rhMin: 5, rhMax: 80, dpMaxF: null },
      { tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 },
      { tMinF: 64.4, tMaxF: 80.6, rhMin: 8, rhMax: 60, dpMaxF: 59 },
    ];
    let checked = 0;
    for (const prof of profiles) {
      const tMinC = (prof.tMinF - 32) / 1.8, tMaxC = (prof.tMaxF - 32) / 1.8;
      for (let n = 0; n < 300; n++) {
        const tc = 2 + rand() * 46;
        const rh = 3 + rand() * 94;
        const p = 70 + rand() * 33;
        const W = humidityRatioG(tc, rh, p);
        const pts = slaPolygon(prof, p);
        // Skip the hairline: the polygon is traced in 0.5 °C steps, so a
        // ray-cast right on an edge can disagree with the analytic bound by a
        // rounding error. The property is about interiors.
        const env = {
          tMin: tMinC, tMax: tMaxC, rhMin: prof.rhMin, rhMax: prof.rhMax,
          dpMin: null, dpMax: prof.dpMaxF == null ? null : (prof.dpMaxF - 32) / 1.8,
        };
        if (Math.abs(tc - tMinC) < 0.6 || Math.abs(tc - tMaxC) < 0.6) continue;
        if (Math.abs(W - upperW(tc, env, p)) < 0.15) continue;
        if (Math.abs(W - lowerW(tc, env, p)) < 0.15) continue;
        checked++;
        const drawn = inPolygon(tc, W, pts);
        const graded = checkSLA(prof, tc * 1.8 + 32, rh).ok;
        expect(graded, `${tc.toFixed(1)}°C ${rh.toFixed(0)}% ${p.toFixed(1)}kPa vs ${JSON.stringify(prof)}`)
          .toBe(drawn);
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('the dew-point cap binds independently of the temp/RH box', () => {
    // 89.6 °F is exactly the temp max and 45 % is inside the RH band, but the
    // resulting 65.5 °F dew point exceeds the 62.6 °F cap. Drying the same air
    // to 30 % (54.1 °F dew point) brings it back into contract.
    expect(checkSLA(sla, 89.6, 45)).toEqual({
      ok: false, kind: 'dpMax', bound: 62.6, unit: 'F', detail: 'above dew point cap',
    });
    expect(checkSLA(sla, 89.6, 30).ok).toBe(true);
  });
});
