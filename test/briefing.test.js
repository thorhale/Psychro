/**
 * Briefing generator — the prose must equal the numbers it was given.
 * Deterministic templates: same inputs, same words, and every figure in the
 * text traces to an input field. Uses real deriveStateF output so the test
 * exercises the same shapes main.js passes.
 */

import { describe, it, expect } from 'vitest';
import { buildBriefing } from '../src/app/briefing.js';
import { deriveStateF } from '../src/core/derive.js';
import { fmtHrs } from '../src/core/planner.js';
import { rhFromW } from '../src/core/psychro.js';
import { fToC } from '../src/core/units.js';

const fmtT = (f) => `${Math.round(f * 10) / 10} °F`;
const fmtDT = (f) => `${Math.round(f * 10) / 10} °F`;

function makeParams(over = {}) {
  const p = 97.482;
  return {
    a: deriveStateF(68, 45, p),
    b: deriveStateF(75, 35, p),
    plan: { hours: 7.93, binding: 'warming capacity', moistCap: null },
    hall: { name: 'Hall 1', siteName: 'Goodyear, AZ', elevFt: 1066 },
    sla: { name: 'Base SLA' },
    verdicts: { aOk: true, bOk: true },
    fmtT,
    fmtDT,
    fmtHrs,
    ...over,
  };
}

describe('briefing generator', () => {
  it('states the move, the deltas, the duration and the constraint', () => {
    const text = buildBriefing(makeParams());
    expect(text).toContain('Warm Hall 1 · Goodyear, AZ: 68 °F / 45% RH → 75 °F / 35% RH.');
    expect(text).toContain('ΔT +7 °F');
    expect(text).toContain('ΔRH −10%');
    expect(text).toContain('dew point'); // heating without water: unchanged
    expect(text).toContain('binding constraint: warming capacity');
    expect(text).toContain('Both points inside SLA (Base SLA).');
    expect(text).toContain('1,066 ft');
    expect(text).toContain('verify against site instrumentation');
  });

  it('is deterministic: identical inputs, identical text', () => {
    expect(buildBriefing(makeParams())).toBe(buildBriefing(makeParams()));
  });

  it('a true constant-moisture warm-up reports the dew point unchanged', () => {
    // The physics fact the app teaches: heating without adding water holds
    // the dew point. NOTE the target must actually sit on the constant-W
    // line — a hand-picked "roughly right" RH does not (this test originally
    // used 75 °F/35 %, whose dew point genuinely falls 0.4 °F, and the
    // briefing correctly said so — the test was wrong, not the prose).
    const p = 97.482;
    const a = deriveStateF(68, 45, p);
    const rhB = rhFromW(fToC(75), a.W, p);
    const text = buildBriefing(makeParams({ b: deriveStateF(75, rhB, p) }));
    expect(text).toContain('dew point unchanged');
  });

  it('names the violated bound when a point is outside SLA', () => {
    const text = buildBriefing(
      makeParams({ verdicts: { aOk: true, bOk: false, bDetail: 'T > 89.6 °F max' } }),
    );
    expect(text).toContain('Target is OUTSIDE SLA (Base SLA): T > 89.6 °F max.');
    expect(text).not.toContain('Both points inside');
  });

  it('reports moisture mass with the direction from the plan label', () => {
    // waterLb is a MASS — always positive. Direction lives in moistCap.label,
    // and this pins the bug where a sign test on the mass briefed every
    // humidification move as "moisture to remove".
    const dehum = buildBriefing(
      makeParams({ plan: { hours: 3.2, binding: 'dehumidify capacity', moistCap: { label: 'Dehum', waterLb: 27.4 } } }),
    );
    expect(dehum).toContain('Moisture to remove: 27 lb of water.');
    const hum = buildBriefing(
      makeParams({ plan: { hours: 3.2, binding: 'humidify capacity', moistCap: { label: 'Humidify', waterLb: 27.4 } } }),
    );
    expect(hum).toContain('Moisture to add: 27 lb of water.');
  });

  it('a zero-hour plan with missing plant rates admits it cannot time the move', () => {
    // hours 0 + a missing-rate flag used to read "No plant work required" —
    // the opposite of the truth. Missing data is not a finished job.
    const text = buildBriefing(
      makeParams({ plan: { hours: 0, binding: '', moistCap: null, needsTempRate: true } }),
    );
    expect(text).toContain('Duration unknown — plant rates are not set for this hall.');
    expect(text).not.toContain('No plant work required');
  });

  it('humidity ratios in the prose are the derived values, verbatim', () => {
    const params = makeParams();
    const text = buildBriefing(params);
    expect(text).toContain(`W ${params.a.Wg.toFixed(2)} → ${params.b.Wg.toFixed(2)} g/kg`);
  });

  it('narrates the hourly set-point ladder the caller computed', () => {
    // The briefing only narrates — the caller derives the rungs with the same
    // interpolation the chart's pacing ticks use, so the ticket and the chart
    // can never disagree about hour 3.
    const text = buildBriefing(
      makeParams({
        hourly: [
          { tempF: 70.5, rh: 44 },
          { tempF: 73, rh: 41.6 },
          { tempF: 75, rh: 35 },
        ],
      }),
    );
    expect(text).toContain('Hourly set-points:');
    expect(text).toContain('Hour 1: 70.5 °F / 44% RH');
    expect(text).toContain('Hour 2: 73 °F / 42% RH');
    expect(text).toContain('Hour 3 (arrival): 75 °F / 35% RH');
    // No ladder requested → no header.
    expect(buildBriefing(makeParams())).not.toContain('Hourly set-points');
  });

  it('stamps the generation time the caller passes — and stays deterministic', () => {
    const at = new Date('2026-08-02T14:33:00Z');
    const text = buildBriefing(makeParams({ generatedAt: at }));
    expect(text).toContain('Generated 2026-08-02 14:33 UTC');
    expect(text).toContain('verify against site instrumentation');
    // Same inputs incl. the timestamp → same text, byte for byte.
    expect(buildBriefing(makeParams({ generatedAt: at }))).toBe(text);
  });
});
