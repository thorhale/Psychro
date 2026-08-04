/**
 * Hall-level physics shared by more than one surface.
 *
 * Small on purpose: it holds the quantities that two independent panels both
 * need and must never compute differently from each other.
 */

import { specificVolume, humidityRatio } from '../core/psychro.js';
import { fToC, ft3ToM3, lbToKg } from '../core/units.js';
import { state } from './state.js';
import { inp } from '../ui/dom.js';

/** Specific heat of equipment steel, kJ/kg·K — the usual planning figure. */
const C_EQUIPMENT = 0.5;

/** The hall's CURRENT moisture content, kg water / kg dry air. */
export const currentW = () =>
  humidityRatio(fToC(state.aTemp), state.aRH, state.pressure);

/**
 * The hall's thermal capacitance, kJ/K — what a kilowatt has to heat or cool.
 *
 * Shared because both the rate calculator and the equipment inventory turn kW
 * into °F/hr, and the two must never disagree about the mass they are acting
 * on. It reads the optional equipment-mass field directly: that input is the
 * only place the figure exists, and duplicating it into state purely to avoid
 * a DOM read would be two sources of truth for one number.
 *
 * @returns {{c:number, airOnly:boolean}|null} null without a hall volume
 */
export function thermalC() {
  if (!(state.hall.hallVolFt3 > 0)) return null;
  const W0 = currentW();
  const v = specificVolume(fToC(state.aTemp), W0, state.pressure);
  const mda = ft3ToM3(state.hall.hallVolFt3) / v;
  const cAir = mda * (1.006 + 1.86 * W0);
  const massLb = parseFloat(
    /** @type {HTMLInputElement|null} */ (inp('rc-mass'))?.value ?? '',
  );
  const cEq = massLb > 0 ? lbToKg(massLb) * C_EQUIPMENT : 0;
  return { c: cAir + cEq, airOnly: !(massLb > 0) };
}
