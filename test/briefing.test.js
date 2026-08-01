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

  it('reports moisture mass when the plan has one', () => {
    const text = buildBriefing(
      makeParams({ plan: { hours: 3.2, binding: 'dehumidification', moistCap: { waterLb: 27.4 } } }),
    );
    expect(text).toContain('Moisture to remove: 27 lb of water.');
  });

  it('humidity ratios in the prose are the derived values, verbatim', () => {
    const params = makeParams();
    const text = buildBriefing(params);
    expect(text).toContain(`W ${params.a.Wg.toFixed(2)} → ${params.b.Wg.toFixed(2)} g/kg`);
  });
});
