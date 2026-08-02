/**
 * Equipment inventory — a hall's capability as a consequence of its plant.
 *
 * The properties that matter operationally: a unit tagged out contributes
 * nothing (not a fraction), condition scales what a unit delivers, quantity
 * multiplies, unit conversions are exact, and the nameplate comparison stays
 * honest so "120 of 200 lb/hr" is sayable.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeEquip,
  normalizeInventory,
  unitOutput,
  inventoryTotals,
  inventoryNameplate,
  unitsForKind,
  isThermalKind,
  EQUIP_KINDS,
} from '../src/core/equipment.js';

const crah = { kind: 'cool', name: 'CRAH-1', count: 4, cap: 30, unit: 'ton' };

describe('normalizeEquip', () => {
  it('fills a complete unit from a partial entry', () => {
    const u = normalizeEquip({ kind: 'cool', cap: 30, unit: 'ton' });
    expect(u.count).toBe(1);
    expect(u.condPct).toBe(100); //  healthy until told otherwise
    expect(u.online).toBe(true); // in service unless tagged out
    expect(u.id).toMatch(/^eq_/); // stable key minted for the editor
  });

  it('rejects what cannot be repaired, repairs what can', () => {
    expect(normalizeEquip(null)).toBeNull();
    expect(normalizeEquip({ kind: 'teleporter' })).toBeNull(); // unknown kind
    // A water unit on a thermal kind falls back to that kind's first unit,
    // rather than silently computing kilowatts from gallons per hour.
    expect(normalizeEquip({ kind: 'cool', unit: 'gph' }).unit).toBe('kw');
    expect(normalizeEquip({ kind: 'humid', unit: 'ton' }).unit).toBe('lbhr');
    expect(normalizeEquip({ ...crah, count: 0 }).count).toBe(1);
    expect(normalizeEquip({ ...crah, count: 7.6 }).count).toBe(8);
    expect(normalizeEquip({ ...crah, condPct: 220 }).condPct).toBe(100);
    expect(normalizeEquip({ ...crah, condPct: -5 }).condPct).toBe(0);
    expect(normalizeEquip({ ...crah, cap: -3 }).cap).toBe(0);
  });

  it('keeps evaporative parameters only where they mean something', () => {
    const evap = normalizeEquip({ kind: 'humid', evap: { cfm: 8000, effPct: 90 } });
    expect(evap.evap).toEqual({ cfm: 8000, effPct: 90 });
    // A cooling unit has no media at all.
    expect(normalizeEquip({ kind: 'cool', evap: { cfm: 8000 } }).evap).toBeNull();
    // Neither does an "evap" block with no airflow figure in it.
    expect(normalizeEquip({ kind: 'humid', evap: { effPct: 90 } }).evap).toBeNull();
    // But airflow NOT YET ENTERED (0) still describes a media unit — it just
    // cannot produce a number until someone types the airflow.
    const fresh = normalizeEquip({ kind: 'humid', evap: { cfm: 0 } });
    expect(fresh.evap).toEqual({ cfm: 0, effPct: 85 });
    expect(unitOutput(fresh, () => 40)).toBe(0);
  });

  it('normalizeInventory drops the unrepairable and keeps the rest', () => {
    const inv = normalizeInventory([crah, null, { kind: 'nope' }, { kind: 'humid', cap: 20 }]);
    expect(inv).toHaveLength(2);
    expect(inv.map((u) => u.kind)).toEqual(['cool', 'humid']);
  });
});

describe('unitOutput', () => {
  it('multiplies quantity by capacity, converted to the base unit', () => {
    // 4 × 30 ton = 120 ton = 422.0 kW
    expect(unitOutput(normalizeEquip(crah))).toBeCloseTo(120 * 3.51685, 6);
    // Water units are exact algebra: 2 × 12 GPH = 24 gal/hr × 8.34 lb/gal
    const h = normalizeEquip({ kind: 'humid', count: 2, cap: 12, unit: 'gph' });
    expect(unitOutput(h)).toBeCloseTo(24 * 8.34, 6);
  });

  it('condition scales output; offline contributes nothing at all', () => {
    const half = normalizeEquip({ ...crah, condPct: 50 });
    expect(unitOutput(half)).toBeCloseTo(unitOutput(normalizeEquip(crah)) / 2, 6);
    // Tagged out is not "derated to zero" — it is absent. The distinction
    // matters because a returning unit restores its own condition, not 100 %.
    const out = normalizeEquip({ ...crah, condPct: 80, online: false });
    expect(unitOutput(out)).toBe(0);
    expect(out.condPct).toBe(80);
  });

  it('an evaporative unit defers to the psychrometric model it is given', () => {
    const u = normalizeEquip({ kind: 'humid', count: 3, condPct: 60, evap: { cfm: 9000, effPct: 90 } });
    // The caller supplies output-per-unit; count and condition still apply.
    expect(unitOutput(u, () => 50)).toBeCloseTo(50 * 3 * 0.6, 8);
    // With no model available it reports nothing rather than guessing.
    expect(unitOutput(u)).toBe(0);
    expect(unitOutput(u, () => 0)).toBe(0);
  });
});

describe('inventoryTotals', () => {
  const inv = normalizeInventory([
    { kind: 'cool', name: 'CRAH-1', count: 3, cap: 30, unit: 'ton' },
    { kind: 'cool', name: 'CRAH-4', count: 1, cap: 30, unit: 'ton', online: false },
    { kind: 'humid', name: 'HUM-1', count: 2, cap: 10, unit: 'lbhr', condPct: 50 },
    { kind: 'dehum', name: 'DH-1', count: 1, cap: 24, unit: 'lbhr' },
    { kind: 'heat', name: 'Reheat', count: 1, cap: 20, unit: 'kw' },
  ]);

  it('sums per kind, counting only what is in service', () => {
    const t = inventoryTotals(inv);
    expect(t.coolKW).toBeCloseTo(3 * 30 * 3.51685, 6); // CRAH-4 is out
    expect(t.heatKW).toBeCloseTo(20, 6);
    expect(t.dehumLbHr).toBeCloseTo(24, 6);
    expect(t.humidLbHr).toBeCloseTo(2 * 10 * 0.5, 6); // half-scaled media
    expect(t.counts.cool).toBe(3);
    expect(t.counts.humid).toBe(2);
  });

  it('reports what needs attention, for a banner that earns its place', () => {
    const t = inventoryTotals(inv);
    expect(t.offline).toBe(1); //  CRAH-4
    expect(t.degraded).toBe(1); // HUM-1 at 50 %
  });

  it('nameplate is the same inventory at full health — the honest yardstick', () => {
    const now = inventoryTotals(inv);
    const full = inventoryNameplate(inv);
    // The offline CRAH and the scaled humidifiers come back.
    expect(full.coolKW).toBeCloseTo(4 * 30 * 3.51685, 6);
    expect(full.humidLbHr).toBeCloseTo(20, 6);
    expect(now.humidLbHr / full.humidLbHr).toBeCloseTo(0.5, 6);
    expect(full.offline).toBe(0);
  });

  it('an empty or junk inventory totals to zero rather than throwing', () => {
    for (const bad of [[], null, undefined, 'nope', [null, { kind: 'x' }]]) {
      const t = inventoryTotals(bad);
      expect(t.coolKW).toBe(0);
      expect(t.humidLbHr).toBe(0);
    }
  });
});

describe('kind metadata', () => {
  it('offers only units that make sense for the kind', () => {
    expect(unitsForKind('cool')).toContain('ton');
    expect(unitsForKind('cool')).not.toContain('gph');
    expect(unitsForKind('humid')).toContain('gph');
    expect(unitsForKind('humid')).not.toContain('ton');
    expect(EQUIP_KINDS.filter(isThermalKind)).toEqual(['cool', 'heat']);
  });
});
