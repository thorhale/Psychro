/**
 * Ramp planner: mass-balance arithmetic, efficiency/derate scaling, and
 * binding-constraint selection — the logic that turns a Current→Target move into
 * an honest time estimate.
 */

import { describe, it, expect } from 'vitest';
import { rampPlanFor, fmtHrs } from '../src/core/planner.js';
import { humidityRatio, specificVolume } from '../src/core/psychro.js';
import { fToC, ft3ToM3, kgToLb } from '../src/core/units.js';

const P0 = 101.325;

/** A hall with everything installed and no losses, so tests isolate one factor. */
const idealHall = () => ({
  effPct: 100,
  derateCoolPct: 100,
  derateWarmPct: 100,
  derateDehumPct: 100,
  derateHumPct: 100,
  rateCoolF: 6,
  rateWarmF: 4,
  rateDehumLb: 100,
  rateHumLb: 80,
  hallVolFt3: 200000,
  canDehumidify: true,
  canHumidify: true,
});

const noLimits = { maxDtHr: null, maxDrhHr: null };

const plan = (over = {}) =>
  rampPlanFor({
    sla: noLimits,
    hall: idealHall(),
    aTempF: 75,
    aRH: 45,
    bTempF: 75,
    bRH: 45,
    p: P0,
    ...over,
  });

describe('binding-constraint selection', () => {
  it('no move → instant', () => {
    const r = plan();
    expect(r.hours).toBe(0);
    expect(fmtHrs(r.hours)).toBe('instant');
  });

  it('pure cooling: time = ΔT / effective rate', () => {
    const r = plan({ bTempF: 63 }); // 12 °F drop at 6 °F/hr
    expect(r.hours).toBeCloseTo(2, 5);
    expect(r.binding).toBe('cooling capacity');
    expect(r.tempCap).toEqual({ rate: 6, label: 'Cool' });
  });

  it('pure warming uses the warming rate', () => {
    const r = plan({ bTempF: 83 }); // 8 °F rise at 4 °F/hr
    expect(r.hours).toBeCloseTo(2, 5);
    expect(r.binding).toBe('warming capacity');
  });

  it('SLA ramp limit binds when slower than the plant', () => {
    const r = plan({ sla: { maxDtHr: 3, maxDrhHr: null }, bTempF: 63 });
    expect(r.hours).toBeCloseTo(4, 5); // 12 °F / 3 °F/hr SLA beats 2 h plant time
    expect(r.binding).toBe('SLA temp limit');
  });

  it('the slowest of several constraints wins', () => {
    const r = plan({
      sla: { maxDtHr: 12, maxDrhHr: 2 },
      bTempF: 63,
      bRH: 25,
    });
    expect(r.binding).toBe('SLA humidity limit'); // 20 % / 2 %/hr = 10 h
    expect(r.hours).toBeCloseTo(10, 5);
  });
});

describe('efficiency and derate scaling', () => {
  it('effPct scales plant rates but not SLA limits', () => {
    const r = plan({ hall: { ...idealHall(), effPct: 50 }, bTempF: 63 });
    expect(r.hours).toBeCloseTo(4, 5); // rate halved → time doubled
    const s = plan({
      hall: { ...idealHall(), effPct: 50 },
      sla: { maxDtHr: 6, maxDrhHr: null },
      bTempF: 63,
    });
    expect(s.hours).toBeCloseTo(4, 5); // SLA 2 h < derated plant 4 h → plant binds
    expect(s.binding).toBe('cooling capacity');
  });

  it('nameplate option skips efficiency but keeps derates', () => {
    const hall = { ...idealHall(), effPct: 50, derateCoolPct: 50 };
    const withEff = rampPlanFor(
      { sla: noLimits, hall, aTempF: 75, aRH: 45, bTempF: 63, bRH: 45, p: P0 },
    );
    const nameplate = rampPlanFor(
      { sla: noLimits, hall, aTempF: 75, aRH: 45, bTempF: 63, bRH: 45, p: P0 },
      { nameplate: true },
    );
    expect(withEff.hours).toBeCloseTo(8, 5); // 6 °F/hr × 0.5 × 0.5 = 1.5
    expect(nameplate.hours).toBeCloseTo(4, 5); // 6 °F/hr × 0.5 = 3
  });

  it('direction-aware derates: cooling derate leaves warming untouched', () => {
    const hall = { ...idealHall(), derateCoolPct: 25 };
    const cool = rampPlanFor({ sla: noLimits, hall, aTempF: 75, aRH: 45, bTempF: 69, bRH: 45, p: P0 });
    const warm = rampPlanFor({ sla: noLimits, hall, aTempF: 75, aRH: 45, bTempF: 81, bRH: 45, p: P0 });
    expect(cool.hours).toBeCloseTo(4, 5); // 6 °F at 1.5 °F/hr
    expect(warm.hours).toBeCloseTo(1.5, 5); // 6 °F at 4 °F/hr, underated
  });
});

describe('moisture mass balance', () => {
  it('reproduces the first-principles water mass', () => {
    // 75→75 °F, 45→35 % RH: pure dehumidification.
    const a = { t: 75, rh: 45 };
    const b = { t: 75, rh: 35 };
    const hall = idealHall();
    const r = plan({ bTempF: b.t, bRH: b.rh });

    const W0 = humidityRatio(fToC(a.t), a.rh, P0);
    const Wb = humidityRatio(fToC(b.t), b.rh, P0);
    const v = specificVolume(fToC(a.t), W0, P0);
    const m_da = ft3ToM3(hall.hallVolFt3) / v;
    const waterLb = kgToLb(m_da * Math.abs(Wb - W0));

    expect(r.moistCap).not.toBeNull();
    expect(r.moistCap.label).toBe('Dehum');
    expect(r.moistCap.waterLb).toBeCloseTo(waterLb, 6);
    expect(r.hours).toBeCloseTo(waterLb / hall.rateDehumLb, 6);
    expect(r.binding).toBe('dehumidify capacity');
  });

  it('humidify direction uses the humidifier rate', () => {
    const r = plan({ bRH: 60 });
    expect(r.moistCap.label).toBe('Humidify');
    expect(r.binding).toBe('humidify capacity');
  });

  it('flags needsVol when a rate exists but the hall volume is missing', () => {
    const r = plan({ hall: { ...idealHall(), hallVolFt3: null }, bRH: 30 });
    expect(r.needsVol).toBe(true);
    expect(r.moistCap).toBeNull();
  });

  it('altitude: air-mass and ΔW effects nearly cancel at fixed ΔRH', () => {
    // At altitude there is less air mass per ft³ (m_da ∝ p) but the SAME RH change
    // spans a larger humidity-ratio difference (ΔW ∝ 1/p) — the two cancel to
    // first order, so the water mass for a fixed ΔRH move is nearly
    // pressure-independent. Locking this in guards the mass balance against
    // anyone "fixing" one factor without the other.
    const sea = plan({ bRH: 35 });
    const alt = plan({ bRH: 35, p: 79.5 });
    const rel = Math.abs(alt.moistCap.waterLb - sea.moistCap.waterLb) / sea.moistCap.waterLb;
    expect(rel).toBeLessThan(0.01);
  });
});

describe('fmtHrs', () => {
  it('formats durations the way operators read them', () => {
    expect(fmtHrs(0)).toBe('instant');
    expect(fmtHrs(0.5)).toBe('30 min');
    expect(fmtHrs(0.751)).toBe('46 min'); // ceil on minutes
    expect(fmtHrs(1)).toBe('1 h');
    expect(fmtHrs(1.0667)).toBe('1 h 4 min');
    expect(fmtHrs(26)).toBe('26 h');
  });
});
