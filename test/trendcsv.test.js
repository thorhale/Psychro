/**
 * Trend-CSV parser — fixtures for the boring, predictable messes of real
 * BMS exports. The parser must refuse when unsure: a mis-parsed trend on the
 * chart looks exactly like real data.
 */

import { describe, it, expect } from 'vitest';
import { parseTrendCsv, maxWindowedRate } from '../src/lib/trendcsv.js';

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

  it('rejects BMS null sentinels BEFORE the unit heuristic can see them', () => {
    // A hall at ~72 °F with one −9999 comms dropout: the sentinel once pulled
    // the column mean to −1600, flipping the range heuristic to °C and
    // cooking every row. It must be skipped first, leaving a °F verdict.
    const rows = ['2026-07-01T00:00Z,72,45', '2026-07-01T01:00Z,-9999,45',
      '2026-07-01T02:00Z,73,44', '2026-07-01T03:00Z,74,44'];
    const r = parseTrendCsv('time,temp,rh\n' + rows.join('\n') + '\n');
    expect(r.ok).toBe(true);
    expect(r.tempUnit).toBe('F');
    expect(r.skipped).toBe(1);
    expect(r.rows).toHaveLength(3);
    // 32767 and other out-of-world values die the same way.
    const r2 = parseTrendCsv('time,temp,rh\n2026-07-01T00:00Z,32767,45\n2026-07-01T01:00Z,72,45\n2026-07-01T02:00Z,73,44\n');
    expect(r2.skipped).toBe(1);
  });

  it('rejects values that only become nonsense after unit resolution', () => {
    // 120 "°C" (header-declared) → 248 °F: physically impossible room data.
    const r = parseTrendCsv('time,temp (C),rh\n2026-07-01T00:00Z,22,45\n2026-07-01T01:00Z,120,45\n2026-07-01T02:00Z,23,44\n');
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(1);
    expect(r.rows).toHaveLength(2);
  });

  it('detects day-first dates from the whole column, not the first row', () => {
    // 03/07 alone is ambiguous; 25/07 later in the column proves day-first —
    // so 03/07 must be July 3rd, not March 7th.
    const r = parseTrendCsv(
      'time;temp;rh\n03/07/2026 10:00;21,5;45\n03/07/2026 11:00;22,0;45\n25/07/2026 10:00;22,5;44\n',
    );
    expect(r.ok).toBe(true);
    expect(r.dateFormat).toBe('dmy');
    expect(r.dateFormatSource).toBe('column');
    expect(r.rows[0].time.getMonth()).toBe(6); // July, zero-indexed
    // The 22-day span proves it did not read 25/07 as month 25 → invalid.
    const spanDays = (r.rows[2].time - r.rows[0].time) / 86400000;
    expect(spanDays).toBeCloseTo(22, 1);
  });

  it('says when the date order was assumed rather than proven', () => {
    const r = parseTrendCsv(
      'time,temp,rh\n03/07/2026 10:00,72,45\n03/07/2026 11:00,73,44\n',
    );
    expect(r.ok).toBe(true);
    expect(r.dateFormat).toBe('mdy');
    expect(r.dateFormatSource).toBe('assumed');
    // ISO columns are never "assumed" — they are unambiguous.
    const iso = parseTrendCsv('time,temp,rh\n2026-07-01T00:00Z,72,45\n2026-07-01T01:00Z,73,44\n');
    expect(iso.dateFormatSource).toBe('iso');
  });

  it('reports the median sample interval for gap detection', () => {
    const r = parseTrendCsv(
      'time,temp,rh\n2026-07-01T00:00Z,72,45\n2026-07-01T00:05Z,72.5,45\n2026-07-01T00:10Z,73,44\n2026-07-01T06:00Z,74,44\n',
    );
    expect(r.ok).toBe(true);
    expect(r.medianStepMs).toBe(5 * 60000); // the dropout does not drag the median
  });
});

describe('maxWindowedRate', () => {
  const mk = (pts) =>
    pts.map(([min, tempF, rh]) => ({ time: new Date(Date.UTC(2026, 6, 1, 0, min)), tempF, rh }));

  it('finds the fastest sustained ramp, not the diluted endpoint average', () => {
    // One idle hour, then 3 °F in 15 minutes (12 °F/hr), then idle again:
    // the endpoint average over 2.5 h is ~1.2 °F/hr — the window sees 12.
    const rows = mk([
      [0, 70, 45], [15, 70, 45], [30, 70, 45], [45, 70, 45], [60, 70, 45],
      [75, 73, 45], [90, 73, 45], [105, 73, 45], [120, 73, 45], [135, 73, 45], [150, 73, 45],
    ]);
    const r = maxWindowedRate(rows, 15 * 60000, 15 * 60000);
    expect(r).not.toBeNull();
    expect(r.tempFPerHr).toBeCloseTo(12, 5);
  });

  it('never rates across a data gap', () => {
    // 5-min sampling with a 3 °F jump across a 4-hour hole: a rate computed
    // over missing data is a guess, and the gap must sever the window.
    const rows = mk([
      [0, 70, 45], [5, 70, 45], [10, 70, 45], [250, 73, 45], [255, 73, 45], [260, 73, 45],
    ]);
    const r = maxWindowedRate(rows, 15 * 60000, 5 * 60000);
    expect(r).not.toBeNull();
    expect(r.tempFPerHr).toBeLessThan(1); // only the flat segments rated
  });

  it('demands the window span at least half its width — no one-step spikes', () => {
    // A single ±0.3 °F wiggle between two 1-min samples "is" 18 °F/hr if you
    // extrapolate it; the half-window rule refuses to.
    const rows = mk([
      [0, 70, 45], [1, 70.3, 45], [2, 70, 45], [3, 70.3, 45], [4, 70, 45],
      [5, 70.3, 45], [6, 70, 45], [7, 70.3, 45], [8, 70, 45], [9, 70.3, 45],
      [10, 70, 45], [11, 70.3, 45], [12, 70, 45], [13, 70.3, 45], [14, 70, 45], [15, 70, 45],
    ]);
    const r = maxWindowedRate(rows, 15 * 60000, 60000);
    expect(r).not.toBeNull();
    expect(r.tempFPerHr).toBeLessThan(3); // noise, averaged over ≥7.5 min
  });

  it('returns null when nothing can be rated', () => {
    expect(maxWindowedRate([], 15 * 60000, 60000)).toBeNull();
    expect(maxWindowedRate(mk([[0, 70, 45]]), 15 * 60000, 60000)).toBeNull();
  });

  it('widens the window to the sample interval on coarse data, and says so', () => {
    // Hourly samples cannot answer a 15-minute question; the per-sample rate
    // is the best available, and the returned windowMs reports the switch.
    const rows = mk([[0, 70, 45], [60, 71, 45], [120, 72, 44]]);
    const r = maxWindowedRate(rows, 15 * 60000, 60 * 60000);
    expect(r).not.toBeNull();
    expect(r.windowMs).toBe(60 * 60000);
    expect(r.tempFPerHr).toBeCloseTo(1, 5);
  });
});
