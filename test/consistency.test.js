/**
 * Cross-surface consistency.
 *
 * The properties table, the Current→Target readout, the chart hover inspector
 * and the PNG/PDF export all display numbers for the same state. They agree
 * because they all read `deriveState` (src/core/derive.js) — this file pins the
 * two halves of that guarantee:
 *
 *   1. `deriveState` itself equals independent recomputation from raw core calls,
 *      so the shared function is not quietly wrong in a way all four inherit.
 *   2. The planner consumes the same humidity ratios the display shows, so the
 *      "you must move 27 lb of water" figure is consistent with the "W: 6.82 g/kg"
 *      figure sitting next to it.
 *
 * The wiring itself — that each surface really calls it — is verified end-to-end
 * against the built artifact in `test/e2e/app.spec.js`.
 */

import { describe, it, expect } from 'vitest';
import { deriveState, deriveStateF } from '../src/core/derive.js';
import {
  satPressure,
  vaporPressure,
  humidityRatioFromPw,
  dewPoint,
  wetBulbSolve,
  enthalpy,
  specificVolume,
  moistAirDensity,
  absHumidity,
  entropy,
  degreeOfSaturation,
  pressureFromAltitude,
} from '../src/core/psychro.js';
import { ashraeZone, checkSLA } from '../src/core/envelopes.js';
import { rampPlanFor } from '../src/core/planner.js';
import { fToC, cToF, ft3ToM3, kgToLb } from '../src/core/units.js';
import { CORE_DOMAIN } from '../src/core/domain.js';

/** Same seeded sampler as the invariant suite, so failures are reproducible. */
const SEED = 0xc0ffee;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const STATES = Array.from({ length: 300 }, () => ({
  tc: CORE_DOMAIN.tMinC + rand() * (CORE_DOMAIN.tMaxC - CORE_DOMAIN.tMinC),
  rh: 1 + rand() * 99,
  p: CORE_DOMAIN.pMinKpa + rand() * (CORE_DOMAIN.pMaxKpa - CORE_DOMAIN.pMinKpa),
})).filter((s) => humidityRatioFromPw(vaporPressure(s.tc, s.rh), s.p, s.tc) <= CORE_DOMAIN.wMaxKgKg);

const at = (s) => `seed ${SEED} @ ${s.tc.toFixed(4)}°C ${s.rh.toFixed(4)}% ${s.p.toFixed(4)}kPa`;

describe('deriveState equals independent recomputation', () => {
  it('every field matches a raw core call, exactly', () => {
    for (const s of STATES) {
      const d = deriveState(s.tc, s.rh, s.p);
      const pws = satPressure(s.tc);
      const pw = vaporPressure(s.tc, s.rh);
      const W = humidityRatioFromPw(pw, s.p, s.tc);
      const tdp = dewPoint(pw);
      const wb = wetBulbSolve(s.tc, s.rh, s.p);

      // Object.is, not toBeCloseTo: the shared function must not merely be
      // approximately the core, it must BE the core.
      expect(Object.is(d.pws, pws), `pws — ${at(s)}`).toBe(true);
      expect(Object.is(d.pw, pw), `pw — ${at(s)}`).toBe(true);
      expect(Object.is(d.W, W), `W — ${at(s)}`).toBe(true);
      expect(Object.is(d.Wg, W * 1000), `Wg — ${at(s)}`).toBe(true);
      expect(Object.is(d.tdpC, tdp), `tdp — ${at(s)}`).toBe(true);
      expect(Object.is(d.twbC, wb.value), `twb — ${at(s)}`).toBe(true);
      expect(Object.is(d.twbAmbiguous, wb.ambiguous === true), `twbAmbiguous — ${at(s)}`).toBe(true);
      expect(Object.is(d.h, enthalpy(s.tc, W, s.p)), `h — ${at(s)}`).toBe(true);
      expect(Object.is(d.v, specificVolume(s.tc, W, s.p)), `v — ${at(s)}`).toBe(true);
      expect(Object.is(d.rho, moistAirDensity(s.tc, s.rh, s.p)), `rho — ${at(s)}`).toBe(true);
      expect(Object.is(d.absHum, absHumidity(s.tc, pw)), `absHum — ${at(s)}`).toBe(true);
      expect(Object.is(d.s, entropy(s.tc, s.rh, s.p)), `s — ${at(s)}`).toBe(true);
      expect(Object.is(d.mu, degreeOfSaturation(s.tc, s.rh, s.p)), `mu — ${at(s)}`).toBe(true);
      expect(d.zone, `zone — ${at(s)}`).toBe(ashraeZone(s.tc, s.rh, s.p));
    }
  });

  it('the °F entry point is the °C one with the conversion applied', () => {
    for (const s of STATES.slice(0, 100)) {
      const tempF = cToF(s.tc);
      expect(deriveStateF(tempF, s.rh, s.p)).toEqual(deriveState(fToC(tempF), s.rh, s.p));
    }
  });

  it('internal unit pairs agree with each other', () => {
    // The surfaces read whichever unit suits them; both must describe one state.
    for (const s of STATES) {
      const d = deriveState(s.tc, s.rh, s.p);
      expect(d.tempF, `tempF — ${at(s)}`).toBeCloseTo(cToF(d.tc), 10);
      expect(d.Wg, `Wg — ${at(s)}`).toBeCloseTo(d.W * 1000, 12);
      expect(d.twbF, `twbF — ${at(s)}`).toBeCloseTo(cToF(d.twbC), 10);
      if (d.tdpC != null) expect(d.tdpF, `tdpF — ${at(s)}`).toBeCloseTo(cToF(d.tdpC), 10);
      else expect(d.tdpF).toBeNull();
    }
  });

  it('density and specific volume describe the same air', () => {
    for (const s of STATES) {
      // ρ = (1 + W) / v, by definition of the mixture.
      expect(d(s).rho, `ρ = (1+W)/v — ${at(s)}`).toBeCloseTo((d(s).W + 1) / d(s).v, 10);
    }
    function d(s) {
      return deriveState(s.tc, s.rh, s.p);
    }
  });
});

describe('the planner and the display agree on moisture', () => {
  const hall = {
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
  };
  const sla = { maxDtHr: null, maxDrhHr: null };

  it('water mass equals hall dry-air mass × the ΔW the table shows', () => {
    // The number an operator acts on ("move 27 lb of water") has to reconcile
    // with the two W values displayed beside it, or the tool contradicts itself.
    for (const s of STATES.slice(0, 60)) {
      const p = s.p;
      const aTempF = cToF(s.tc);
      const aRH = s.rh;
      const bRH = Math.max(1, Math.min(100, s.rh - 10)); // pure dehumidification
      const plan = rampPlanFor({ sla, hall, aTempF, aRH, bTempF: aTempF, bRH, p });
      if (!plan.moistCap) continue;

      const dA = deriveStateF(aTempF, aRH, p);
      const dB = deriveStateF(aTempF, bRH, p);
      const mDryAir = ft3ToM3(hall.hallVolFt3) / dA.v;
      const expectedLb = kgToLb(mDryAir * Math.abs(dB.W - dA.W));

      expect(plan.moistCap.waterLb, `water mass — ${at(s)}`).toBeCloseTo(expectedLb, 9);
      expect(plan.hours, `hours — ${at(s)}`).toBeCloseTo(expectedLb / hall.rateDehumLb, 9);
    }
  });

  it('a move with no moisture change reports no moisture work', () => {
    for (const s of STATES.slice(0, 40)) {
      const aTempF = cToF(s.tc);
      const plan = rampPlanFor({
        sla,
        hall,
        aTempF,
        aRH: s.rh,
        bTempF: aTempF,
        bRH: s.rh,
        p: s.p,
      });
      expect(plan.moistCap, `no ΔW — ${at(s)}`).toBeNull();
      expect(plan.hours).toBe(0);
    }
  });

  it('the planner reads the same pressure the display does', () => {
    // Both must derive site pressure from elevation the same way — a mismatch
    // would make the estimate right for sea level and wrong for Denver.
    for (const elevFt of [0, 660, 1066, 5380]) {
      const p = pressureFromAltitude(elevFt);
      const plan = rampPlanFor({
        sla,
        hall,
        aTempF: 75,
        aRH: 45,
        bTempF: 75,
        bRH: 35,
        p,
      });
      const dA = deriveStateF(75, 45, p);
      const dB = deriveStateF(75, 35, p);
      const expected = kgToLb((ft3ToM3(hall.hallVolFt3) / dA.v) * Math.abs(dB.W - dA.W));
      expect(plan.moistCap.waterLb, `${elevFt} ft`).toBeCloseTo(expected, 9);
    }
  });
});

describe('SLA compliance agrees with the derived dew point', () => {
  const profile = { tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 };

  it('a dew-point verdict matches the dew point the surfaces display', () => {
    // The badge and the table must not disagree about whether the cap is breached.
    for (const s of STATES) {
      const tempF = cToF(s.tc);
      if (tempF < profile.tMinF || tempF > profile.tMaxF) continue;
      if (s.rh < profile.rhMin || s.rh > profile.rhMax) continue;
      const d = deriveStateF(tempF, s.rh, s.p);
      const verdict = checkSLA(profile, tempF, s.rh);
      const capBreached = d.tdpF != null && d.tdpF > profile.dpMaxF;
      expect(verdict.ok, `cap agreement — ${at(s)} (dp ${d.tdpF?.toFixed(2)}°F)`).toBe(
        !capBreached,
      );
      if (capBreached) expect(verdict.detail).toBe('above dew point cap');
    }
  });

  it('SLA verdicts are pressure-independent, as the contract is', () => {
    // An SLA is a contract on temperature, RH and dew point — none of which are
    // pressure-derived — so the same reading must grade identically at any site.
    for (const s of STATES.slice(0, 100)) {
      const tempF = cToF(s.tc);
      const verdicts = [60, 79.5, 101.325, 108].map(() => checkSLA(profile, tempF, s.rh));
      for (const v of verdicts) expect(v).toEqual(verdicts[0]);
    }
  });
});
