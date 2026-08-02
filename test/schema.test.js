/**
 * Save-file schema: validation-before-merge, legacy migration, and rejection of
 * malformed or hostile payloads.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeHall,
  normalizeSla,
  migrateLegacyProfiles,
  validateSaveFile,
  isValidScenario,
  isValidSite,
  HALL_KEYS,
  isValidLogEntry,
  normalizeSensorLog,
  SENSOR_LOG_MAX,
  isValidSensorMeta,
  normalizeSensorRegistry,
} from '../src/state/schema.js';

describe('normalizeHall', () => {
  it('fills every field with a typed default', () => {
    const h = normalizeHall({});
    expect(h.name).toBe('Hall 1');
    expect(h.elevFt).toBe(0);
    expect(h.effPct).toBe(85);
    expect(h.derateCoolPct).toBe(100);
    expect(h.canDehumidify).toBe(false);
    expect(h.results).toEqual([]);
    expect(h.calc).toEqual({});
  });

  it('coerces hostile values instead of storing them', () => {
    const h = normalizeHall({
      elevFt: 'DROP TABLE', // string
      effPct: 900, //             out of range
      derateCoolPct: -5, //       out of range
      canHumidify: 'yes', //      truthy string is NOT true
      rateCoolF: Infinity, //     non-finite
      results: 'nope',
    });
    expect(h.elevFt).toBe(0);
    expect(h.effPct).toBe(150);
    expect(h.derateCoolPct).toBe(0);
    expect(h.canHumidify).toBe(false);
    expect(h.rateCoolF).toBeNull();
    expect(h.results).toEqual([]);
  });

  it('a calibrated efficiency above 100% survives normalization', () => {
    // The plant-vs-actual calibration flow legitimately produces >100 %
    // (staged equipment beating nameplate). The schema once clamped to 100,
    // so a calibrated 120 silently degraded on every reload — this pins the
    // fix: the schema ceiling (150) matches the UI's.
    expect(normalizeHall({ effPct: 120 }).effPct).toBe(120);
    expect(normalizeHall({ effPct: 150 }).effPct).toBe(150);
    expect(normalizeHall({ effPct: 151 }).effPct).toBe(150);
  });

  it('derives the name from the site when present', () => {
    expect(normalizeHall({ siteName: 'Goodyear, AZ' }).name).toBe('Goodyear, AZ · Hall');
  });
});

describe('normalizeSla', () => {
  it('repairs inverted ranges rather than rejecting them', () => {
    const s = normalizeSla({ name: 'X', tMinF: 95, tMaxF: 50, rhMin: 80, rhMax: 5 });
    expect(s.tMinF).toBe(50);
    expect(s.tMaxF).toBe(95);
    expect(s.rhMin).toBe(5);
    expect(s.rhMax).toBe(80);
  });

  it('treats an empty dew-point cap as no cap', () => {
    expect(normalizeSla({ name: 'X', dpMaxF: '' }).dpMaxF).toBeNull();
    expect(normalizeSla({ name: 'X', dpMaxF: 62.6 }).dpMaxF).toBe(62.6);
  });
});

describe('migrateLegacyProfiles (v0: hall data on SLA profiles)', () => {
  it('lifts hall fields onto the hall and strips them from every profile', () => {
    // A legacy hall arrives UN-normalized (fields undefined) — that is what makes
    // its slots "empty" and liftable. Normalizing first would fill elevFt with 0,
    // which the migration rightly treats as a real value, not an empty slot.
    const hall = {};
    const profiles = [
      { name: 'Base SLA', locked: true },
      {
        name: 'Customer 1',
        siteName: 'Goodyear, AZ',
        elevFt: 1066,
        hallVolFt3: 150000,
        rateCoolF: 5,
        canDehumidify: true,
      },
    ];
    migrateLegacyProfiles(profiles, hall);
    expect(hall.siteName).toBe('Goodyear, AZ');
    expect(hall.elevFt).toBe(1066);
    expect(hall.hallVolFt3).toBe(150000);
    expect(hall.rateCoolF).toBe(5);
    expect(hall.canDehumidify).toBe(true);
    for (const p of profiles) for (const k of HALL_KEYS) expect(p[k]).toBeUndefined();
  });

  it('does not overwrite hall fields that already have values', () => {
    const hall = normalizeHall({ siteName: 'Ashburn, VA', elevFt: 300 });
    migrateLegacyProfiles([{ name: 'X', siteName: 'Goodyear, AZ', elevFt: 1066 }], hall);
    expect(hall.siteName).toBe('Ashburn, VA');
    expect(hall.elevFt).toBe(300);
  });
});

describe('validateSaveFile', () => {
  const good = {
    hallProfiles: [{ name: 'PHX · Hall 1', elevFt: 1066 }],
    slaProfiles: [{ name: 'Customer 1', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80 }],
    customSites: [{ city: 'Plano', state: 'Texas', code: 'DFW III', elevFt: 660 }],
    scenarios: [{ name: 'Summer', aTemp: 75, aRH: 45, bTemp: 80, bRH: 40 }],
  };

  it('accepts a well-formed payload and returns normalized copies', () => {
    const v = validateSaveFile(good);
    expect(v.ok).toBe(true);
    expect(v.halls).toHaveLength(1);
    expect(v.halls[0].effPct).toBe(85); // normalized default applied
    expect(v.slas).toHaveLength(1);
    expect(v.sites).toHaveLength(1);
    expect(v.scenarios).toHaveLength(1);
    // Copies, not references — merging cannot mutate the caller's payload.
    expect(v.halls[0]).not.toBe(good.hallProfiles[0]);
  });

  it('rejects non-objects and payloads with no planner data', () => {
    for (const bad of [null, 42, 'x', [], {}, { foo: 1 }]) {
      expect(validateSaveFile(bad).ok).toBe(false);
    }
  });

  it('round-trips: validate(validate(x).arrays) is stable', () => {
    const v1 = validateSaveFile(good);
    const v2 = validateSaveFile({
      hallProfiles: v1.halls,
      slaProfiles: v1.slas,
      customSites: v1.sites,
      scenarios: v1.scenarios,
    });
    expect(v2.ok).toBe(true);
    expect(v2.halls).toEqual(v1.halls);
    expect(v2.slas).toEqual(v1.slas);
  });

  it('filters malformed entries instead of half-applying them', () => {
    const v = validateSaveFile({
      hallProfiles: [null, 'junk', { name: 'OK Hall' }],
      slaProfiles: [{ noName: true }, { name: 'OK SLA' }],
      customSites: [{ city: '', state: 'Texas' }, { city: 'Plano', state: 'Texas' }],
      scenarios: [{ aTemp: 'NaN?' }, { aTemp: 75, aRH: 45, bTemp: 80, bRH: 40 }],
    });
    expect(v.ok).toBe(true);
    expect(v.halls.map((h) => h.name)).toEqual(['OK Hall']);
    expect(v.slas.map((s) => s.name)).toEqual(['OK SLA']);
    expect(v.sites).toHaveLength(1);
    expect(v.scenarios).toHaveLength(1);
  });
});

describe('sensor log schema', () => {
  const good = {
    sensor: 'CRAH-1 supply', method: 'salt', quantity: 'rh',
    ref: 75.3, u: 0.4, reading: 74.1, err: -1.2, date: '2026-08-01T00:00:00.000Z',
  };

  it('accepts a complete entry and rejects every mutilation of it', () => {
    expect(isValidLogEntry(good)).toBe(true);
    for (const kill of [
      { sensor: '' }, { sensor: 3 }, { method: null }, { quantity: 'pressure' },
      { ref: 'high' }, { u: -1 }, { reading: NaN }, { err: Infinity }, { date: 'yesterday' },
    ]) {
      expect(isValidLogEntry({ ...good, ...kill }), JSON.stringify(kill)).toBe(false);
    }
    expect(isValidLogEntry(null)).toBe(false);
  });

  it('normalizes: drops invalid, sorts by date, caps at the maximum', () => {
    const day = (n) => ({ ...good, date: new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString() });
    const raw = [day(3), { junk: true }, day(1), day(2)];
    const out = normalizeSensorLog(raw);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.date)).toEqual([day(1).date, day(2).date, day(3).date]);

    const many = Array.from({ length: SENSOR_LOG_MAX + 50 }, (_, i) => day(i));
    const capped = normalizeSensorLog(many);
    expect(capped).toHaveLength(SENSOR_LOG_MAX);
    // Newest survive the cap — history serves the trend, and trends live at the end.
    expect(capped[capped.length - 1].date).toBe(day(SENSOR_LOG_MAX + 49).date);
  });
});

describe('sensor log audit fields', () => {
  const base = {
    sensor: 'CRAH-1 supply', method: 'salt', quantity: 'rh',
    ref: 75.3, u: 0.4, reading: 74.1, err: -1.2, date: '2026-08-01T00:00:00.000Z',
  };

  it('optional hall/site/tech ride along; junk versions are dropped, not fatal', () => {
    // Backward compatibility is the contract: every save file written before
    // these fields existed must stay valid forever.
    expect(isValidLogEntry(base)).toBe(true);
    const rich = { ...base, hallName: 'PHX · Hall 1', siteName: 'Goodyear, AZ', tech: 'TH' };
    const out = normalizeSensorLog([rich, base]);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.tech)?.hallName).toBe('PHX · Hall 1');
    // A non-string tech doesn't kill the entry — the field is dropped instead.
    const junk = normalizeSensorLog([{ ...base, tech: 42, hallName: '' }]);
    expect(junk).toHaveLength(1);
    expect('tech' in junk[0]).toBe(false);
    expect('hallName' in junk[0]).toBe(false);
  });
});

describe('sensor registry schema', () => {
  const good = { name: 'CRAH-1 supply', specRh: 3, specTF: 0.9, calIntervalDays: 90, lastCalDate: '2026-06-01T00:00:00.000Z' };

  it('accepts full and minimal entries, rejects nonsense', () => {
    expect(isValidSensorMeta(good)).toBe(true);
    expect(isValidSensorMeta({ name: 'bare sensor' })).toBe(true); // placeholder is fine
    for (const kill of [
      { name: '' }, { name: 3 }, { specRh: -1 }, { specRh: 'tight' },
      { specTF: 0 }, { calIntervalDays: -5 }, { lastCalDate: 'someday' },
    ]) {
      expect(isValidSensorMeta({ ...good, ...kill }), JSON.stringify(kill)).toBe(false);
    }
    expect(isValidSensorMeta(null)).toBe(false);
  });

  it('normalizes: de-dupes by name with last write winning, fills nulls', () => {
    const out = normalizeSensorRegistry([
      { name: 'A', specRh: 2 },
      { junk: true },
      { name: 'A', specRh: 3 }, // fresher datasheet wins
      { name: 'B' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((m) => m.name === 'A').specRh).toBe(3);
    expect(out.find((m) => m.name === 'B')).toEqual({
      name: 'B', specRh: null, specTF: null, calIntervalDays: null, lastCalDate: null,
    });
  });

  it('rides validateSaveFile alongside the log', () => {
    const v = validateSaveFile({
      slaProfiles: [{ name: 'X', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80 }],
      sensorRegistry: [{ name: 'CRAH-1 supply', specRh: 3 }, 'junk'],
    });
    expect(v.ok).toBe(true);
    expect(v.sensorRegistry).toHaveLength(1);
    expect(v.sensorRegistry[0].specRh).toBe(3);
    // Absent input → empty array, never undefined (merge code iterates it).
    expect(validateSaveFile({ slaProfiles: [{ name: 'X' }] }).sensorRegistry).toEqual([]);
  });
});

describe('per-hall working conditions', () => {
  it('keeps a complete condition set and rejects a partial one', () => {
    const good = { aTemp: 71, aRH: 44, bTemp: 75, bRH: 38 };
    expect(normalizeHall({ cond: good }).cond).toEqual(good);
    // A hall that has never been worked on has no point of its own — null,
    // which is what tells the UI to seed it from the screen on first visit.
    expect(normalizeHall({}).cond).toBeNull();
    for (const bad of [
      { aTemp: 71, aRH: 44, bTemp: 75 }, //        missing a field
      { aTemp: 'warm', aRH: 44, bTemp: 75, bRH: 38 },
      { aTemp: NaN, aRH: 44, bTemp: 75, bRH: 38 },
      'nope',
      [],
    ]) {
      expect(normalizeHall({ cond: bad }).cond, JSON.stringify(bad)).toBeNull();
    }
  });

  it('clamps humidity but leaves temperature to the app\'s own limits', () => {
    const c = normalizeHall({ cond: { aTemp: 71, aRH: 300, bTemp: 75, bRH: -20 } }).cond;
    expect(c.aRH).toBe(100);
    expect(c.bRH).toBe(0);
    expect(c.aTemp).toBe(71);
  });

  it('rides a save file so a colleague gets your halls AND their set-points', () => {
    const v = validateSaveFile({
      hallProfiles: [{ name: 'H1', cond: { aTemp: 68, aRH: 45, bTemp: 80, bRH: 30 } }],
    });
    expect(v.ok).toBe(true);
    expect(v.halls[0].cond.bTemp).toBe(80);
  });
});

describe('measured barometer override', () => {
  it('normalizeHall keeps a plausible baroKpa and clears everything else', () => {
    expect(normalizeHall({ baroKpa: 97.6 }).baroKpa).toBe(97.6);
    expect(normalizeHall({}).baroKpa).toBeNull();
    // Outside the physics-vouched 55–110 kPa window: cleared, not clamped —
    // a wild barometer entry must not silently become a different wrong value.
    expect(normalizeHall({ baroKpa: 30 }).baroKpa).toBeNull();
    expect(normalizeHall({ baroKpa: 200 }).baroKpa).toBeNull();
    expect(normalizeHall({ baroKpa: 'high' }).baroKpa).toBeNull();
  });
});

describe('guards', () => {
  it('isValidScenario requires all four finite state numbers', () => {
    expect(isValidScenario({ aTemp: 75, aRH: 45, bTemp: 80, bRH: 40 })).toBe(true);
    expect(isValidScenario({ aTemp: 75, aRH: 45, bTemp: 80 })).toBe(false);
    expect(isValidScenario({ aTemp: NaN, aRH: 45, bTemp: 80, bRH: 40 })).toBe(false);
    expect(isValidScenario(null)).toBe(false);
  });

  it('isValidSite requires non-empty city and state', () => {
    expect(isValidSite({ city: 'Plano', state: 'Texas' })).toBe(true);
    expect(isValidSite({ city: '', state: 'Texas' })).toBe(false);
    expect(isValidSite({ city: 'Plano' })).toBe(false);
  });
});
