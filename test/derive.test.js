/**
 * The single derivation of a state point, and the memo in front of it.
 *
 * The memo is the risky part: it hands the SAME object back to every caller,
 * so a bug here would show up as two surfaces agreeing on a wrong number
 * rather than as an obvious crash. These tests pin that it keys on all three
 * inputs and that a hit is genuinely equivalent to a miss.
 */

import { describe, it, expect } from 'vitest';
import { deriveState, deriveStateF, deriveStateUncached, clearDeriveMemo } from '../src/core/derive.js';
import { P_STD } from '../src/core/psychro.js';

describe('deriveState memo', () => {
  it('a memo hit is identical to computing it fresh', () => {
    clearDeriveMemo();
    const cached = deriveState(24, 45, P_STD);
    const fresh = deriveStateUncached(24, 45, P_STD);
    for (const k of Object.keys(fresh)) {
      expect(cached[k], `field ${k}`).toStrictEqual(fresh[k]);
    }
  });

  it('keys on pressure, not just temperature and humidity', () => {
    clearDeriveMemo();
    const sea = deriveState(24, 45, 101.325);
    const denver = deriveState(24, 45, 83.4);
    // Same t and RH at a different pressure is a DIFFERENT state. If the memo
    // ignored pressure, an altitude hall would silently show sea-level numbers.
    expect(denver.W).not.toBeCloseTo(sea.W, 6);
    expect(denver.tdpC).not.toBeCloseTo(sea.tdpC, 4);
    expect(deriveStateUncached(24, 45, 83.4).W).toBeCloseTo(denver.W, 12);
  });

  it('keys on temperature and humidity independently', () => {
    clearDeriveMemo();
    const a = deriveState(24, 45, P_STD);
    const b = deriveState(25, 45, P_STD);
    const c = deriveState(24, 46, P_STD);
    expect(b.tc).toBe(25);
    expect(c.rh).toBe(46);
    expect(a.tc).toBe(24); // the first entry survived two more insertions
    expect(a.rh).toBe(45);
  });

  it('evicts rather than growing without bound', () => {
    clearDeriveMemo();
    // Far more distinct points than the memo holds; every answer must still be
    // right, which is the only thing eviction is allowed to affect.
    for (let t = 0; t < 40; t++) {
      const d = deriveState(t, 50, P_STD);
      expect(d.tc).toBe(t);
      expect(d.h).toBeCloseTo(deriveStateUncached(t, 50, P_STD).h, 12);
    }
  });

  it('deriveStateF converts before deriving, and shares the same memo', () => {
    clearDeriveMemo();
    const f = deriveStateF(75, 45, P_STD);
    expect(f.tempF).toBeCloseTo(75, 9);
    expect(f.rh).toBe(45);
    // Same physical point reached through the °C door: one object, not two.
    expect(deriveState(f.tc, 45, P_STD)).toBe(f);
  });
});
