/**
 * Pure unit conversions. No state, no DOM — safe to import anywhere.
 *
 * The whole app stores temperatures in °F (the unit operators type in) and does
 * every ASHRAE calculation in °C. Display conversion lives in `src/ui/format.js`
 * because it depends on the user's selected unit; only the raw arithmetic is here.
 */

/** @param {number} f @returns {number} */
export const fToC = (f) => ((f - 32) * 5) / 9;

/** @param {number} c @returns {number} */
export const cToF = (c) => (c * 9) / 5 + 32;

/** @param {number} ft @returns {number} metres */
export const ftToM = (ft) => ft * 0.3048;

/** @param {number} m @returns {number} feet */
export const mToFt = (m) => m / 0.3048;

/** Cubic feet → cubic metres. */
export const ft3ToM3 = (ft3) => ft3 * 0.0283168;

/** Pounds → kilograms. */
export const lbToKg = (lb) => lb * 0.45359237;

/** Kilograms → pounds. */
export const kgToLb = (kg) => kg / 0.45359237;

/** kPa → inches of mercury. */
export const kPaToInHg = (kpa) => kpa * 0.2953;

/**
 * Temperature display units. `fromF` converts stored °F to the display unit;
 * `toF` converts typed input back. K and °C share a degree size, so a temperature
 * DELTA converts differently from an absolute temperature — see `deltaFromF`.
 */
export const TEMP_UNITS = {
  F: { label: '°F', fromF: (f) => f, toF: (v) => v, dec: 0 },
  C: { label: '°C', fromF: (f) => ((f - 32) * 5) / 9, toF: (v) => (v * 9) / 5 + 32, dec: 0 },
  K: {
    label: 'K',
    fromF: (f) => ((f - 32) * 5) / 9 + 273.15,
    toF: (v) => ((v - 273.15) * 9) / 5 + 32,
    dec: 0,
  },
};

/**
 * Convert a temperature DIFFERENCE expressed in °F into the given display unit.
 * K and °C degrees are the same size, so both scale by 5/9.
 * @param {number} dF @param {'F'|'C'|'K'} unit
 */
export const deltaFromF = (dF, unit) => (unit === 'F' ? dF : (dF * 5) / 9);

/** Label for a temperature DIFFERENCE in the given unit. */
export const deltaLabelFor = (unit) => (unit === 'F' ? '°F' : unit === 'K' ? 'K' : '°C');
