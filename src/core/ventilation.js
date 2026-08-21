/**
 * Steady-state ventilation moisture load — the hold-it-there water, as opposed
 * to the get-it-there water the planner computes.
 *
 * Once a hall is at its setpoint, the box is full: nothing inside makes or
 * destroys water (IT load is dry), so at steady state the humidifiers replace
 * exactly what the outdoor-air change carries away,
 *
 *     water = m_dryair(DOAS) x (W_room - W_outdoor)
 *
 * The worst possible weather is the DRIEST, not the hottest — and because
 * outdoor moisture content collapses toward zero as the dew point falls, the
 * load saturates at a physical CEILING of m x W_room. That ceiling is what a
 * missing design dew point falls back to: no guessed weather record can
 * exceed it.
 *
 * Same property core as everything else — Eq. 20 with the fitted enhancement
 * factor at the hall's own pressure; a sub-freezing design dew point lands on
 * the over-ice saturation branch automatically.
 */

import { humidityRatio, saturationHumidityRatio, rhFromW, specificVolume } from './psychro.js';
import { fToC } from './units.js';

const LB_PER_KG = 2.2046226218;
const FT3_PER_M3 = 35.314666721;
const LB_PER_GAL = 8.3454; // US gallon of water at ~60 F

/**
 * @param {object} a
 * @param {number} a.cfm         DOAS outdoor-air flow, ft^3/min (at room state)
 * @param {number} a.roomTempF   held dry bulb, degF
 * @param {number} a.roomRH      held RH, %
 * @param {number|null} a.outdoorDpF  design outdoor dew point, degF; null =
 *   the ceiling (perfectly dry outdoor air)
 * @param {number} a.pressureKpa site pressure
 * @returns {{lbPerHr:number, galPerDay:number, dryAirLbHr:number,
 *            wRoomG:number, wOaG:number, settleRH:number}|null}
 *   null when the inputs cannot describe a load (no flow, or outdoor air
 *   WETTER than the room — then the humidifiers are off and the answer is a
 *   dehumidification question this module does not pretend to answer)
 */
export function ventilationWater({ cfm, roomTempF, roomRH, outdoorDpF, pressureKpa }) {
  if (!(cfm > 0)) return null;
  const tc = fToC(roomTempF);
  const wRoom = humidityRatio(tc, roomRH, pressureKpa);           // kg/kg
  const wOa = outdoorDpF == null
    ? 0
    : saturationHumidityRatio(fToC(outdoorDpF), pressureKpa);     // saturated AT the dew point
  if (!(wRoom > wOa)) return null;

  // Dry-air mass flow: the CFM is measured as delivered air near room state,
  // so the room-state specific volume (per kg of DRY air) converts it.
  const vM3kg = specificVolume(tc, wRoom, pressureKpa);
  const dryAirLbHr = (cfm * 60 / FT3_PER_M3 / vM3kg) * LB_PER_KG;

  const lbPerHr = dryAirLbHr * (wRoom - wOa);
  return {
    lbPerHr,
    galPerDay: lbPerHr * 24 / LB_PER_GAL,
    dryAirLbHr,
    wRoomG: wRoom * 1000,
    wOaG: wOa * 1000,
    // Where the room would drift with the humidifiers OFF: outdoor moisture
    // at room temperature. The number that says whether they are optional.
    settleRH: rhFromW(tc, wOa, pressureKpa),
  };
}
