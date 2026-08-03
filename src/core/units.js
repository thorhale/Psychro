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

/** Cubic feet per minute → cubic metres per second. */
export const cfmToM3s = (cfm) => cfm * 4.71947e-4;

/**
 * Equipment capacity units.
 *
 * These live here rather than beside the inventory because two different parts
 * of the app convert the same schedule figures: the equipment inventory and
 * the rate calculator, which an operator can use without ever listing a unit.
 * They were separate copies of the same numbers, which is a correction waiting
 * to be applied to one of them and not the other.
 */

/** Thermal capacity units → kW. */
export const THERMAL_TO_KW = {
  kw: 1,
  ton: 3.51685, //   ton of refrigeration
  btu: 1 / 3412.14, // BTU/hr
  mbh: 1 / 3.41214, // thousand BTU/hr
};

/** Water-output units → lb/hr. Water ≈ 8.34 lb/gal; a pint is 1/8 gal. */
export const WATER_TO_LBHR = {
  lbhr: 1,
  gph: 8.34,
  gpd: 8.34 / 24,
  pintday: 8.34 / 8 / 24,
};

/**
 * Airflow units → CFM.
 *
 * Fans are environment plant too: a slipping belt, a loading filter or a dead
 * fan in an array all mean less air over the coil and the media, and none of
 * them announce themselves.
 */
export const AIR_TO_CFM = {
  cfm: 1,
  m3h: 0.5885778, //  m³/hr
  cmm: 35.31467, //   m³/min
  lps: 2.118880, //   litres/second
};

/** Convert a thermal capacity to kW; an unknown unit passes through. */
export const toKW = (val, unit) => val * (THERMAL_TO_KW[unit] ?? 1);

/** Convert a water output to lb/hr; an unknown unit passes through. */
export const toLbHr = (val, unit) => val * (WATER_TO_LBHR[unit] ?? 1);

/** Latent heat of vaporization used to turn a latent kW into lb/hr of water. */
export const LATENT_BTU_PER_LB = 1060;

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
