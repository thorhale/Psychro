/**
 * What a fresh install opens to.
 *
 * The app was shared, and the person it was shared with opened it to one
 * company's whole campus list, a hall at that company's site, and SLAs named
 * "Customer 1" and "Customer 2". None of it was theirs. These pin the fix:
 * the app ships no sites, no hall location and no contract, and an existing
 * install's own data still survives the update that removed them.
 */

import { describe, it, expect } from 'vitest';
import { state } from '../src/app/state.js';
import { allSites } from '../src/config/sites.js';
import { parseStoredState, baseSla } from '../src/state/persistence.js';
import { pressureFromAltitude } from '../src/core/psychro.js';

describe('a fresh install ships no operator data', () => {
  it('has no built-in sites: the picker lists only what this device added', () => {
    expect(allSites()).toEqual([]);
    const mine = allSites([{ state: 'Colorado', city: 'Denver', code: 'DEN-1', elevFt: 5280 }]);
    expect(mine).toHaveLength(1);
    expect(mine[0].siteName).toBe('Denver, CO');
  });

  it('the default hall has no location and sits at sea level until told otherwise', () => {
    expect(state.hallProfiles).toHaveLength(1);
    const h = state.hallProfiles[0];
    expect(h.name).toBe('Hall 1');
    expect(h.siteName).toBe('');
    expect(h.building).toBe('');
    expect(h.elevFt).toBe(0);
    expect(state.pressure).toBeCloseTo(pressureFromAltitude(0), 9);
  });

  it('ships public reference envelopes, not contracts with somebody\'s name on them', () => {
    const names = state.slaProfiles.map((s) => s.name);
    expect(names.every((n) => /^ASHRAE /.test(n))).toBe(true);
    expect(names.join(' ')).not.toMatch(/customer|base sla/i);
    // The locked entry the migration prepends must be the one that ships, or
    // a reset install and a migrated one would disagree about index 0.
    expect(state.slaProfiles[0]).toEqual(baseSla());
  });

  it('the reference envelopes carry the published ASHRAE TC 9.9 bounds', () => {
    const [a1, rec] = state.slaProfiles;
    // A1 allowable: 15–32 °C, 8–80 %RH, dew point ≤ 17 °C.
    expect([a1.tMinF, a1.tMaxF, a1.rhMin, a1.rhMax, a1.dpMaxF]).toEqual([59, 89.6, 8, 80, 62.6]);
    // Recommended: 18–27 °C, dew point ≤ 15 °C; 60 % RH is the low-pollution ceiling.
    expect([rec.tMinF, rec.tMaxF, rec.rhMax, rec.dpMaxF]).toEqual([64.4, 80.6, 60, 59]);
  });
});

describe('an existing install keeps its own data across this update', () => {
  it('a save with its own locked SLA keeps it in front, name and all', () => {
    const raw = JSON.stringify({
      v: 4,
      hallProfiles: [{ name: 'Hall 1', siteName: 'Westminster, CO', elevFt: 5380 }],
      activeHall: 0,
      slaProfiles: [
        { name: 'Base SLA', tMinF: 50, tMaxF: 95, rhMin: 5, rhMax: 80, dpMaxF: null, locked: true },
        { name: 'Customer 1', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80 },
      ],
      activeSla: 1,
    });
    const { found, patch } = parseStoredState({ v4: raw, v3: null, v1: null });
    expect(found).toBe(true);
    expect(patch.slaProfiles.map((s) => s.name)).toEqual(['Base SLA', 'Customer 1']);
    expect(patch.slaProfiles[0].tMaxF).toBe(95);
    expect(patch.hallProfiles[0].siteName).toBe('Westminster, CO');
    expect(patch.hallProfiles[0].elevFt).toBe(5380);
  });
});
