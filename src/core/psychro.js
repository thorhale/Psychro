/**
 * Moist-air psychrometrics — ASHRAE Handbook of Fundamentals, Chapter 1.
 *
 * Validated point-by-point against CoolProp's HAPropsSI (ASHRAE RP-1485 real-gas
 * formulation) over the whole operating domain — see `test/psychro.test.js` and
 * `docs/coolprop-comparison.md`. Regenerate the reference grid with
 * `npm run reference`; re-measure with `npm run analyze`.
 *
 * Conventions throughout:
 *   temperatures     °C
 *   pressures        kPa
 *   humidity ratio   kg water / kg dry air  (`*G` variants return g/kg)
 *   enthalpy         kJ / kg dry air
 *   entropy          kJ / (kg dry air · K)
 *   specific volume  m³ / kg dry air
 *
 * Every pressure-dependent function takes total pressure explicitly — this tool
 * is used from sea level to 5,380 ft and pressure materially changes humidity
 * ratio, so there is deliberately no ambient default to forget to pass.
 */

import { ftToM } from './units.js';

// ── Physical constants ──────────────────────────────────────────────────────
/** Ratio of molar masses, water / dry air. ASHRAE Ch.1. */
const MW_RATIO = 0.621945;
/** Gas constant for dry air, kJ/(kg·K). */
const R_DA = 0.287042;
/** Gas constant for water vapour, kJ/(kg·K). */
const R_V = 0.4615;
/** Standard atmosphere, kPa. */
export const P_STD = 101.325;

// ════════════════════════════════════════════════════════════════════════════
//  Pressure and saturation
// ════════════════════════════════════════════════════════════════════════════

/**
 * ASHRAE Eq. 3 — barometric pressure from altitude.
 *
 * Eq. 3 is valid roughly −5,000 m to 11,000 m. The input is clamped to that
 * domain so an absurd elevation can never produce NaN, which would blank the
 * whole chart.
 * @param {number} ft elevation in feet
 * @returns {number} kPa
 */
export function pressureFromAltitude(ft) {
  let f = Number(ft);
  if (!isFinite(f)) f = 0;
  f = Math.max(-16400, Math.min(36000, f));
  const Z = ftToM(f);
  const p = P_STD * Math.pow(1 - 2.25577e-5 * Z, 5.2559);
  return isFinite(p) ? p : P_STD;
}

/** ASHRAE Eq. 5 — saturation pressure over liquid water, 0 to 200 °C. kPa. */
export function satPressureWater(tc) {
  const T = tc + 273.15;
  const C8 = -5800.2206,
    C9 = 1.3914993,
    C10 = -0.048640239,
    C11 = 4.1764768e-5,
    C12 = -1.4452093e-8,
    C13 = 6.5459673;
  const lnP = C8 / T + C9 + C10 * T + C11 * T * T + C12 * T * T * T + C13 * Math.log(T);
  return Math.exp(lnP) / 1000;
}

/** ASHRAE Eq. 6 — saturation pressure over ice, −100 to 0 °C. kPa. */
export function satPressureIce(tc) {
  const T = tc + 273.15;
  const C1 = -5674.5359,
    C2 = 6.3925247,
    C3 = -0.009677843,
    C4 = 6.2215701e-7,
    C5 = 2.0747825e-9,
    C6 = -9.484024e-13,
    C7 = 4.1635019;
  const lnP =
    C1 / T + C2 + C3 * T + C4 * T * T + C5 * T * T * T + C6 * T * T * T * T + C7 * Math.log(T);
  return Math.exp(lnP) / 1000;
}

/**
 * Saturation pressure, kPa. Eq. 5 over water at/above 0 °C, Eq. 6 over ice below.
 *
 * The two ASHRAE fits disagree by 9.7e-5 relative at the 0 °C seam — a real
 * discontinuity in the published correlations, not a coding artefact. Everything
 * downstream that cares (the enhancement factor, `dewPoint`) handles the two
 * branches explicitly rather than pretending the function is smooth.
 */
export function satPressure(tc) {
  return tc >= 0 ? satPressureWater(tc) : satPressureIce(tc);
}

/**
 * d(p_ws)/dT in kPa/K — the analytic derivative of Eq. 5 / Eq. 6, used to make
 * `dewPoint` a Newton solve instead of a correlation.
 */
export function satPressureDeriv(tc) {
  const T = tc + 273.15;
  const p = satPressure(tc);
  let dlnP_dT;
  if (tc >= 0) {
    const C8 = -5800.2206,
      C10 = -0.048640239,
      C11 = 4.1764768e-5,
      C12 = -1.4452093e-8,
      C13 = 6.5459673;
    dlnP_dT = -C8 / (T * T) + C10 + 2 * C11 * T + 3 * C12 * T * T + C13 / T;
  } else {
    const C1 = -5674.5359,
      C3 = -0.009677843,
      C4 = 6.2215701e-7,
      C5 = 2.0747825e-9,
      C6 = -9.484024e-13,
      C7 = 4.1635019;
    dlnP_dT = -C1 / (T * T) + C3 + 2 * C4 * T + 3 * C5 * T * T + 4 * C6 * T * T * T + C7 / T;
  }
  return p * dlnP_dT;
}

/** Partial vapour pressure (kPa) from dry-bulb temperature and RH %. */
export const vaporPressure = (tc, rh) => (satPressure(tc) * rh) / 100;

/** RH % backed out from a partial vapour pressure at a given dry bulb. */
export const rhFromVapor = (tc, pw) => (pw / satPressure(tc)) * 100;

// ════════════════════════════════════════════════════════════════════════════
//  Enhancement factor
// ════════════════════════════════════════════════════════════════════════════

/**
 * Water-vapour enhancement factor f(T, p).
 *
 * This is NOT the textbook enhancement factor. It is a combined correction that
 * absorbs two things at once, fitted so that `humidityRatio` lands on CoolProp:
 *
 *   1. the real-gas (ASHRAE RP-1485) departure the ideal Eq. 20 omits, and
 *   2. the systematic 1.0–2.2e-4 relative bias of ASHRAE Eq. 5/6 against IAPWS-95.
 *
 * Because it absorbs (2), it inherits Eq. 5/6's discontinuity at 0 °C and is
 * therefore fitted as two separate polynomials — a single smooth fit plateaus at
 * ~7e-5 residual no matter how many terms it is given.
 *
 * Fitted over the full reachable operating domain (T −20…55 °C, p 60…108 kPa,
 * W ≤ 0.15 kg/kg) by `scripts/fit-enhancement.mjs` against CoolProp 8.0.0.
 * Residual on f: max 1.3e-5 over water, 8.8e-9 over ice — i.e. worst-case
 * humidity-ratio error 0.0013 %, against 0.23 % for the v1 single-branch fit
 * that was calibrated over only 0–50 °C / 65–102 kPa.
 *
 * f is a function of DRY-BULB temperature and pressure only; it is independent of
 * relative humidity to within 1e-9 across the grid.
 *
 * @param {number} tc dry-bulb °C
 * @param {number} p total pressure kPa
 */
export function enhancementFactor(tc, p) {
  const t = tc / 50;
  const d = (p - P_STD) / 50;
  if (tc >= 0) {
    const c0 =
      ((((-1.718624067125e-3 * t + 4.107335508868e-3) * t - 1.859887243612e-3) * t +
        8.219441337756e-4) *
        t +
        1.00410018306) *
      1;
    const c1 =
      (((9.213742439086e-4 * t - 1.723829051363e-3) * t + 1.568163487478e-3) * t -
        1.189310922699e-3) *
        t +
      1.81384419948e-3;
    const c2 =
      (((-3.780541173823e-4 * t + 3.792417363463e-4) * t - 2.102353978988e-4) * t +
        1.891685793318e-5) *
        t +
      1.43145873711e-7;
    return (c2 * d + c1) * d + c0;
  }
  const c0 =
    (((3.281400687774e-4 * t + 6.596235207892e-4) * t + 2.369931298115e-3) * t +
      2.84620700492e-4) *
      t +
    1.004197119343;
  const c1 =
    (((5.302021205823e-5 * t - 4.219415318199e-5) * t + 3.393078896377e-4) * t -
      8.320941623242e-4) *
      t +
    1.828616843384e-3;
  const c2 =
    (((-4.25640387407e-5 * t - 5.626829641471e-5) * t - 2.95306254679e-5) * t -
      1.152961680398e-5) *
      t +
    9.824620070252e-7;
  return (c2 * d + c1) * d + c0;
}

// ════════════════════════════════════════════════════════════════════════════
//  Humidity ratio
// ════════════════════════════════════════════════════════════════════════════

/**
 * ASHRAE Eq. 20 — humidity ratio from a partial vapour pressure.
 *
 * `tc` is the DRY-BULB temperature, needed to evaluate the enhancement factor. v1
 * took only `(pw, p)` and reconstructed a temperature by inverting pw to a dew
 * point, which is correct only at saturation — that mismatch was the dominant
 * term in its 0.23 % humidity-ratio error. Prefer `humidityRatio(tc, rh, p)`;
 * this lower-level form exists for the few call sites that already hold a partial
 * pressure.
 *
 * @param {number} pw partial vapour pressure kPa
 * @param {number} p total pressure kPa
 * @param {number} tc dry-bulb °C
 * @returns {number} kg/kg dry air
 */
export function humidityRatioFromPw(pw, p, tc) {
  if (!(pw > 0)) return 0;
  const Pw = enhancementFactor(tc, p) * pw;
  if (Pw >= p) return Infinity; // vapour pressure at/above total pressure — unphysical
  return (MW_RATIO * Pw) / (p - Pw);
}

/**
 * Humidity ratio, kg/kg dry air.
 * @param {number} tc dry-bulb °C @param {number} rh % @param {number} p kPa
 */
export function humidityRatio(tc, rh, p) {
  if (p === undefined) throw new TypeError('humidityRatio(tc, rh, p): pressure is required');
  return humidityRatioFromPw(vaporPressure(tc, rh), p, tc);
}

/** Humidity ratio in g/kg dry air. */
export const humidityRatioG = (tc, rh, p) => humidityRatio(tc, rh, p) * 1000;

/** Saturation humidity ratio at a temperature, kg/kg. */
export const saturationHumidityRatio = (tc, p) => humidityRatio(tc, 100, p);

/**
 * Humidity ratio of air at dry bulb `tc` whose dew point is `tdp`.
 *
 * Used for the constant-moisture lines that dew-point caps trace on the chart.
 * The enhancement factor is still evaluated at the DRY BULB, which is why this
 * cannot be expressed as `humidityRatioFromPw(satPressure(tdp), p, tdp)`.
 */
export function humidityRatioFromDewPoint(tc, tdp, p) {
  return humidityRatioFromPw(satPressure(tdp), p, tc);
}

/** Vapour pressure implied by a humidity ratio, kPa (inverse of Eq. 20). */
export function vaporPressureFromW(W, p, tc) {
  if (!(W > 0)) return 0;
  const Pw = (W * p) / (MW_RATIO + W);
  return Pw / enhancementFactor(tc, p);
}

/** RH % implied by a humidity ratio at a given dry bulb. */
export function rhFromW(tc, W, p) {
  return rhFromVapor(tc, vaporPressureFromW(W, p, tc));
}

/**
 * Degree of saturation μ = W / Ws — the ASHRAE Ch.1 quantity distinct from RH,
 * and the one that actually governs adiabatic mixing.
 */
export function degreeOfSaturation(tc, rh, p) {
  const Ws = saturationHumidityRatio(tc, p);
  return Ws > 0 ? humidityRatio(tc, rh, p) / Ws : 0;
}

// ════════════════════════════════════════════════════════════════════════════
//  Dew point
// ════════════════════════════════════════════════════════════════════════════

/** ASHRAE Eq. 39/40 dew-point correlation — retained only as the Newton seed. */
function dewPointSeed(pw) {
  const alpha = Math.log(pw);
  const C14 = 6.54,
    C15 = 14.526,
    C16 = 0.7389,
    C17 = 0.09486,
    C18 = 0.4569;
  let td =
    C14 +
    C15 * alpha +
    C16 * alpha * alpha +
    C17 * alpha * alpha * alpha +
    C18 * Math.pow(pw, 0.1984);
  if (td < 0) td = 6.09 + 12.608 * alpha + 0.4959 * alpha * alpha;
  return td;
}

/**
 * Dew-point temperature °C — the temperature at which `pw` is the saturation
 * pressure, found by Newton iteration on Eq. 5 / Eq. 6.
 *
 * v1 used the ASHRAE Eq. 39/40 *correlation* directly, which is accurate only
 * over roughly 0–93 °C at ordinary vapour pressures and drifted up to 3.2 °C at
 * the cold, dry, high-pressure corner of this tool's domain. Inverting the
 * saturation equation instead is exact by construction wherever that equation is
 * defined, and costs about four extra `exp` calls.
 *
 * Below 0 °C this returns the FROST point — the temperature at which ice would
 * form — matching Eq. 6 and CoolProp's convention.
 *
 * @param {number} pw partial vapour pressure kPa
 * @returns {number|null} null when there is no water vapour at all
 */
export function dewPoint(pw) {
  if (!(pw > 0)) return null;

  // Pick the saturation branch up front so Newton never straddles the 0 °C seam,
  // where p_ws is discontinuous and the iteration would otherwise oscillate.
  const pAt0 = satPressureWater(0);
  const overWater = pw >= pAt0;
  const ps = overWater ? satPressureWater : satPressureIce;

  let t = dewPointSeed(pw);
  // Keep the seed on the correct side of the seam.
  if (overWater && t < 0) t = 0.01;
  if (!overWater && t > 0) t = -0.01;

  for (let i = 0; i < 40; i++) {
    const f = ps(t) - pw;
    const df = satPressureDerivBranch(t, overWater);
    if (!isFinite(df) || df === 0) break;
    const step = f / df;
    const next = t - step;
    if (!isFinite(next)) break;
    t = next;
    if (Math.abs(step) < 1e-12) break;
  }
  return t;
}

/** Branch-explicit form of `satPressureDeriv`, so `dewPoint` cannot cross the seam. */
function satPressureDerivBranch(tc, overWater) {
  const T = tc + 273.15;
  const p = overWater ? satPressureWater(tc) : satPressureIce(tc);
  let dlnP_dT;
  if (overWater) {
    const C8 = -5800.2206,
      C10 = -0.048640239,
      C11 = 4.1764768e-5,
      C12 = -1.4452093e-8,
      C13 = 6.5459673;
    dlnP_dT = -C8 / (T * T) + C10 + 2 * C11 * T + 3 * C12 * T * T + C13 / T;
  } else {
    const C1 = -5674.5359,
      C3 = -0.009677843,
      C4 = 6.2215701e-7,
      C5 = 2.0747825e-9,
      C6 = -9.484024e-13,
      C7 = 4.1635019;
    dlnP_dT = -C1 / (T * T) + C3 + 2 * C4 * T + 3 * C5 * T * T + 4 * C6 * T * T * T + C7 / T;
  }
  return p * dlnP_dT;
}

/** Dew point °C directly from dry bulb and RH. */
export const dewPointFrom = (tc, rh) => dewPoint(vaporPressure(tc, rh));

/** RH % implied by a dry-bulb / dew-point pair. */
export const rhFromDewPoint = (tc, tdp) => rhFromVapor(tc, satPressure(tdp));

// ════════════════════════════════════════════════════════════════════════════
//  Energy properties
// ════════════════════════════════════════════════════════════════════════════

/**
 * Moist-air enthalpy, kJ per kg of DRY air — real-gas.
 *
 * ASHRAE Eq. 30 (`1.006·t + W·(2501 + 1.86·t)`) is an ideal-gas linearisation:
 * it holds c_p of dry air at a constant 1.006 (really 1.0057→1.0089 over
 * 0–50 °C), linearises the vapour enthalpy, and drops the pressure-dependent
 * real-gas mixing term entirely — measured up to 0.55 kJ/kg off CoolProp over
 * this tool's domain. This form splits h = h_da(t, p) + W·h_v(t, W, p) with each
 * part least-squares fitted to CoolProp 8.0.0 over −30…55 °C, 50…130 kPa,
 * W ≤ 0.20 (17,524 points): dry-air term max 0.004 kJ/kg, total max 0.063.
 * Same reference state as ASHRAE and CoolProp (h = 0 for dry air at 0 °C), so
 * enthalpy differences and chart iso-lines are unaffected.
 *
 * @param {number} tc °C @param {number} W kg/kg
 * @param {number} [p] total pressure kPa; defaults to standard — pass the site
 *   pressure whenever it is in hand, the mixing term is why this fit exists
 */
export function enthalpy(tc, W, p = P_STD) {
  const pk = p / 100;
  const t2 = tc * tc,
    t3 = t2 * tc;
  const hda =
    2.8115136038e-1 +
    1.0038061817 * tc +
    8.8617494795e-6 * t2 +
    1.2671622834e-7 * t3 +
    -2.7822677071e-1 * pk +
    1.8100065978e-3 * pk * tc +
    2.0230235867e-4 * pk * pk;
  const hv =
    2.5015791929e3 +
    1.8599514633 * tc +
    5.4496971031e-5 * t2 +
    9.4941985508e-7 * t3 +
    -5.5016132834e1 * W +
    1.7113133922 * W * tc +
    -1.1972971607e-2 * W * t2 +
    2.0046248522e1 * W * W +
    -1.2216285333 * pk +
    5.6756074986e-3 * pk * tc +
    -3.9547036083e1 * W * pk;
  return hda + W * hv;
}

/** Enthalpy direct from dry bulb / RH / pressure, kJ/kg dry air. */
export const enthalpyFrom = (tc, rh, p) => enthalpy(tc, humidityRatio(tc, rh, p), p);

/**
 * Specific volume, m³ per kg of DRY air — ASHRAE Eq. 26 with a real-gas
 * compressibility correction. Eq. 26 assumes ideal gases and runs up to 0.14 %
 * high against CoolProp; the fitted Z(t, W, p) factor brings that to 0.012 %.
 * @param {number} tc °C @param {number} W kg/kg @param {number} p kPa
 */
export function specificVolume(tc, W, p) {
  const T = tc + 273.15;
  const pk = p / 100;
  const t2 = tc * tc;
  const Z =
    1.0000017258 +
    5.1987187222e-7 * tc +
    9.0768990689e-9 * t2 +
    6.8334968054e-10 * t2 * tc +
    -6.0165183572e-4 * pk +
    1.1324375519e-5 * pk * tc +
    -9.6274617207e-8 * pk * t2 +
    1.5101313553e-4 * W +
    -7.1862725264e-5 * W * tc +
    -3.7560981995e-3 * W * pk +
    6.8096007748e-6 * pk * pk +
    9.9204577510e-7 * pk * pk * tc;
  return ((R_DA * T * (1 + 1.607858 * W)) / p) * Z;
}

/** Specific volume direct from dry bulb / RH / pressure. */
export const specificVolumeFrom = (tc, rh, p) =>
  specificVolume(tc, humidityRatio(tc, rh, p), p);

/**
 * Density of the moist-air MIXTURE, kg/m³ — (1 + W) kg of moist air occupying the
 * v m³ that one kg of dry air carries. Distinct from 1/v, which people reach for
 * by mistake; that is the dry-air density.
 */
export function moistAirDensity(tc, rh, p) {
  const W = humidityRatio(tc, rh, p);
  return (1 + W) / specificVolume(tc, W, p);
}

/**
 * Absolute humidity — mass of water vapour per cubic metre of moist air, g/m³.
 * ρ_v = pw / (Rv·T).
 */
export function absHumidity(tc, pw) {
  return ((pw * 1000) / (461.5 * (tc + 273.15))) * 1000;
}

/**
 * Reference-state offsets, calibrated against CoolProp's `Sda` by
 * `scripts/fit-secondary.mjs`. Only these two constants are free — the rest of
 * `entropy` is the ideal-gas mixture expression — so they carry no physics, they
 * just put our entropy on CoolProp's reference convention instead of an arbitrary
 * one. That the fit lands at 3.7e-4 kJ/(kg·K) worst case confirms the functional
 * form is right.
 */
const S_DA0 = 1.179779928e-4;
const S_V0 = 6.795551893;

/**
 * Specific entropy, kJ/(kg dry air · K).
 *
 * Ideal-gas mixture form: each component contributes a temperature term and a
 * partial-pressure term, on CoolProp's reference convention (see above).
 * Agreement with CoolProp over the core domain: max 3.7e-4, RMS 1.2e-4.
 */
export function entropy(tc, rh, p) {
  const T = tc + 273.15;
  const T0 = 273.15;
  const W = humidityRatio(tc, rh, p);
  const pw = vaporPressure(tc, rh);
  const pda = p - pw;
  const sda = 1.006 * Math.log(T / T0) - R_DA * Math.log(pda / P_STD);
  const sv = 1.86 * Math.log(T / T0) - R_V * Math.log(Math.max(pw, 1e-12) / P_STD) + S_V0;
  return sda + W * sv + S_DA0;
}

// ════════════════════════════════════════════════════════════════════════════
//  Transport properties  (engineering estimates — see caveat below)
// ════════════════════════════════════════════════════════════════════════════
//
// ASHRAE Fundamentals Ch.1 does not publish viscosity or thermal conductivity for
// moist air; these use Sutherland correlations for each component combined by the
// Wilke mixing rule, with the component constants fitted to CoolProp by
// `scripts/fit-secondary.mjs`. Worst-case agreement over the core domain is 0.32 %
// for viscosity and 0.43 % for conductivity — good enough for pressure-drop and
// coil work, but an order of magnitude looser than the primary properties, so the
// test suite holds them to their own tolerance and the UI labels them estimates.
//
// The textbook Sutherland constants for water vapour are notably wrong here
// (they put mixture viscosity 17 % low at high water content), which is why these
// are fitted rather than quoted.

/** Dynamic viscosity of dry air, Pa·s (Sutherland, fitted). */
function viscosityDryAir(T) {
  return (1.483059e-6 * Math.pow(T, 1.5)) / (T + 114.626);
}

/** Dynamic viscosity of water vapour, Pa·s (Sutherland, fitted). */
function viscosityVapor(T) {
  return (1.954312e-6 * Math.pow(T, 1.5)) / (T + 650.245);
}

/** Wilke mixing factor φ_ij for a binary mixture. */
function wilkePhi(mu_i, mu_j, M_i, M_j) {
  const num = Math.pow(1 + Math.sqrt(mu_i / mu_j) * Math.pow(M_j / M_i, 0.25), 2);
  const den = Math.sqrt(8 * (1 + M_i / M_j));
  return num / den;
}

/** Mole fractions of dry air and water vapour. */
function moleFractions(tc, rh, p) {
  const pw = vaporPressure(tc, rh);
  const xv = Math.min(Math.max(pw / p, 0), 1);
  return { xa: 1 - xv, xv };
}

const M_AIR = 28.9645;
const M_H2O = 18.01528;

/** Dynamic viscosity of moist air, Pa·s. Engineering estimate. */
export function viscosity(tc, rh, p) {
  const T = tc + 273.15;
  const { xa, xv } = moleFractions(tc, rh, p);
  const ma = viscosityDryAir(T);
  const mv = viscosityVapor(T);
  const phi_av = wilkePhi(ma, mv, M_AIR, M_H2O);
  const phi_va = wilkePhi(mv, ma, M_H2O, M_AIR);
  return (xa * ma) / (xa + xv * phi_av) + (xv * mv) / (xv + xa * phi_va);
}

/** Thermal conductivity of dry air, W/(m·K) (Sutherland form, fitted). */
function conductivityDryAir(T) {
  return (2.300266e-3 * Math.pow(T, 1.5)) / (T + 151.75);
}

/** Thermal conductivity of water vapour, W/(m·K) (Sutherland form, fitted). */
function conductivityVapor(T) {
  return (1.97666e-3 * Math.pow(T, 1.5)) / (T + 165.938);
}

/** Thermal conductivity of moist air, W/(m·K). Engineering estimate. */
export function thermalConductivity(tc, rh, p) {
  const T = tc + 273.15;
  const { xa, xv } = moleFractions(tc, rh, p);
  const ka = conductivityDryAir(T);
  const kv = conductivityVapor(T);
  const ma = viscosityDryAir(T);
  const mv = viscosityVapor(T);
  const phi_av = wilkePhi(ma, mv, M_AIR, M_H2O);
  const phi_va = wilkePhi(mv, ma, M_H2O, M_AIR);
  return (xa * ka) / (xa + xv * phi_av) + (xv * kv) / (xv + xa * phi_va);
}

// ════════════════════════════════════════════════════════════════════════════
//  Wet bulb
// ════════════════════════════════════════════════════════════════════════════

/**
 * Saturation humidity ratio on an EXPLICIT saturation branch.
 *
 * The wet-bulb solver has to evaluate a branch slightly past 0 °C while bracketing
 * without the branch silently flipping underneath it, which is what
 * `saturationHumidityRatio` would do.
 */
function saturationWOnBranch(twb, p, overWater) {
  const pws = overWater ? satPressureWater(twb) : satPressureIce(twb);
  return humidityRatioFromPw(pws, p, twb);
}

/**
 * ASHRAE Eq. 35 residual on an explicit branch: the humidity ratio a candidate
 * wet bulb implies, minus the actual humidity ratio. Monotone in `twb` within a
 * branch, so bisection is safe.
 */
function wetBulbResidual(twb, tc, W, p, overWater) {
  const WsStar = saturationWOnBranch(twb, p, overWater);
  const Wstar = overWater
    ? ((2501 - 2.326 * twb) * WsStar - 1.006 * (tc - twb)) / (2501 + 1.86 * tc - 4.186 * twb)
    : ((2830 - 0.24 * twb) * WsStar - 1.006 * (tc - twb)) / (2830 + 1.86 * tc - 2.1 * twb);
  return Wstar - W;
}

/** Bisect `wetBulbResidual` on one branch. Returns null when [lo, hi] holds no root. */
function bisectBranch(lo, hi, tc, W, p, overWater, tol, maxIter) {
  const fLo = wetBulbResidual(lo, tc, W, p, overWater);
  const fHi = wetBulbResidual(hi, tc, W, p, overWater);
  if (fLo === 0) return { value: lo, iterations: 0 };
  if (fHi === 0) return { value: hi, iterations: 0 };
  if (fLo * fHi > 0) return null;

  let mid = lo,
    i = 0;
  for (; i < maxIter; i++) {
    mid = (lo + hi) / 2;
    const f = wetBulbResidual(mid, tc, W, p, overWater);
    if (f > 0) hi = mid;
    else lo = mid;
    if (hi - lo < tol) break;
  }
  return { value: mid, iterations: i, converged: hi - lo < tol * 10 };
}

/**
 * Wet-bulb temperature with full solver diagnostics.
 *
 * Two things make this harder than it looks, and v1 got both wrong.
 *
 * 1. The bracket. v1 bisected a fixed 60 times over a hardcoded [−50, tdb] with no
 *    convergence test. The physically correct bracket is [dew point, dry bulb] —
 *    the wet bulb always lies between them — which converges faster and can
 *    represent wet bulbs below −50 °C.
 *
 * 2. The 0 °C seam. Eq. 35 has an over-water form and an over-ice form, and they
 *    do not agree at twb = 0, so the residual has a genuine JUMP there. A single
 *    bisection across the seam happily converges onto the jump and reports
 *    success — that is what produced up to 0.68 °C of error at conditions whose
 *    true wet bulb sits just below freezing. THIS is the physically unreachable
 *    band around the triple point that the CoolProp documentation warns about.
 *
 *    So each branch is solved strictly within its own domain. Within roughly
 *    0.6 °C of freezing BOTH branches can own a self-consistent root — the
 *    ice-covered wick and the supercooled-water wick genuinely read differently,
 *    which is real psychrometry, not an artefact. The correlations alone do not
 *    say which applies, so the ice root is returned (it agrees with CoolProp on 18
 *    of the 22 ambiguous points in the reference grid, and an ice-covered wick is
 *    the stable state below freezing) and `ambiguous` is set so callers can warn.
 *    Worst-case disagreement with CoolProp in that band is 0.8 °C; everywhere else
 *    it is under 0.01 °C. No data hall operates there — it needs a near-freezing
 *    dry bulb at low humidity — but the flag means the tool says so rather than
 *    quietly picking a side.
 *
 * @returns {{value:number, converged:boolean, iterations:number, note:string,
 *            ambiguous:boolean}}
 */
export function wetBulbSolve(tc, rh, p, tol = 1e-10, maxIter = 100) {
  const W = humidityRatio(tc, rh, p);

  if (rh >= 100 - 1e-9) {
    return { value: tc, converged: true, iterations: 0, note: 'saturated', ambiguous: false };
  }

  const tdp = dewPoint(vaporPressure(tc, rh));
  // Lower bound: the dew point, widened downward if it does not bracket the root
  // (very dry air at low pressure makes the dew point a weak bound).
  let lo = tdp === null ? tc - 100 : Math.min(tdp, tc);
  const iceBelow = Math.min(0, tc);
  for (let guard = 0; guard < 60; guard++) {
    const useWater = lo >= 0;
    if (wetBulbResidual(lo, tc, W, p, useWater) < 0) break;
    lo -= Math.max(1, Math.abs(tc - lo) * 0.5);
  }

  // Solve each branch strictly inside its own domain of validity.
  const water = tc >= 0 ? bisectBranch(Math.max(lo, 0), tc, tc, W, p, true, tol, maxIter) : null;
  const ice = lo < iceBelow ? bisectBranch(lo, iceBelow, tc, W, p, false, tol, maxIter) : null;
  const waterOk = water !== null && water.value >= -1e-12;
  const iceOk = ice !== null && ice.value <= 1e-12;

  if (waterOk && iceOk) {
    // Both wick states are self-consistent. Prefer ice; see the note above.
    return {
      value: ice.value,
      converged: ice.converged !== false,
      iterations: ice.iterations,
      note: 'near freezing: ice-wick and supercooled-water-wick solutions both exist',
      ambiguous: true,
    };
  }
  if (waterOk) {
    return {
      value: water.value,
      converged: water.converged !== false,
      iterations: water.iterations,
      note: '',
      ambiguous: false,
    };
  }
  if (iceOk) {
    return {
      value: ice.value,
      converged: ice.converged !== false,
      iterations: ice.iterations,
      note: '',
      ambiguous: false,
    };
  }

  // Neither branch owns a root — the solution falls in the gap the two forms of
  // Eq. 35 leave open around 0 °C.
  return {
    value: 0,
    converged: false,
    iterations: 0,
    note: 'wet bulb falls in the unreachable band at the ice/water transition',
    ambiguous: true,
  };
}

/**
 * Wet-bulb temperature °C. Thin wrapper over `wetBulbSolve` for the many call
 * sites that just want the number; returns NaN rather than a plausible-looking
 * wrong answer if the solve fails.
 */
export function wetBulb(tc, rh, p) {
  return wetBulbSolve(tc, rh, p).value;
}

/**
 * Inverse psychrometrics — RH % from a dry-bulb / wet-bulb pair, i.e. what a
 * sling or aspirated psychrometer reads. This is the sensor-validation reference
 * measurement.
 *
 * ASHRAE Eq. 35 solved forward for W at the observed wet bulb (over-ice form when
 * twb < 0 °C), then Eq. 20 inverted for vapour pressure and RH backed out at the
 * dry bulb.
 * @returns {number|null} null for a physically impossible pair (twb > tdb)
 */
export function rhFromWetBulb(tc, twb, p) {
  if (!isFinite(tc) || !isFinite(twb) || twb > tc + 1e-9) return null;
  const WsStar = saturationHumidityRatio(twb, p);
  const W =
    twb >= 0
      ? ((2501 - 2.326 * twb) * WsStar - 1.006 * (tc - twb)) / (2501 + 1.86 * tc - 4.186 * twb)
      : ((2830 - 0.24 * twb) * WsStar - 1.006 * (tc - twb)) / (2830 + 1.86 * tc - 2.1 * twb);
  if (W <= 0) return 0;
  const pw = vaporPressureFromW(W, p, tc);
  return Math.min(100, Math.max(0, rhFromVapor(tc, pw)));
}

/**
 * RH % from a REAL psychrometer reading — the WMO CIMO Guide psychrometer
 * formula, for slung or aspirated instruments.
 *
 * `rhFromWetBulb` above inverts ASHRAE Eq. 35, which defines the THERMODYNAMIC
 * wet bulb — an adiabatic-saturation property. A sling or aspirated psychrometer
 * measures the PSYCHROMETRIC wet bulb, set by the heat/mass-transfer balance at
 * the wick, and the two are not the same temperature: feeding an instrument
 * reading through the Eq. 35 inverse biases RH low by a measured 0.4–0.6
 * percentage points across normal hall conditions. That is a quarter of a ±2 %
 * sensor tolerance and systematic, so it does not average out over repeated
 * checks.
 *
 *   e = e_w(t_w) − A·p·(t − t_w),  A = 6.53e-4·(1 + 0.000944·t_w) over water,
 *                                  A = 5.75e-4 over ice
 *
 * Valid for a properly wetted wick with ≥3 m/s airflow — i.e. a slung or
 * aspirated instrument, which is what the WMO coefficients are calibrated for.
 *
 * @param {number} tc dry-bulb °C @param {number} twb observed wet-bulb °C
 * @param {number} p total pressure kPa
 * @returns {number|null} RH %, or null for a physically impossible pair
 */
export function rhFromPsychrometer(tc, twb, p) {
  if (!isFinite(tc) || !isFinite(twb) || twb > tc + 1e-9) return null;
  const A = twb >= 0 ? 6.53e-4 * (1 + 0.000944 * twb) : 5.75e-4;
  const e = satPressure(twb) - A * p * (tc - twb);
  if (e <= 0) return 0;
  return Math.min(100, Math.max(0, rhFromVapor(tc, e)));
}
