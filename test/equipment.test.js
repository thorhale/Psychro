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
  perMachineOutput,
  inventoryTotals,
  inventoryNameplate,
  ratesFromTotals,
  worstSingleLoss,
  logCondition,
  conditionTrend,
  HIST_MAX,
  unitsForKind,
  baseUnitOf,
  isThermalKind,
  isAirKind,
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

describe('air movement', () => {
  it('converts airflow units exactly and totals into CFM', () => {
    // 2 fans × 10 000 CFM, one of them at 60 % of nameplate airflow.
    const good = normalizeEquip({ kind: 'air', count: 2, cap: 10000, unit: 'cfm' });
    expect(unitOutput(good)).toBeCloseTo(20000, 6);
    // 1 m³/hr = 0.5885778 CFM — an AHU plated in metric still lands in CFM.
    const metric = normalizeEquip({ kind: 'air', count: 1, cap: 17000, unit: 'm3h' });
    expect(unitOutput(metric)).toBeCloseTo(17000 * 0.5885778, 6);
    // A loading filter or a slipping belt is condition, same as anywhere else.
    const tired = normalizeEquip({ kind: 'air', count: 1, cap: 10000, unit: 'cfm', condPct: 60 });
    expect(unitOutput(tired)).toBeCloseTo(6000, 6);

    const t = inventoryTotals(normalizeInventory([good, tired]));
    expect(t.airCfm).toBeCloseTo(26000, 6);
    expect(t.counts.air).toBe(3);
    // Airflow is its own base unit — it must not leak into a thermal total.
    expect(t.coolKW).toBe(0);
  });

  it('is neither thermal nor water, and says so', () => {
    expect(isAirKind('air')).toBe(true);
    expect(isThermalKind('air')).toBe(false);
    expect(baseUnitOf('air')).toBe('CFM');
    expect(baseUnitOf('cool')).toBe('kW');
    expect(baseUnitOf('humid')).toBe('lb/hr');
    expect(unitsForKind('air')).toEqual(['cfm', 'm3h', 'cmm', 'lps']);
    // Air units must not be offered where they would compute nonsense.
    expect(unitsForKind('cool')).not.toContain('cfm');
    expect(normalizeEquip({ kind: 'cool', unit: 'cfm' }).unit).toBe('kw');
    expect(normalizeEquip({ kind: 'air', unit: 'ton' }).unit).toBe('cfm');
  });
});

describe('worstSingleLoss', () => {
  // Four CRAHs in two line items, plus one big AHU. N+1 is only true while
  // the spare capacity is real, so the question is always "lose the biggest".
  const inv = normalizeInventory([
    { kind: 'cool', name: 'CRAH-1..3', count: 3, cap: 30, unit: 'ton' },
    { kind: 'cool', name: 'AHU-1', count: 1, cap: 50, unit: 'ton' },
    { kind: 'cool', name: 'CRAH-4', count: 1, cap: 30, unit: 'ton', online: false },
  ]);

  it('loses ONE machine out of a line item, not the whole line', () => {
    const three = normalizeEquip({ kind: 'cool', count: 3, cap: 30, unit: 'ton' });
    expect(perMachineOutput(three)).toBeCloseTo(30 * 3.51685, 6);

    const r = worstSingleLoss(inv, 'cool');
    // In service: 3 × 30 + 1 × 50 = 140 ton. The single biggest is the 50-ton
    // AHU, and the out-of-service CRAH is not available to lose.
    expect(r.total).toBeCloseTo(140 * 3.51685, 6);
    expect(r.worst).toBeCloseTo(50 * 3.51685, 6);
    expect(r.worstName).toBe('AHU-1');
    expect(r.remaining).toBeCloseTo(90 * 3.51685, 6);
    expect(r.machines).toBe(4);
  });

  it('counts a degraded machine at what it actually delivers', () => {
    // A half-dead 50-ton AHU is no longer the worst thing that can fail —
    // a healthy 30-ton CRAH is. Planning off nameplate would get this wrong.
    const sick = normalizeInventory([
      { kind: 'cool', name: 'CRAH', count: 3, cap: 30, unit: 'ton' },
      { kind: 'cool', name: 'AHU-1', count: 1, cap: 50, unit: 'ton', condPct: 40 },
    ]);
    const r = worstSingleLoss(sick, 'cool');
    expect(r.worstName).toBe('CRAH');
    expect(r.worst).toBeCloseTo(30 * 3.51685, 6);
  });

  it('reports nothing to lose rather than a zero that reads like an answer', () => {
    expect(worstSingleLoss(inv, 'humid')).toBeNull();
    expect(worstSingleLoss([], 'cool')).toBeNull();
    expect(worstSingleLoss(null, 'cool')).toBeNull();
    // Everything tagged out is also "nothing in service to lose".
    const allOut = normalizeInventory([{ kind: 'cool', count: 2, cap: 30, unit: 'ton', online: false }]);
    expect(worstSingleLoss(allOut, 'cool')).toBeNull();
  });

  it('works on evaporative humidifiers through the same model hook', () => {
    const inv2 = normalizeInventory([
      { kind: 'humid', name: 'HUM-A', count: 2, evap: { cfm: 9000, effPct: 85 } },
      { kind: 'humid', name: 'HUM-B', count: 1, cap: 15, unit: 'lbhr' },
    ]);
    const r = worstSingleLoss(inv2, 'humid', () => 40);
    expect(r.total).toBeCloseTo(2 * 40 + 15, 6);
    expect(r.worstName).toBe('HUM-A'); // 40 lb/hr each beats the 15 lb/hr unit
    expect(r.remaining).toBeCloseTo(40 + 15, 6);
    expect(r.machines).toBe(3);
  });
});

describe('ratesFromTotals', () => {
  // A 20 000 ft³ hall of air is roughly 700 kJ/K; the exact figure comes from
  // the caller, so these tests use a round one and check the algebra.
  const C = 700;
  const totals = (over = {}) => ({ ...inventoryTotals([]), ...over });

  it('turns kilowatts into °F/hr against the mass being conditioned', () => {
    // 100 kW into 700 kJ/K = 100·3600/700 K/hr = 514.3 K/hr → ×1.8 = 925.7 °F/hr
    const r = ratesFromTotals(totals({ heatKW: 100 }), { cKJperK: C });
    expect(r.rateWarmF).toBeCloseTo(925.7, 1);
    // Halving the capacity halves the rate; doubling the mass halves it again.
    expect(ratesFromTotals(totals({ heatKW: 50 }), { cKJperK: C }).rateWarmF)
      .toBeCloseTo(r.rateWarmF / 2, 1);
    expect(ratesFromTotals(totals({ heatKW: 100 }), { cKJperK: 2 * C }).rateWarmF)
      .toBeCloseTo(r.rateWarmF / 2, 1);
  });

  it('cooling has to carry the IT load before any of it pulls the room down', () => {
    const full = ratesFromTotals(totals({ coolKW: 300 }), { cKJperK: C });
    const loaded = ratesFromTotals(totals({ coolKW: 300 }), { cKJperK: C, itKW: 200 });
    // Only the 100 kW of excess is a rate, so it matches 100 kW of heating.
    expect(loaded.rateCoolF).toBeCloseTo(
      ratesFromTotals(totals({ heatKW: 100 }), { cKJperK: C }).rateWarmF, 6);
    expect(loaded.rateCoolF).toBeLessThan(full.rateCoolF);
    // Cooling that does not beat the IT load is no pulldown at all — null,
    // not a small positive number promising a move that never finishes.
    expect(ratesFromTotals(totals({ coolKW: 150 }), { cKJperK: C, itKW: 200 }).rateCoolF).toBeNull();
    expect(ratesFromTotals(totals({ coolKW: 200 }), { cKJperK: C, itKW: 200 }).rateCoolF).toBeNull();
  });

  it('says null rather than guessing when it cannot answer', () => {
    // Water and airflow need no thermal mass, so they still come through.
    const noMass = ratesFromTotals(totals({ coolKW: 300, humidLbHr: 40, airCfm: 12000 }), {});
    expect(noMass.rateCoolF).toBeNull();
    expect(noMass.rateWarmF).toBeNull();
    expect(noMass.rateHumLb).toBe(40);
    expect(noMass.airflowCfm).toBe(12000);
    // A kind with nothing installed is null, which is how the hall says
    // "cannot do this at all" rather than "can do it at zero".
    expect(noMass.rateDehumLb).toBeNull();
    // Junk in, nulls out — never a NaN loose in the planner.
    for (const bad of [null, undefined]) {
      const r = ratesFromTotals(bad, { cKJperK: C });
      expect(Object.values(r).every((v) => v === null)).toBe(true);
    }
    expect(ratesFromTotals(totals({ heatKW: 100 }), { cKJperK: 0 }).rateWarmF).toBeNull();
  });

  it('rounds to what an operator would actually type', () => {
    const r = ratesFromTotals(totals({ heatKW: 1, dehumLbHr: 24.44449, airCfm: 9999.6 }), { cKJperK: C });
    expect(r.rateWarmF).toBe(9.3); //     one decimal, like the rate field
    expect(r.rateDehumLb).toBe(24.4); //  one decimal, like the lb/hr field
    expect(r.airflowCfm).toBe(10000); //  whole CFM
  });

  it('agrees with a real inventory end to end', () => {
    const inv = normalizeInventory([
      { kind: 'cool', count: 4, cap: 30, unit: 'ton' },
      { kind: 'humid', count: 2, cap: 20, unit: 'lbhr', condPct: 50 },
      { kind: 'air', count: 2, cap: 10000, unit: 'cfm', condPct: 75 },
    ]);
    const r = ratesFromTotals(inventoryTotals(inv), { cKJperK: C, itKW: 100 });
    // 120 ton = 422.02 kW, less 100 kW of IT = 322.02 kW of pulldown.
    const excess = 120 * 3.51685 - 100;
    expect(r.rateCoolF).toBeCloseTo(Math.round(((excess * 3600) / C) * 1.8 * 10) / 10, 6);
    expect(r.rateHumLb).toBe(20); //   2 × 20 lb/hr at half condition
    expect(r.airflowCfm).toBe(15000); // 2 × 10 000 CFM at 75 %
    expect(r.rateWarmF).toBeNull(); //   no heating installed
  });
});

describe('condition history', () => {
  const fresh = () => normalizeEquip({ kind: 'humid', name: 'HUM-1', cap: 20 });

  it('remembers where a machine has been, one reading per day', () => {
    const u = fresh();
    logCondition(u, 100, '2026-01-10');
    logCondition(u, 85, '2026-03-02');
    logCondition(u, 60, '2026-06-01');
    expect(u.hist).toEqual([
      { d: '2026-01-10', c: 100 },
      { d: '2026-03-02', c: 85 },
      { d: '2026-06-01', c: 60 },
    ]);
    // Fiddling with the number all afternoon is ONE observation, not six.
    logCondition(u, 55, '2026-06-01');
    logCondition(u, 58, '2026-06-01');
    expect(u.hist).toHaveLength(3);
    expect(u.hist[2]).toEqual({ d: '2026-06-01', c: 58 });
    // An unchanged reading on a later day adds nothing to the story.
    logCondition(u, 58, '2026-07-01');
    expect(u.hist).toHaveLength(3);
  });

  it('keeps a bounded, ordered history through storage', () => {
    const u = fresh();
    for (let i = 1; i <= HIST_MAX + 5; i++) {
      logCondition(u, 100 - i, `2026-01-${String(i).padStart(2, '0')}`);
    }
    expect(u.hist).toHaveLength(HIST_MAX);
    expect(u.hist[u.hist.length - 1].c).toBe(100 - (HIST_MAX + 5)); // newest kept
    // Whatever order storage hands them back, they come out oldest-first, and
    // entries that are not a date and a number are dropped rather than kept.
    const round = normalizeEquip({
      kind: 'humid',
      hist: [{ d: '2026-05-01', c: 70 }, { d: '2026-02-01', c: 90 }, { d: 'whenever', c: 5 }, null, { d: '2026-03-01' }],
    });
    expect(round.hist).toEqual([{ d: '2026-02-01', c: 90 }, { d: '2026-05-01', c: 70 }]);
    expect(normalizeEquip({ kind: 'humid' }).hist).toEqual([]);
  });

  it('refuses to draw a trend through a single point', () => {
    const u = fresh();
    expect(conditionTrend(u)).toBeNull();
    logCondition(u, 90, '2026-01-10');
    expect(conditionTrend(u)).toBeNull(); // one reading is a fact, not a trend
    logCondition(u, 72, '2026-05-10');
    expect(conditionTrend(u)).toEqual({
      from: 90, to: 72, delta: -18, since: '2026-01-10', readings: 2,
    });
    // Recovery after service reads as a rise, so the UI can stay quiet on it.
    logCondition(u, 95, '2026-06-10');
    expect(conditionTrend(u).delta).toBe(5);
  });

  it('ignores what it cannot record', () => {
    const u = fresh();
    logCondition(u, NaN, '2026-01-10');
    logCondition(u, 80, 'today');
    logCondition(null, 80, '2026-01-10');
    expect(u.hist).toEqual([]);
    // Out-of-range readings are clamped, not dropped — someone typed something.
    logCondition(u, 140, '2026-01-10');
    expect(u.hist).toEqual([{ d: '2026-01-10', c: 100 }]);
  });
});

describe('kind metadata', () => {
  it('offers only units that make sense for the kind', () => {
    expect(unitsForKind('cool')).toContain('ton');
    expect(unitsForKind('cool')).not.toContain('gph');
    expect(unitsForKind('humid')).toContain('gph');
    expect(unitsForKind('humid')).not.toContain('ton');
    expect(EQUIP_KINDS.filter(isThermalKind)).toEqual(['cool', 'heat']);
    expect(EQUIP_KINDS.filter(isAirKind)).toEqual(['air']);
  });
});
