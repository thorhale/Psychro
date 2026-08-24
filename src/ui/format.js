/**
 * Display formatting — the layer between canonical values and what an
 * operator reads.
 *
 * Everything is STORED in °F (the unit people type in) and every ASHRAE
 * calculation is done in °C. Neither is necessarily what is on screen:
 * `state.tempUnit` picks that, and it can change under a value that never
 * moved. These helpers are the only place that conversion happens, so a panel
 * cannot accidentally print a stored °F into a °C interface.
 *
 * Its own module rather than main.js's, because every panel needs it and a
 * panel that reaches back into the entry point for its formatting creates the
 * import cycle that makes panels impossible to extract.
 */

import { TEMP_UNITS, deltaFromF, deltaLabelFor } from '../core/units.js';
import { state } from '../app/state.js';

/** The active display unit's conversion table. */
export function tU() {
  return TEMP_UNITS[unit()];
}

/** The active display unit, defaulted. @returns {'F'|'C'|'K'} */
const unit = () => state.tempUnit || 'F';


/** °F → the display unit, as a number. */
export const dispT = (f) => tU().fromF(f);

/**
 * °F → the display unit at a tenth, with a trailing ".0" trimmed.
 *
 * A tenth is the granularity operators actually work at: setpoints get moved
 * half a degree at a time, and an SLA bound of 18 °C is 64.4 °F, not 64.
 * This used to round to whole degrees, which made the app quietly disagree
 * with itself — you could type 72.5, and the next control you touched wrote
 * 73 back into the box while every calculation kept using 72.5. Worse, the
 * verdict chip read "T below 64 °F" against a bound that was really 64.4.
 *
 * Trimming the trailing zero is what keeps whole-degree work looking like
 * whole-degree work: 73 renders "73", not "73.0".
 */
export const dispTs = (f) => (Math.round(dispT(f) * 10) / 10).toString();

/**
 * Any plain number for reading: a tenth, trailing ".0" trimmed.
 *
 * Relative humidity, ramp limits, temperature deltas already converted —
 * anything that carries no unit ambiguity of its own but still deserves the
 * granularity operators work at. Same reasoning as dispTs: a hall held at
 * 45.5 % must not read 46 % on the placard someone works from.
 */
export const disp1 = (v) => (Math.round(v * 10) / 10).toString();

/** The active unit's label: '°F', '°C' or 'K'. */
export const tLabel = () => tU().label;

/**
 * °F → the display unit at one decimal.
 *
 * Sensor work and the trainer both need a tenth of a degree: a validation
 * verdict turns on it, and rounding a training run to whole degrees would
 * hide the drift the drill is about. Now identical to `dispTs` — the rest of
 * the app came to it rather than the other way round — but kept as its own
 * name because at these call sites the tenth is a stated requirement, not a
 * display preference that could later be dialled back.
 */
export const dispT1 = dispTs;

/**
 * Convert a temperature DIFFERENCE. K and °C degrees are the same size, so a
 * delta converts differently from an absolute temperature — printing a 10 °F
 * rise as "-12 °C" is the bug this exists to prevent.
 */
export const dispDeltaT = (dF) => deltaFromF(dF, unit());

/** Label for a temperature DIFFERENCE in the active unit. */
export const deltaLabel = () => deltaLabelFor(unit());

/**
 * Format a checkSLA verdict's violated bound in the ACTIVE display unit.
 *
 * The core returns the bound as data (canonical °F / %) rather than a
 * sentence, precisely so the sentence an operator reads can follow their unit
 * toggle instead of being baked in °F at the point of comparison.
 *
 * @param {{ok:boolean, kind?:string|null, bound?:number, detail?:string}} chk
 */
export function fmtSlaReason(chk) {
  if (chk.ok) return 'within SLA';
  const t = (f) => `${dispTs(f)} ${tLabel()}`;
  switch (chk.kind) {
    case 'tMin': return `T below ${t(chk.bound)}`;
    case 'tMax': return `T above ${t(chk.bound)}`;
    case 'rhMin': return `RH below ${chk.bound}%`;
    case 'rhMax': return `RH above ${chk.bound}%`;
    case 'dpMax': return `dew point above ${t(chk.bound)}`;
    default: return chk.detail || 'out of SLA';
  }
}
