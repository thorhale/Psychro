/**
 * The measurement system, for everything that is not a temperature.
 *
 * The app read kPa beside CFM beside lb/hr beside ft³ — one quantity in SI,
 * three in IP, on one screen. These conversions are the fix, and the property
 * that matters is that STORAGE never moves: a saved file has to mean the same
 * thing whichever system the person who wrote it was using.
 */

import { describe, it, expect } from 'vitest';
import { MEASURE, measFrom, measTo, measLabel } from '../src/core/units.js';

const KINDS = /** @type {const} */ (['volume', 'flow', 'massRate', 'water', 'pressure']);

describe('measurement systems', () => {
  it('IP is the identity for everything stored in IP', () => {
    // Storage is ft³/CFM/lb-hr/gal, so the IP view must not touch them —
    // a round-trip through a "conversion" is where drift creeps in.
    for (const k of ['volume', 'flow', 'massRate', 'water']) {
      expect(measFrom(1234.5, k, 'IP')).toBe(1234.5);
      expect(measTo(1234.5, k, 'IP')).toBe(1234.5);
    }
  });

  it('round-trips every quantity in both systems', () => {
    for (const sys of ['IP', 'SI']) {
      for (const k of KINDS) {
        const back = measTo(measFrom(987.654, k, sys), k, sys);
        expect(back, `${sys}/${k}`).toBeCloseTo(987.654, 9);
      }
    }
  });

  it('converts to the values an engineer would check against', () => {
    // 500,000 ft³ is 14,158 m³.
    expect(measFrom(500000, 'volume', 'SI')).toBeCloseTo(14158.42, 1);
    // 2,425 CFM is 4,120 m³/h.
    expect(measFrom(2425, 'flow', 'SI')).toBeCloseTo(4120.11, 1);
    // 1,000 lb/hr of humidifier output is 453.6 kg/h.
    expect(measFrom(1000, 'massRate', 'SI')).toBeCloseTo(453.59, 2);
    // 100 gal is 378.5 L.
    expect(measFrom(100, 'water', 'SI')).toBeCloseTo(378.54, 2);
    // Standard atmosphere: 101.325 kPa is 29.92 inHg.
    expect(measFrom(101.325, 'pressure', 'IP')).toBeCloseTo(29.92, 2);
  });

  it('keeps pressure in kPa under SI, because the core does', () => {
    // The physics core works in kPa and every psychrometric reference quotes
    // it, so SI must be the identity here or the chart stamp and the hall
    // card would disagree about the same number.
    expect(measFrom(97.48, 'pressure', 'SI')).toBe(97.48);
    expect(measLabel('pressure', 'SI')).toBe('kPa');
  });

  it('labels each quantity in a unit the field actually uses', () => {
    expect(measLabel('volume', 'SI')).toBe('m³');   // not litres: a hall is 14,000 m³
    expect(measLabel('flow', 'SI')).toBe('m³/h');   // a DOAS schedule is written in m³/h
    expect(measLabel('massRate', 'SI')).toBe('kg/h');
    expect(measLabel('volume', 'IP')).toBe('ft³');
    expect(measLabel('flow', 'IP')).toBe('CFM');
  });

  it('passes null through rather than turning it into zero', () => {
    // A blank plant rate means "not entered", and 0 means "cannot do it".
    for (const k of KINDS) {
      expect(measFrom(null, k, 'SI')).toBeNull();
      expect(measTo(undefined, k, 'SI')).toBeNull();
      expect(measFrom(NaN, k, 'SI')).toBeNull();
    }
  });

  it('every system defines every quantity', () => {
    for (const sys of ['IP', 'SI']) {
      for (const k of KINDS) {
        expect(MEASURE[sys][k], `${sys}.${k}`).toBeTruthy();
        expect(typeof MEASURE[sys][k].label).toBe('string');
      }
    }
  });
});
