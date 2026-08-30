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
  dewPointFrom,
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
 * A tiny memo over the last few derivations.
 *
 * "Once" in the docblock above was aspirational: a single `update()` derives
 * Current and Target in `buildTable`, then derives the SAME two points again in
 * `updateControlReadout`, and the export header derives them a third time when
 * it runs. Four wet-bulb bisections per keystroke where two would do.
 *
 * Memoising is safe because `deriveState` is pure — it reads nothing but its
 * three arguments and the frozen physics core. Four slots covers Current and
 * Target with room for the chart's hover point without ever growing; the
 * result object is shared, so callers must treat it as read-only, which every
 * one of them already does (they spread it into their own shape).
 */
const MEMO_SLOTS = 4;
/** @type {{tc:number, rh:number, p:number, out:DerivedState}[]} */
let memo = [];

/** Drop the memo. Only needed if the physics core itself could change. */
export function clearDeriveMemo() {
  memo = [];
}

/**
 * Derive every displayed property of a state point, once.
 *
 * @param {number} tc dry bulb °C
 * @param {number} rh relative humidity %
 * @param {number} p total pressure kPa
 * @returns {DerivedState}
 */
export function deriveState(tc, rh, p) {
  for (let i = 0; i < memo.length; i++) {
    const m = memo[i];
    if (m.tc === tc && m.rh === rh && m.p === p) return m.out;
  }
  const out = deriveStateUncached(tc, rh, p);
  memo.unshift({ tc, rh, p, out });
  if (memo.length > MEMO_SLOTS) memo.length = MEMO_SLOTS;
  return out;
}

/** The real derivation, unmemoised. Exported for tests that must not hit the memo. */
export function deriveStateUncached(tc, rh, p) {
  const pws = satPressure(tc);
  const pw = vaporPressure(tc, rh);
  const W = humidityRatioFromPw(pw, p, tc);
  // dewPointFrom, not dewPoint(pw). The two differ by up to 2.3e-2 °C because
  // the cheap form inverts the saturation curve alone and drops the
  // enhancement factor, which does not cancel here — it would be evaluated at
  // the dry bulb on one side and the dew point on the other. The accurate
  // solver has existed and been validated at 3.8e-4 °C for a long time; this
  // call site was simply never switched over, so every dew point the app
  // DISPLAYED was 60x worse than the figure the docs quote.
  const tdpC = dewPointFrom(tc, rh, p);
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
