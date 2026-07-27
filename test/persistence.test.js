/**
 * Persisted-state migration: the path that decides whether an operator's saved
 * halls, SLAs and preferences survive an app update.
 *
 * Fixtures are the real historical payload shapes, not idealised ones — v1 saves
 * carry hall data ON the SLA profiles, v3 saves have a single `hall` object, v4
 * is the current multi-hall layout. Every one of these exists in the field on
 * somebody's phone.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStoredState,
  buildStoredState,
  baseSla,
  LS_KEY_V1,
  LS_KEY_V3,
  LS_KEY_V4,
} from '../src/state/persistence.js';
import { normalizeHall, HALL_KEYS } from '../src/state/schema.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Current layout: two halls, a custom SLA, °C display. */
const V4 = JSON.stringify({
  v: 4,
  hallProfiles: [
    { name: 'PHX · Hall 1', siteName: 'Goodyear, AZ', elevFt: 1066, hallVolFt3: 180000, rateCoolF: 6 },
    { name: 'DEN · Hall 2', siteName: 'Westminster, CO', elevFt: 5380, canDehumidify: true },
  ],
  activeHall: 1,
  hallView: { loc: 'Westminster, CO', bld: '' },
  slaProfiles: [
    { name: 'Base SLA', tMinF: 50, tMaxF: 95, rhMin: 5, rhMax: 80, dpMaxF: null, locked: true },
    { name: 'Customer 1', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 },
  ],
  activeSla: 1,
  tempUnit: 'C',
});

/** Single-hall layout that predates hall profiles. */
const V3 = JSON.stringify({
  v: 3,
  hall: { siteName: 'Ashburn, VA', elevFt: 300, hallVolFt3: 120000, rateCoolF: 4 },
  slaProfiles: [{ name: 'Customer A', tMinF: 60, tMaxF: 85, rhMin: 10, rhMax: 70 }],
  activeSla: 0,
  tempUnit: 'F',
});

/** Oldest layout: hall data still living on the SLA profiles. */
const V1 = JSON.stringify({
  slaProfiles: [
    {
      name: 'Legacy Customer',
      tMinF: 64,
      tMaxF: 81,
      rhMin: 20,
      rhMax: 60,
      // hall fields that must be lifted off and stripped
      siteName: 'Plano, TX',
      elevFt: 660,
      hallVolFt3: 90000,
      rateCoolF: 5,
      canDehumidify: true,
    },
  ],
  activeSla: 0,
  tempUnit: 'K',
});

const none = { v4: null, v3: null, v1: null };

describe('storage keys', () => {
  it('are the exact strings already on operators’ devices', () => {
    // Changing any of these silently orphans saved data. They are constants in
    // the truest sense — this test exists to make that renaming impossible.
    expect(LS_KEY_V4).toBe('sdc_hep_v4');
    expect(LS_KEY_V3).toBe('sdc_hep_v3');
    expect(LS_KEY_V1).toBe('sdc_psychro_slaProfiles_v1');
  });
});

describe('v4 (current layout)', () => {
  it('restores halls, active indices, view filter and unit', () => {
    const { found, sourceVersion, patch } = parseStoredState({ ...none, v4: V4 });
    expect(found).toBe(true);
    expect(sourceVersion).toBe(4);
    expect(patch.hallProfiles).toHaveLength(2);
    expect(patch.hallProfiles[1].name).toBe('DEN · Hall 2');
    expect(patch.hallProfiles[1].elevFt).toBe(5380);
    expect(patch.activeHall).toBe(1);
    expect(patch.hallView).toEqual({ loc: 'Westminster, CO', bld: '' });
    expect(patch.slaProfiles).toHaveLength(2);
    expect(patch.activeSla).toBe(1);
    expect(patch.tempUnit).toBe('C');
  });

  it('normalizes restored halls so old saves gain new fields', () => {
    const { patch } = parseStoredState({ ...none, v4: V4 });
    // effPct and the derates postdate these saves; they must come back defaulted
    // rather than undefined, or the planner would multiply by NaN.
    for (const h of patch.hallProfiles) {
      expect(h.effPct).toBe(85);
      expect(h.derateCoolPct).toBe(100);
      expect(h.results).toEqual([]);
    }
  });

  it('clamps out-of-range active indices instead of pointing at nothing', () => {
    const raw = JSON.stringify({ ...JSON.parse(V4), activeHall: 99, activeSla: 99 });
    const { patch } = parseStoredState({ ...none, v4: raw });
    expect(patch.activeHall).toBe(patch.hallProfiles.length - 1);
    expect(patch.activeSla).toBe(patch.slaProfiles.length - 1);
  });

  it('does not mutate the stored payload it was handed', () => {
    const parsedBefore = JSON.parse(V4);
    parseStoredState({ ...none, v4: V4 });
    expect(JSON.parse(V4)).toEqual(parsedBefore);
  });
});

describe('v3 (single hall)', () => {
  it('restores the hall, SLAs and unit', () => {
    const { found, sourceVersion, patch } = parseStoredState({ ...none, v3: V3 });
    expect(found).toBe(true);
    expect(sourceVersion).toBe(3);
    expect(patch.hall.siteName).toBe('Ashburn, VA');
    expect(patch.hall.elevFt).toBe(300);
    expect(patch.hall.hallVolFt3).toBe(120000);
    expect(patch.tempUnit).toBe('F');
  });

  it('re-derives a missing hall name from its site', () => {
    // The v3 fixture has no `name`, so the hall should come back labelled from
    // its site rather than as a bare default.
    const { patch } = parseStoredState({ ...none, v3: V3 });
    expect(patch.hall.name).toBe('Ashburn, VA · Hall');
  });

  it('prepends a locked Base SLA when the save lacks one', () => {
    const { patch } = parseStoredState({ ...none, v3: V3 });
    expect(patch.slaProfiles[0].locked).toBe(true);
    expect(patch.slaProfiles[0].name).toBe('Base SLA');
    expect(patch.slaProfiles[1].name).toBe('Customer A');
  });
});

describe('v1 (hall data on SLA profiles)', () => {
  it('lifts hall fields onto the hall and strips them from the profiles', () => {
    const hall = {}; // un-normalized, as a fresh boot would supply
    const { found, sourceVersion, patch } = parseStoredState({ ...none, v1: V1 }, hall);
    expect(found).toBe(true);
    expect(sourceVersion).toBe(1);

    // Lifted onto the hall…
    expect(hall.siteName).toBe('Plano, TX');
    expect(hall.elevFt).toBe(660);
    expect(hall.hallVolFt3).toBe(90000);
    expect(hall.rateCoolF).toBe(5);
    expect(hall.canDehumidify).toBe(true);

    // …and gone from the contracts.
    for (const profile of patch.slaProfiles) {
      for (const k of HALL_KEYS) expect(profile[k]).toBeUndefined();
    }
    // The contract itself survives intact.
    const legacy = patch.slaProfiles.find((s) => s.name === 'Legacy Customer');
    expect(legacy).toMatchObject({ tMinF: 64, tMaxF: 81, rhMin: 20, rhMax: 60 });
    expect(patch.tempUnit).toBe('K');
  });

  it('backfills ramp limits that predate the feature', () => {
    const { patch } = parseStoredState({ ...none, v1: V1 }, {});
    const legacy = patch.slaProfiles.find((s) => s.name === 'Legacy Customer');
    // v1 saves have no maxDtHr/maxDrhHr. They must come back as null (meaning
    // "no SLA ramp limit"), never undefined — the planner tests `if (sla.maxDtHr)`.
    expect(legacy.maxDtHr).toBeNull();
    expect(legacy.maxDrhHr).toBeNull();
  });
});

describe('version precedence', () => {
  it('prefers v4 over v3 over v1 when several are present', () => {
    expect(parseStoredState({ v4: V4, v3: V3, v1: V1 }, {}).sourceVersion).toBe(4);
    expect(parseStoredState({ v4: null, v3: V3, v1: V1 }, {}).sourceVersion).toBe(3);
    expect(parseStoredState({ v4: null, v3: null, v1: V1 }, {}).sourceVersion).toBe(1);
  });

  it('falls through a wrong-version marker to the next layout', () => {
    // A v4 key holding something that is not v4 must not shadow the v3 save.
    const notV4 = JSON.stringify({ v: 2, slaProfiles: [] });
    expect(parseStoredState({ v4: notV4, v3: V3, v1: null }, {}).sourceVersion).toBe(3);
  });
});

describe('corrupt and empty input', () => {
  it('reports "nothing found" rather than throwing or half-applying', () => {
    const cases = [
      none,
      { ...none, v4: '' },
      { ...none, v4: '{"broken' },
      { ...none, v4: 'null' },
      { ...none, v4: '[]' },
      { ...none, v4: '"a string"' },
      { ...none, v4: '12345' },
      { ...none, v1: '{"slaProfiles": "not an array"}' },
      { ...none, v1: '{"slaProfiles": []}' },
    ];
    for (const raw of cases) {
      const result = parseStoredState(raw, {});
      expect(result.found, JSON.stringify(raw)).toBe(false);
      expect(result.sourceVersion).toBe(0);
      expect(result.patch).toEqual({});
    }
  });

  it('drops junk entries inside an otherwise valid save', () => {
    const raw = JSON.stringify({
      v: 4,
      hallProfiles: [null, 'junk', { name: 'Real Hall' }],
      slaProfiles: [{ name: 'Real SLA' }, null],
      activeHall: 0,
      activeSla: 0,
    });
    const { patch } = parseStoredState({ ...none, v4: raw });
    expect(patch.hallProfiles.map((h) => h.name)).toEqual(['Real Hall']);
    expect(patch.slaProfiles.map((s) => s.name)).toEqual(['Base SLA', 'Real SLA']);
  });

  it('a corrupt v4 payload still lets an older save be recovered', () => {
    // The failure mode that matters: a truncated write of the newest key must not
    // cost the operator the data they had before it.
    const { sourceVersion, patch } = parseStoredState({ v4: '{"v":4,"hall', v3: V3, v1: null }, {});
    expect(sourceVersion).toBe(3);
    expect(patch.hall.siteName).toBe('Ashburn, VA');
  });
});

describe('round trip', () => {
  it('buildStoredState output parses back to the same state', () => {
    const state = {
      hallProfiles: [normalizeHall({ name: 'H1', elevFt: 1066 })],
      activeHall: 0,
      hallView: { loc: '', bld: '' },
      slaProfiles: [baseSla()],
      activeSla: 0,
      tempUnit: 'C',
    };
    const stored = JSON.stringify(buildStoredState(state));
    const { found, sourceVersion, patch } = parseStoredState({ ...none, v4: stored });
    expect(found).toBe(true);
    expect(sourceVersion).toBe(4);
    expect(patch.hallProfiles).toEqual(state.hallProfiles);
    expect(patch.slaProfiles).toEqual(state.slaProfiles);
    expect(patch.activeHall).toBe(0);
    expect(patch.activeSla).toBe(0);
    expect(patch.tempUnit).toBe('C');
  });

  it('is idempotent — re-saving a restored state changes nothing', () => {
    const first = parseStoredState({ ...none, v4: V4 }).patch;
    const restated = {
      hallProfiles: first.hallProfiles,
      activeHall: first.activeHall,
      hallView: first.hallView,
      slaProfiles: first.slaProfiles,
      activeSla: first.activeSla,
      tempUnit: first.tempUnit,
    };
    const second = parseStoredState({
      ...none,
      v4: JSON.stringify(buildStoredState(restated)),
    }).patch;
    expect(second).toEqual(first);
  });
});
