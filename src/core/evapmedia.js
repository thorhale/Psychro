/**
 * Wetted-media (evaporative) humidifier output — and why it fades.
 *
 * A nameplate lb/hr is a fiction for evaporative media: the same unit puts out
 * wildly different amounts of water depending on how thirsty the air entering
 * it is. Air at 68 °F / 45 % RH can absorb roughly a third of what the same
 * airflow absorbs at 75 °F / 20 %, and no fixed rating captures that. This
 * module computes the real thing from the air condition the app already knows.
 *
 * The physics is standard and pressure-aware, using the same core the rest of
 * the app runs on:
 *
 *   Evaporation is ADIABATIC — the air gives up sensible heat to vaporise the
 *   water, so it cools along a line of (very nearly) constant wet bulb. The
 *   theoretical limit is air leaving fully saturated AT that wet bulb:
 *
 *       W_max = W_sat(T_wb, p)
 *
 *   Real media never reaches it. The fraction achieved is the media's
 *   SATURATION EFFECTIVENESS, ε:
 *
 *       W_out = W_in + ε · (W_max − W_in)
 *
 *   and the water actually evaporated is that moisture gain carried by the
 *   mass of dry air passing through:
 *
 *       ṁ_water = ṁ_da · (W_out − W_in) = (V̇ / v) · ε · (W_max − W_in)
 *
 * ε is a property of the MEDIA, not of this app: depth, geometry, wetting, and
 * face velocity all set it, and every manufacturer publishes their own figure
 * (commonly ~65–95 % for clean media, falling as face velocity rises). Nothing
 * here hard-codes a value or a curve — ε is supplied by the operator from
 * their own equipment's data.
 *
 * WHY IT MATTERS OPERATIONALLY: dissolved minerals left behind by evaporation
 * build up on the media, blocking wetted surface and channelling airflow past
 * it. That is a direct attack on ε, and it is the mechanism by which a
 * humidifier quietly stops keeping up months before anyone replaces the media.
 * Tracking ε over time turns "the humidifier seems weak" into a number.
 */

import { humidityRatio, specificVolume, wetBulb } from './psychro.js';
import { fToC, cfmToM3s } from './units.js';

/** kg/s → lb/hr. */
const KGS_TO_LBHR = 2.20462262 * 3600;

/**
 * Evaporative-media humidifier output at a specific entering air condition.
 *
 * @param {object} p
 * @param {number} p.cfm        airflow ACROSS THE MEDIA, ft³/min (not
 *   necessarily the hall's total supply airflow — only the air that passes
 *   through the humidifier evaporates water)
 * @param {number} p.tempF      entering dry bulb, °F
 * @param {number} p.rh         entering relative humidity, %
 * @param {number} p.effPct     media saturation effectiveness, % (1–100) —
 *   from the equipment's own data, reduced as the media fouls
 * @param {number} p.pressure   site pressure, kPa
 * @returns {{lbPerHr:number, wIn:number, wMax:number, wOut:number,
 *            twbF:number, leavingTempF:number, gainG:number}|null}
 *   null when the inputs cannot produce an answer. `gainG` is the moisture
 *   pickup in g/kg — the quantity the effectiveness actually scales.
 */
export function evapMediaOutput({ cfm, tempF, rh, effPct, pressure }) {
  if (!(cfm > 0) || !(effPct > 0) || !isFinite(tempF) || !isFinite(rh) || !(pressure > 0)) {
    return null;
  }
  const eps = Math.min(1, effPct / 100);
  const tc = fToC(tempF);
  const wIn = humidityRatio(tc, Math.min(100, Math.max(0, rh)), pressure); // kg/kg
  const twbC = wetBulb(tc, Math.min(100, Math.max(0, rh)), pressure);
  if (twbC == null || !isFinite(twbC)) return null;

  // The adiabatic limit: saturated at the entering air's own wet bulb.
  const wMax = humidityRatio(twbC, 100, pressure);
  const gain = Math.max(0, (wMax - wIn) * eps); // kg/kg actually picked up
  const wOut = wIn + gain;

  const mDaPerS = cfmToM3s(cfm) / specificVolume(tc, wIn, pressure); // kg dry air/s
  return {
    lbPerHr: mDaPerS * gain * KGS_TO_LBHR,
    wIn,
    wMax,
    wOut,
    twbF: (twbC * 9) / 5 + 32,
    // Adiabatic: the air leaves cooler, approaching its wet bulb by the same
    // effectiveness. Worth surfacing — an evaporative humidifier is also a
    // cooling load the plan should not be surprised by.
    leavingTempF: tempF - (tempF - ((twbC * 9) / 5 + 32)) * eps,
    gainG: gain * 1000,
  };
}

/**
 * Back out the effectiveness a humidifier is ACTUALLY achieving from a
 * measured output — the honest way to discover fouling.
 *
 * Measure the water consumed over a known period (a meter, or a tank drop) at
 * a known entering condition and airflow, and this returns the ε that
 * produces it. Compare against the clean figure to see what the scale has
 * taken: 90 % when new and 62 % today is a 30 % capacity loss, quantified.
 *
 * @param {object} p
 * @param {number} p.cfm       airflow across the media, ft³/min
 * @param {number} p.tempF     entering dry bulb, °F
 * @param {number} p.rh        entering relative humidity, %
 * @param {number} p.lbPerHr   measured water evaporated, lb/hr
 * @param {number} p.pressure  site pressure, kPa
 * @returns {number|null} effectiveness in %, or null when it cannot be solved
 */
export function effectivenessFromOutput({ cfm, tempF, rh, lbPerHr, pressure }) {
  if (!(cfm > 0) || !(lbPerHr >= 0) || !isFinite(tempF) || !isFinite(rh) || !(pressure > 0)) {
    return null;
  }
  // Output is exactly linear in ε, so one evaluation at 100 % scales.
  const atFull = evapMediaOutput({ cfm, tempF, rh, effPct: 100, pressure });
  if (!atFull || !(atFull.lbPerHr > 0)) return null;
  return (lbPerHr / atFull.lbPerHr) * 100;
}
