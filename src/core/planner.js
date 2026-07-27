/**
 * Transition planning: the realistic time for a Current→Target move.
 *
 * Two families of constraint, per axis: what the SLA ALLOWS per hour, and what
 * the plant can ACTUALLY DO per hour (direction-aware: cooling vs warming, dehum
 * vs humidify). Moisture equipment only works on the ACTIVE component of the RH
 * change — the deviation from the passive moisture-line RH; the passive part
 * rides the temperature change for free. The answer is the slowest constraint.
 *
 * Extracted from v1's `rampPlanFor` with one structural change: v1 read
 * `state.slaProfiles`, `state.hall`, `state.pressure` and the four state-point
 * fields straight off the global — which is why it could not be unit-tested.
 * Everything now arrives as arguments.
 */

import { fToC, ft3ToM3, kgToLb } from './units.js';
import { humidityRatio, specificVolume } from './psychro.js';

/**
 * @typedef {object} HallPlant
 * @property {number} [effPct]         delivered fraction of nameplate, %
 * @property {number} [derateCoolPct]  today's cooling capacity, %
 * @property {number} [derateWarmPct]  today's warming capacity, %
 * @property {number} [derateDehumPct] today's dehumidification capacity, %
 * @property {number} [derateHumPct]   today's humidification capacity, %
 * @property {number|null} [rateCoolF]   nameplate cooling °F/hr
 * @property {number|null} [rateWarmF]   nameplate warming °F/hr
 * @property {number|null} [rateDehumLb] nameplate dehumidification lb/hr
 * @property {number|null} [rateHumLb]   nameplate humidification lb/hr
 * @property {number|null} [hallVolFt3]  hall air volume ft³
 */

/**
 * @typedef {object} PlanInputs
 * @property {{maxDtHr?:(number|null), maxDrhHr?:(number|null)}} sla  active SLA ramp limits (°F/hr, %RH/hr)
 * @property {HallPlant} hall active hall profile (rates, derates, effPct, volume)
 * @property {number} aTempF current dry bulb °F
 * @property {number} aRH    current RH %
 * @property {number} bTempF target dry bulb °F
 * @property {number} bRH    target RH %
 * @property {number} p      site pressure kPa
 */

/**
 * @typedef {object} RampPlan
 * @property {number} hours    slowest-constraint duration (0 = instant)
 * @property {string} binding  which constraint binds
 * @property {{rate:number,label:string}|null} tempCap
 * @property {{rate:number,label:string,waterLb:number}|null} moistCap
 * @property {boolean} needsVol  moisture rate entered but hall volume missing
 */

/**
 * Plan a Current→Target move.
 * @param {PlanInputs} inputs
 * @param {{nameplate?: boolean}} [opts]  nameplate=true skips the efficiency
 *   factor (derates still apply) — used to back out IMPLIED efficiency from
 *   logged predicted-vs-actual runs.
 * @returns {RampPlan}
 */
export function rampPlanFor(inputs, opts) {
  const { sla, hall, aTempF, aRH, bTempF, bRH, p } = inputs;
  const dT = bTempF - aTempF;
  const dRH = bRH - aRH;

  // ── Real-world factors ────────────────────────────────────────────────────
  // Every plant rate is scaled by efficiency × current-capacity derate:
  //   efficiency (effPct): the predicted fraction of nameplate the hall actually
  //     delivers (mixing, stratification, control lag) — default 85 %.
  //   derate*Pct: today's capacity — chillers offline, crusty evap media, etc.
  const eff = opts && opts.nameplate ? 1 : (hall.effPct ?? 100) / 100;
  const der = (pct) => (pct == null ? 100 : pct) / 100;
  const fxCool = eff * der(hall.derateCoolPct),
    fxWarm = eff * der(hall.derateWarmPct);
  const fxDehum = eff * der(hall.derateDehumPct),
    fxHum = eff * der(hall.derateHumPct);

  const parts = [];
  const add = (h, label) => {
    if (h > 0.0001) parts.push({ h, label });
  };

  if (sla.maxDtHr) add(Math.abs(dT) / sla.maxDtHr, 'SLA temp limit');
  if (sla.maxDrhHr) add(Math.abs(dRH) / sla.maxDrhHr, 'SLA humidity limit');

  const tempRate = (dT < 0 ? hall.rateCoolF : hall.rateWarmF) * (dT < 0 ? fxCool : fxWarm);
  const tempCapInfo =
    Math.abs(dT) >= 0.05 && tempRate > 0
      ? { rate: tempRate, label: dT < 0 ? 'Cool' : 'Warm' }
      : null;
  if (tempCapInfo) add(Math.abs(dT) / tempRate, dT < 0 ? 'cooling capacity' : 'warming capacity');

  // ── Moisture: rigorous mass balance ───────────────────────────────────────
  // Air is the hall's only significant moisture reservoir, so this is
  // first-principles: the ACTIVE moisture work is the change in humidity ratio
  // ΔW away from the passive line (passive W is constant — it rides the
  // temperature move for free).
  //   dry-air mass  m_da = V_hall / v(T_a, W₀, p)      [ASHRAE Eq. 26]
  //   water mass    m_w  = m_da · |ΔW|                  [kg]
  //   time          t    = m_w / (capacity lb/hr → kg/hr)
  const W0 = humidityRatio(fToC(aTempF), aRH, p);
  const Wb = humidityRatio(fToC(bTempF), bRH, p);
  const dW = Wb - W0; // + = add water, − = remove
  const moistLb = dW < 0 ? hall.rateDehumLb * fxDehum : hall.rateHumLb * fxHum;

  let moistCapInfo = null,
    needsVol = false;
  if (Math.abs(dW) >= 0.00005) {
    // ≥ 0.05 g/kg of active work
    if (moistLb > 0) {
      if (hall.hallVolFt3 > 0) {
        const v_a = specificVolume(fToC(aTempF), W0, p); // m³/kg dry air
        const m_da = ft3ToM3(hall.hallVolFt3) / v_a; // kg dry air in hall
        const waterLb = kgToLb(m_da * Math.abs(dW));
        moistCapInfo = { rate: moistLb, label: dW < 0 ? 'Dehum' : 'Humidify', waterLb };
        add(waterLb / moistLb, dW < 0 ? 'dehumidify capacity' : 'humidify capacity');
      } else {
        needsVol = true; // rate entered but no volume — can't do the mass balance
      }
    }
  }

  if (!parts.length)
    return { hours: 0, binding: '', tempCap: tempCapInfo, moistCap: moistCapInfo, needsVol };
  parts.sort((a, b) => b.h - a.h);
  return {
    hours: parts[0].h,
    binding: parts[0].label,
    tempCap: tempCapInfo,
    moistCap: moistCapInfo,
    needsVol,
  };
}

/** Friendly duration: hours → "instant" / "45 min" / "1 h 4 min". */
export function fmtHrs(h) {
  if (h <= 0) return 'instant';
  const mins = h * 60;
  if (mins < 60) return `${Math.ceil(mins)} min`;
  const hh = Math.floor(h),
    mm = Math.round((h - hh) * 60);
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}
