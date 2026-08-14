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
import { humidityRatioG, saturationHumidityRatio, dewPointFrom, P_STD } from './psychro.js';

export const ASHRAE_ENVELOPES = {
  Rec: {
    label: 'Rec',
    color: '#ffffff',
    dash: true,
    lw: 1.4,
    tMin: 18,
    tMax: 27,
    // 8 %, not 0 %. The recommended low-moisture limit in TC 9.9 is "−9 °C DP
    // AND 8 % RH" — both, and the binding one wins. With 0 % here the lower
    // edge was the dew-point line alone, which draws a recommended envelope
    // very slightly LARGER than the standard's near the warm end where the
    // two lines cross (they nearly coincide at 27 °C, and the RH line takes
    // over at reduced pressure). Every preset in the app already used 8;
    // this table was the one place that disagreed with it.
    rhMin: 8,
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
  // A dew-point cap of X is exactly "W no greater than saturation at X", so the
  // edge IS the saturation humidity ratio at the cap — a horizontal line, and
  // the same quantity `dewPointFrom` inverts. Writing it any other way (this
  // used to evaluate Eq. 20 with the enhancement factor taken at the DRY BULB
  // rather than at the cap) makes the drawn boundary and the graded verdict two
  // slightly different curves.
  const wDP = env.dpMax != null ? saturationHumidityRatio(env.dpMax, p) * 1000 : Infinity;
  return Math.min(wRH, wDP);
}

/**
 * W (g/kg) on the LOWER moisture boundary:
 * max of the RH-min curve and the dew-point-min line.
 */
export function lowerW(tc, env, p) {
  const wRH = humidityRatioG(tc, env.rhMin, p);
  const wDP = env.dpMin != null ? saturationHumidityRatio(env.dpMin, p) * 1000 : 0;
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
 *
 * Classified with the SAME `upperW`/`lowerW` boundary engine that draws the
 * polygons, at site pressure. An earlier version used fixed g/kg caps
 * (11/15/18/21) transcribed from the sea-level chart; at altitude those
 * disagreed with the plotted envelope, so a point could sit visibly inside
 * the A1 polygon while the badge said A2. The polygon is the authority.
 */
export function ashraeZone(tc, rh, p) {
  const W = humidityRatioG(tc, rh, p);
  if (!isFinite(W)) return 'Out';
  for (const id of ['A1', 'A2', 'A3', 'A4']) {
    const env = ASHRAE_ENVELOPES[id];
    if (
      tc >= env.tMin &&
      tc <= env.tMax &&
      W <= upperW(tc, env, p) + 1e-9 &&
      W >= lowerW(tc, env, p) - 1e-9
    )
      return id;
  }
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
 * `detail` names the bound in words for tooltips and the accessible
 * description. The violated bound itself comes back as DATA (`kind`, `bound`,
 * `unit`) rather than a pre-baked string: bounds are stored in °F, but the
 * operator may be reading in °C, so formatting belongs to the display layer.
 * An earlier version returned `reason: 'T < 50°F'` and that string surfaced
 * verbatim in °C mode. Checks run in the order an engineer would read them:
 * temperature, humidity, then the dew-point cap.
 *
 * @param {{tMinF:number,tMaxF:number,rhMin:number,rhMax:number,dpMaxF:(number|null|string)}} profile
 * The dew-point check needs the hall's PRESSURE: a dew point is a property of
 * the air, and the same temperature and humidity dew out at a different
 * temperature in Denver than in Goodyear. The temperature and RH bounds are
 * pure contract terms and remain pressure-free, so a profile only becomes
 * pressure-sensitive once it carries a dew-point cap.
 *
 * @param {number} tempF dry bulb °F
 * @param {number} rh relative humidity %
 * @param {number} [p] site pressure kPa; the standard atmosphere if omitted
 * @returns {{ok: boolean, detail: string,
 *            kind: ('tMin'|'tMax'|'rhMin'|'rhMax'|'dpMax'|null),
 *            bound: (number|null), unit: ('F'|'%'|null)}}
 */
export function checkSLA(profile, tempF, rh, p = P_STD) {
  const fail = (kind, bound, unit, detail) => ({ ok: false, kind, bound, unit, detail });
  if (tempF < profile.tMinF) return fail('tMin', profile.tMinF, 'F', 'below temp min');
  if (tempF > profile.tMaxF) return fail('tMax', profile.tMaxF, 'F', 'above temp max');
  if (rh < profile.rhMin) return fail('rhMin', profile.rhMin, '%', 'below RH min');
  if (rh > profile.rhMax) return fail('rhMax', profile.rhMax, '%', 'above RH max');
  if (profile.dpMaxF != null && profile.dpMaxF !== '') {
    const dp = dewPointFrom(fToC(tempF), rh, p);
    if (dp !== null && cToF(dp) > Number(profile.dpMaxF))
      return fail('dpMax', Number(profile.dpMaxF), 'F', 'above dew point cap');
  }
  return { ok: true, kind: null, bound: null, unit: null, detail: 'within SLA' };
}

/**
 * Does a measured rate of change satisfy the SLA's ramp limits?
 *
 * The profile stores `maxDtHr` (°F/hr) and `maxDrhHr` (%RH/hr); until this
 * existed they were printed on placards as DO-NOT-CROSS numbers but never
 * actually checked against anything. Same data-not-string return style as
 * `checkSLA`; a null/absent limit disables that check.
 *
 * @param {{maxDtHr?:(number|null), maxDrhHr?:(number|null)}} profile
 * @param {number|null} dtPerHr   measured |ΔT| rate, °F/hr
 * @param {number|null} drhPerHr  measured |ΔRH| rate, %RH/hr
 * @returns {{ok:boolean, detail:string,
 *            kind:('dtHr'|'drhHr'|null), bound:(number|null),
 *            actual:(number|null), unit:('F/hr'|'%/hr'|null)}}
 */
export function checkRamp(profile, dtPerHr, drhPerHr) {
  if (profile.maxDtHr != null && dtPerHr != null && Math.abs(dtPerHr) > profile.maxDtHr)
    return {
      ok: false, kind: 'dtHr', bound: profile.maxDtHr, actual: Math.abs(dtPerHr),
      unit: 'F/hr', detail: 'temperature ramp too fast',
    };
  if (profile.maxDrhHr != null && drhPerHr != null && Math.abs(drhPerHr) > profile.maxDrhHr)
    return {
      ok: false, kind: 'drhHr', bound: profile.maxDrhHr, actual: Math.abs(drhPerHr),
      unit: '%/hr', detail: 'humidity ramp too fast',
    };
  return { ok: true, kind: null, bound: null, actual: null, unit: null, detail: 'within ramp limits' };
}
