/**
 * Display formatting granularity.
 *
 * These exist because the app used to round every readout to whole units
 * while storing and calculating with the full typed value. You could set
 * 72.5 °F, watch the box rewrite itself to 73, and be graded against a
 * "64 °F" bound that was really 64.4. A tenth is the granularity operators
 * work at, so a tenth is what the display has to survive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { dispTs, dispT1, disp1, fmtSlaReason } from '../src/ui/format.js';
import { state } from '../src/app/state.js';

describe('tenth-place display', () => {
  beforeEach(() => { state.tempUnit = 'F'; });

  it('keeps a tenth and trims a bare trailing zero', () => {
    // Whole-degree work must still LOOK like whole-degree work: no "73.0".
    expect(dispTs(73)).toBe('73');
    expect(dispTs(72.5)).toBe('72.5');
    expect(dispTs(-10)).toBe('-10');
    expect(disp1(45)).toBe('45');
    expect(disp1(45.5)).toBe('45.5');
  });

  it('rounds to the nearest tenth rather than truncating', () => {
    expect(dispTs(72.44)).toBe('72.4');
    expect(dispTs(72.46)).toBe('72.5');
    expect(disp1(0.04)).toBe('0');
  });

  it('converts before rounding, so °C keeps its tenth', () => {
    state.tempUnit = 'C';
    expect(dispTs(68)).toBe('20');      // exactly 20 °C
    expect(dispTs(87)).toBe('30.6');    // 30.55… °C — not 31
    state.tempUnit = 'F';
  });

  it('dispT1 and dispTs agree — the app converged on one granularity', () => {
    for (const f of [32, 64.4, 68, 72.5, 87, 100.06]) {
      expect(dispT1(f)).toBe(dispTs(f));
    }
  });

  it('states an SLA bound at the precision the contract really has', () => {
    // 18 °C is 64.4 °F. Reporting "T below 64 °F" understates the bound by
    // four tenths and makes the verdict chip disagree with the SLA card.
    expect(fmtSlaReason({ ok: false, kind: 'tMin', bound: 64.4 })).toBe('T below 64.4 °F');
    expect(fmtSlaReason({ ok: false, kind: 'tMax', bound: 80 })).toBe('T above 80 °F');
  });
});
