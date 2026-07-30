/**
 * ASHRAE TC 9.9 thermal-guideline envelopes (5th ed. allowable limits) and the
 * polygon generator that traces them — plus customer-SLA polygons, which reuse
 * the same boundary engine.
 *
 * Each envelope is defined by its REAL boundaries, not pre-plotted corners: at
 * any dry bulb the active moisture boundary is whichever constraint binds first
 * (RH curve vs dew-point line), and the polygons are pressure-aware, which is why
 * every function takes total pressure explicitly.
 *
 *   tMin/tMax  dry-bulb °C
 *   rhMin/rhMax  %
 *   dpMin/dpMax  dew point °C (null = no cap)
 */

import { fToC, cToF } from './units.js';
import { humidityRatioG, humidityRatioFromPw, satPressure, dewPointFrom } from './psychro.js';

/**
 * g/kg from an explicit vapour pressure with the enhancement factor taken at the
 * dry bulb — the form dew-point caps need (constant-W lines).
 */
function humidityRatioGFromPwAt(tc, pw, p) {
  return humidityRatioFromPw(pw, p, tc) * 1000;
}

export const ASHRAE_ENVELOPES = {
  Rec: {
    label: 'Rec',
    color: '#ffffff',
    dash: true,
    lw: 1.4,
    tMin: 18,
    tMax: 27,
    rhMin: 0,
    rhMax: 60,
    dpMin: -9,
    dpMax: 15,
  },
  A1: {
    label: 'A1',
    color: '#3fb950',
    dash: false,
    lw: 2.0,
    tMin: 15,
    tMax: 32,
    rhMin: 8,
    rhMax: 80,
    dpMin: -12,
    dpMax: 17,
  },
  A2: {
    label: 'A2',
    color: '#3b9eff',
    dash: false,
    lw: 1.5,
    tMin: 10,
    tMax: 35,
    rhMin: 8,
    rhMax: 80,
    dpMin: -12,
    dpMax: 21,
  },
  A3: {
    label: 'A3',
    color: '#f0a500',
    dash: false,
    lw: 1.3,
    tMin: 5,
    tMax: 40,
    rhMin: 8,
    rhMax: 85,
    dpMin: -12,
    dpMax: 24,
  },
  A4: {
    label: 'A4',
    color: '#f85149',
    dash: false,
    lw: 1.2,
    tMin: 5,
    tMax: 45,
    rhMin: 8,
    rhMax: 90,
    dpMin: -12,
    dpMax: 24,
  },
};

/**
 * W (g/kg) at a given dry bulb on the UPPER moisture boundary:
 * min of the RH-max curve and the dew-point-max horizontal line.
 */
export function upperW(tc, env, p) {
  const wRH = humidityRatioG(tc, env.rhMax, p);
  const wDP =
    env.dpMax != null
      ? // A dew-point cap is a constant-W line; evaluate Eq. 20 with the vapour
        // pressure saturated at the cap. Enhancement factor at the dry bulb.
        humidityRatioGFromPwAt(tc, satPressure(env.dpMax), p)
      : Infinity;
  return Math.min(wRH, wDP);
}

/**
 * W (g/kg) on the LOWER moisture boundary:
 * max of the RH-min curve and the dew-point-min line.
 */
export function lowerW(tc, env, p) {
  const wRH = humidityRatioG(tc, env.rhMin, p);
  const wDP = env.dpMin != null ? humidityRatioGFromPwAt(tc, satPressure(env.dpMin), p) : 0;
  return Math.max(wRH, wDP, 0);
}

/**
 * Trace an envelope polygon as [Tdb °C, W g/kg] points, pressure-aware.
 * Walks the bottom edge left→right, then the top edge right→left.
 */
export function envelopePolygon(env, p) {
  const pts = [];
  const step = 0.5;
  for (let t = env.tMin; t <= env.tMax + 1e-6; t += step) {
    pts.push([t, lowerW(Math.min(t, env.tMax), env, p)]);
  }
  for (let t = env.tMax; t >= env.tMin - 1e-6; t -= step) {
    pts.push([t, upperW(Math.max(t, env.tMin), env, p)]);
  }
  return pts;
}

/**
 * Customer-SLA polygon — same boundary engine, driven by a profile object.
 * @param {{tMinF:number, tMaxF:number, rhMin:number, rhMax:number, dpMaxF:(number|null|string)}} profile
 */
export function slaPolygon(profile, p) {
  const env = {
    tMin: fToC(profile.tMinF),
    tMax: fToC(profile.tMaxF),
    rhMin: profile.rhMin,
    rhMax: profile.rhMax,
    dpMin: null,
    dpMax:
      profile.dpMaxF != null && profile.dpMaxF !== '' ? fToC(Number(profile.dpMaxF)) : null,
  };
  return envelopePolygon(env, p);
}

/**
 * Which ASHRAE class a state point falls in — tightest first.
 * Returns 'A1' | 'A2' | 'A3' | 'A4' | 'Out'.
 */
export function ashraeZone(tc, rh, p) {
  const W = humidityRatioG(tc, rh, p);
  const dp = dewPointFrom(tc, rh);
  if (dp === null) return 'Out';
  if (tc >= 15 && tc <= 32 && dp <= 17 && W <= 11.0 && rh <= 80) return 'A1';
  if (tc >= 10 && tc <= 35 && dp <= 21 && W <= 15.0 && rh <= 80) return 'A2';
  if (tc >= 5 && tc <= 40 && dp <= 24 && W <= 18.0 && rh <= 80) return 'A3';
  if (tc >= 5 && tc <= 45 && dp <= 24 && W <= 21.0 && rh <= 90) return 'A4';
  return 'Out';
}

/**
 * Does a state point satisfy an SLA profile?
 *
 * This is the single implementation of the contract the whole tool exists to
 * enforce, so it lives in the tested core and carries the operator-facing
 * message with it — a second copy in the UI layer (which is how v1 shipped)
 * is exactly the kind of drift that puts a "✓ in SLA" badge on an
 * out-of-contract point.
 *
 * `reason` is the short badge string (`T < 50°F`); `detail` names the bound in
 * words for tooltips and the accessible description. Checks run in the order an
 * engineer would read them: temperature, humidity, then the dew-point cap.
 *
 * @param {{tMinF:number,tMaxF:number,rhMin:number,rhMax:number,dpMaxF:(number|null|string)}} profile
 * @param {number} tempF dry bulb °F
 * @param {number} rh relative humidity %
 * @returns {{ok: boolean, reason: string, detail: string}}
 */
export function checkSLA(profile, tempF, rh) {
  if (tempF < profile.tMinF)
    return { ok: false, reason: `T < ${profile.tMinF}°F`, detail: 'below temp min' };
  if (tempF > profile.tMaxF)
    return { ok: false, reason: `T > ${profile.tMaxF}°F`, detail: 'above temp max' };
  if (rh < profile.rhMin)
    return { ok: false, reason: `RH < ${profile.rhMin}%`, detail: 'below RH min' };
  if (rh > profile.rhMax)
    return { ok: false, reason: `RH > ${profile.rhMax}%`, detail: 'above RH max' };
  if (profile.dpMaxF != null && profile.dpMaxF !== '') {
    const dp = dewPointFrom(fToC(tempF), rh);
    if (dp !== null && cToF(dp) > Number(profile.dpMaxF))
      return {
        ok: false,
        reason: `DP > ${profile.dpMaxF}°F`,
        detail: 'above dew point cap',
      };
  }
  return { ok: true, reason: 'within SLA', detail: 'within SLA' };
}
