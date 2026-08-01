/**
 * Trend-CSV parser — fixtures for the boring, predictable messes of real
 * BMS exports. The parser must refuse when unsure: a mis-parsed trend on the
 * chart looks exactly like real data.
 */

import { describe, it, expect } from 'vitest';
import { parseTrendCsv } from '../src/lib/trendcsv.js';

describe('parseTrendCsv', () => {
  it('parses a clean US-style export, °F from header', () => {
    const r = parseTrendCsv(
      'Timestamp,Temp (°F),RH (%)\n' +
        '2026-07-01T00:00:00Z,68.0,45.0\n2026-07-01T01:00:00Z,69.1,44.2\n2026-07-01T02:00:00Z,70.3,43.1\n',
    );
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(3);
    expect(r.tempUnit).toBe('F');
    expect(r.tempUnitSource).toBe('header');
    expect(r.rows[2].tempF).toBeCloseTo(70.3, 10);
  });

  it('parses an EU-style export: BOM, semicolons, comma decimals, °C', () => {
    const r = parseTrendCsv(
      '﻿date;temperature (°C);humidity\n' +
        '2026-07-01 00:00;20,0;45,5\n2026-07-01 01:00;20,6;44,8\n',
    );
    expect(r.ok).toBe(true);
    expect(r.tempUnit).toBe('C');
    expect(r.rows[0].tempF).toBeCloseTo(68, 6);
    expect(r.rows[0].rh).toBeCloseTo(45.5, 10);
  });

  it('finds columns regardless of order and extra columns', () => {
    const r = parseTrendCsv(
      'kW,RH,Setpoint,Time,Supply Temp\n' +
        '120,45,72,2026-07-01T00:00Z,68\n121,44,72,2026-07-01T01:00Z,69\n',
    );
    expect(r.ok).toBe(true);
    expect(r.rows[0].tempF).toBe(68);
    expect(r.rows[0].rh).toBe(45);
  });

  it('uses the value-range heuristic when the header names no unit, and says so', () => {
    const f = parseTrendCsv('time,temp,rh\n2026-07-01T00:00Z,68,45\n2026-07-01T01:00Z,72,44\n');
    expect(f.tempUnit).toBe('F');
    expect(f.tempUnitSource).toBe('range');
    const c = parseTrendCsv('time,temp,rh\n2026-07-01T00:00Z,20,45\n2026-07-01T01:00Z,22,44\n');
    expect(c.tempUnit).toBe('C');
    expect(c.tempUnitSource).toBe('range');
  });

  it('the UI override wins over every heuristic', () => {
    const r = parseTrendCsv(
      'time,temp,rh\n2026-07-01T00:00Z,20,45\n2026-07-01T01:00Z,22,44\n',
      { tempUnit: 'F' },
    );
    expect(r.tempUnit).toBe('F');
    expect(r.tempUnitSource).toBe('forced');
    expect(r.rows[0].tempF).toBe(20);
  });

  it('skips bad rows, sorts by time, and reports the skip count', () => {
    const r = parseTrendCsv(
      'time,temp,rh\n' +
        '2026-07-01T02:00Z,70,43\nnot-a-date,71,42\n2026-07-01T00:00Z,68,45\n2026-07-01T01:00Z,69,145\n',
    );
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(2); // bad date + RH 145
    expect(r.rows.map((x) => x.tempF)).toEqual([68, 70]); // sorted
  });

  it('handles quoted fields containing the delimiter', () => {
    const r = parseTrendCsv(
      'time,"temp, supply (F)",rh\n2026-07-01T00:00Z,68,45\n2026-07-01T01:00Z,69,44\n',
    );
    expect(r.ok).toBe(true);
  });

  it('refuses garbage with a reason instead of guessing', () => {
    expect(parseTrendCsv('').ok).toBe(false);
    expect(parseTrendCsv('just one line').ok).toBe(false);
    const noCols = parseTrendCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(noCols.ok).toBe(false);
    expect(noCols.error).toContain('Could not identify');
    const tooFew = parseTrendCsv('time,temp,rh\nx,y,z\nq,w,e\n');
    expect(tooFew.ok).toBe(false);
    expect(tooFew.error).toContain('usable data row');
  });
});
