/**
 * Scenario deep-links: encode/parse round-trip and hostile-input rejection.
 * A link that garbles even one number would hand a colleague wrong targets,
 * so the round-trip is property-tested over seeded random states.
 */

import { describe, it, expect } from 'vitest';
import { encodeStateHash, parseStateHash } from '../src/state/urlstate.js';

const SEED = 0xbeef;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('URL state', () => {
  it('round-trips 200 seeded random states exactly (to link precision)', () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < 200; i++) {
      const s = {
        aTemp: 40 + rand() * 70,
        aRH: 1 + rand() * 99,
        bTemp: 40 + rand() * 70,
        bRH: 1 + rand() * 99,
        tempUnit: ['F', 'C', 'K'][Math.floor(rand() * 3)],
        hallName: `Hall ${Math.floor(rand() * 9)} · & sp≠cial`,
        slaName: 'Base SLA',
        elevFt: Math.floor(rand() * 10000),
      };
      const parsed = parseStateHash(encodeStateHash(s));
      expect(parsed, `seed ${SEED} #${i}`).not.toBeNull();
      // Links carry 2 decimals; that is the contract.
      expect(parsed.aTemp).toBeCloseTo(s.aTemp, 2);
      expect(parsed.aRH).toBeCloseTo(s.aRH, 2);
      expect(parsed.bTemp).toBeCloseTo(s.bTemp, 2);
      expect(parsed.bRH).toBeCloseTo(s.bRH, 2);
      expect(parsed.tempUnit).toBe(s.tempUnit);
      expect(parsed.hallName).toBe(s.hallName);
      expect(parsed.slaName).toBe(s.slaName);
      expect(parsed.elevFt).toBe(s.elevFt);
    }
  });

  it('minimal link works: just the four numbers', () => {
    const p = parseStateHash('#v=1&a=68,45&b=75,35');
    expect(p).not.toBeNull();
    expect(p.aTemp).toBe(68);
    expect(p.bRH).toBe(35);
    expect(p.hallName).toBeNull();
    expect(p.elevFt).toBeNull();
  });

  it('rejects garbage instead of guessing', () => {
    for (const bad of [
      '', '#', '#foo=bar', '#v=1&a=68', '#v=1&a=68,45', // missing b
      '#v=2&a=68,45&b=75,35', //                           wrong version
      '#v=1&a=NaN,45&b=75,35', '#v=1&a=68,45&b=1e309,35', // hostile numbers
      '#v=1&a=999,45&b=75,35', //                          absurd temperature
      null, undefined, 42,
    ]) {
      expect(parseStateHash(bad), String(bad)).toBeNull();
    }
  });

  it('clamps RH and elevation into physical range', () => {
    const p = parseStateHash('#v=1&a=68,150&b=75,-20&elev=99999');
    expect(p.aRH).toBe(100);
    expect(p.bRH).toBe(0);
    expect(p.elevFt).toBe(20000);
  });
});
