/**
 * The single derivation of a moist-air state point.
 *
 * Every surface that shows numbers for a state — the properties table, the
 * Current→Target readout, the chart hover inspector, the PNG/PDF export header —
 * calls this and reads fields off the result. That is deliberate: it makes
 * cross-surface agreement *structural* rather than something four separate call
 * sites have to keep getting right. v1 assembled its own property set at each
 * site, which is how a table and a tooltip drift apart by a rounding convention
 * nobody notices until an operator does.
 *
 * All properties come from `psychro.js`, validated point-by-point against
 * CoolProp. Nothing is computed here that the core does not already own.
 */

import { fToC, cToF } from './units.js';
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
} from './psychro.js';
import { ashraeZone } from './envelopes.js';

/**
 * @typedef {object} DerivedState
 * @property {number} tc        dry bulb °C
 * @property {number} tempF     dry bulb °F
 * @property {number} rh        relative humidity %
 * @property {number} p         total pressure kPa
 * @property {number} pws       saturation pressure kPa
 * @property {number} pw        partial vapour pressure kPa
 * @property {number} W         humidity ratio kg/kg dry air
 * @property {number} Wg        humidity ratio g/kg dry air
 * @property {number|null} tdpC dew point °C (null when there is no vapour)
 * @property {number|null} tdpF dew point °F
 * @property {number} twbC      wet bulb °C
 * @property {number} twbF      wet bulb °F
 * @property {boolean} twbAmbiguous  wet bulb sits in the near-freezing band where
 *                                   ice-wick and water-wick readings both exist
 * @property {number} h         enthalpy kJ/kg dry air
 * @property {number} v         specific volume m³/kg dry air
 * @property {number} rho       mixture density kg/m³
 * @property {number} absHum    absolute humidity g/m³
 * @property {number} s         entropy kJ/(kg·K)
 * @property {number} mu        degree of saturation (0–1)
 * @property {string} zone      ASHRAE class: A1 | A2 | A3 | A4 | Out
 */

/**
 * Derive every displayed property of a state point, once.
 *
 * @param {number} tc dry bulb °C
 * @param {number} rh relative humidity %
 * @param {number} p total pressure kPa
 * @returns {DerivedState}
 */
export function deriveState(tc, rh, p) {
  const pws = satPressure(tc);
  const pw = vaporPressure(tc, rh);
  const W = humidityRatioFromPw(pw, p, tc);
  const tdpC = dewPoint(pw);
  const wb = wetBulbSolve(tc, rh, p);

  return {
    tc,
    tempF: cToF(tc),
    rh,
    p,
    pws,
    pw,
    W,
    Wg: W * 1000,
    tdpC,
    tdpF: tdpC != null ? cToF(tdpC) : null,
    twbC: wb.value,
    twbF: cToF(wb.value),
    twbAmbiguous: wb.ambiguous === true,
    // enthalpy defaults p to sea level; the site pressure must be passed for
    // the real-gas mixing term to be right at altitude.
    h: enthalpy(tc, W, p),
    v: specificVolume(tc, W, p),
    rho: moistAirDensity(tc, rh, p),
    absHum: absHumidity(tc, pw),
    s: entropy(tc, rh, p),
    mu: degreeOfSaturation(tc, rh, p),
    zone: ashraeZone(tc, rh, p),
  };
}

/**
 * Same, for the °F-native side of the app (sliders, SLA profiles, the readout).
 * @param {number} tempF dry bulb °F
 */
export function deriveStateF(tempF, rh, p) {
  return deriveState(fToC(tempF), rh, p);
}
