/**
 * The files that leave the building.
 *
 * A CSV that only exists after a click cannot be tested, which is why these
 * are pure string builders. What they produce gets typed into a control
 * system, so the failures that matter are quiet ones: a comma in a hall name
 * silently shifting every later column, or a temperature written without
 * saying which scale it is in.
 */

import { describe, it, expect } from 'vitest';
import { setpointScheduleCsv, fleetCsv } from '../src/core/bmsexport.js';

const parse = (csv) => csv.split('\n').map((l) => l.match(/"((?:[^"]|"")*)"/g).map(
  (f) => f.slice(1, -1).replace(/""/g, '"')));

describe('setpoint schedule CSV', () => {
  const rungs = [
    { atHr: 1, tempF: 70.5, rh: 44 },
    { atHr: 2, tempF: 73, rh: 41.6 },
    { atHr: 3.25, tempF: 75, rh: 35 },
  ];

  it('writes one row per rung, numbered, with both temperature scales', () => {
    const rows = parse(setpointScheduleCsv({ rungs, hallName: 'Hall 2', slaName: 'Base' }));
    expect(rows).toHaveLength(4); // header + 3
    expect(rows[0]).toContain('temp_f');
    expect(rows[0]).toContain('temp_c');
    const [step, hrs, , hall, sla, tf, tc, rh] = rows[2];
    expect(step).toBe('2');
    expect(hrs).toBe('2');
    expect(hall).toBe('Hall 2');
    expect(sla).toBe('Base');
    expect(tf).toBe('73');
    // 73 °F is 22.8 °C. Writing only one scale is how a site enters the wrong
    // number into a system configured for the other.
    expect(tc).toBe('22.8');
    expect(rh).toBe('41.6');
  });

  it('quotes a hall name containing a comma without shifting columns', () => {
    // "Hall 2, Building A" is an ordinary name. Unquoted it would split into
    // two fields and push every later column one to the right — a silent,
    // total corruption of the file.
    const rows = parse(setpointScheduleCsv({ rungs, hallName: 'Hall 2, Building A' }));
    expect(rows[1]).toHaveLength(rows[0].length);
    expect(rows[1][3]).toBe('Hall 2, Building A');
  });

  it('survives a quote in a name', () => {
    const rows = parse(setpointScheduleCsv({ rungs, hallName: 'The "Old" Hall' }));
    expect(rows[1][3]).toBe('The "Old" Hall');
  });

  it('turns elapsed hours into real clock times when given a start', () => {
    const startAt = new Date('2026-07-01T08:00:00Z');
    const rows = parse(setpointScheduleCsv({ rungs, startAt }));
    expect(rows[1][2]).toBe('2026-07-01T09:00:00.000Z');
    expect(rows[3][2]).toBe('2026-07-01T11:15:00.000Z'); // 3.25 h
  });

  it('leaves the clock column empty rather than inventing a start', () => {
    const rows = parse(setpointScheduleCsv({ rungs }));
    expect(rows[1][2]).toBe('');
  });

  it('carries dew point when a solver is supplied, blank when not', () => {
    const withDp = parse(setpointScheduleCsv({ rungs, dewPointF: () => 52.4 }));
    expect(withDp[1][8]).toBe('52.4');
    expect(withDp[1][9]).toBe('11.3'); // 52.4 °F in °C
    const without = parse(setpointScheduleCsv({ rungs }));
    expect(without[1][8]).toBe('');
  });
});

describe('fleet CSV', () => {
  const halls = [
    { name: 'Hall 1', building: 'A', siteName: 'Goodyear, AZ', elevFt: 1066,
      baroKpa: null, rateCoolF: 2.5, rateWarmF: 3, rateDehumLb: 40, rateHumLb: 60,
      effPct: 85, hallVolFt3: 500000, airflowCfm: 90000, doasCfm: 2425 },
    { name: 'Hall 2', building: 'A', siteName: 'Goodyear, AZ', elevFt: 1066,
      baroKpa: 97.1, rateCoolF: null, rateWarmF: null, effPct: 85 },
  ];
  const opts = {
    halls, sla: { name: 'Base SLA' },
    pressureOf: (h) => (h.baroKpa != null ? h.baroKpa : 97.48),
    conditionOf: (h) => (h.name === 'Hall 1' ? { tempF: 73, rh: 45 } : null),
    verdictOf: (h) => (h.name === 'Hall 1' ? { ok: false, detail: 'RH above 40%' } : null),
  };

  it('writes one row per hall with its own pressure and its source', () => {
    const rows = parse(fleetCsv(opts));
    expect(rows).toHaveLength(3);
    expect(rows[1][4]).toBe('97.48');
    expect(rows[1][5]).toBe('from elevation');
    // A hall with a barometer must say so — the two are not interchangeable
    // and a reader cannot otherwise tell a measurement from a model.
    expect(rows[2][4]).toBe('97.1');
    expect(rows[2][5]).toBe('measured');
  });

  it('states an out-of-SLA hall and its reason', () => {
    const rows = parse(fleetCsv(opts));
    expect(rows[1][10]).toBe('OUT OF SLA');
    expect(rows[1][11]).toBe('RH above 40%');
  });

  it('says "not set up" rather than implying a pass', () => {
    // A hall nobody has worked on is not compliant, and it is not failing
    // either. Printing "in SLA" for it would be a lie a manager acts on.
    const rows = parse(fleetCsv(opts));
    expect(rows[2][10]).toBe('not set up');
    expect(rows[2][6]).toBe(''); // no condition to report
  });

  it('leaves missing rates blank instead of writing zero', () => {
    // 0 °F/hr means "this plant cannot warm"; blank means "nobody has entered
    // it yet". Collapsing the two would make an unconfigured hall look broken.
    const rows = parse(fleetCsv(opts));
    expect(rows[1][12]).toBe('2.5');
    expect(rows[2][12]).toBe('');
  });
});
