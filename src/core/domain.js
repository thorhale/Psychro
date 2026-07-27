/**
 * Validity domain for the psychrometric core — the single most important
 * correctness feature added in v2.
 *
 * The v1 tool computed confidently everywhere its sliders reached, but its
 * enhancement-factor fit was calibrated only over 0–50 °C / 65–102 kPa while the
 * chart runs to 54 °C and the elevation input admits ~22 kPa. v2 refits over the
 * full reachable envelope AND declares that envelope here, so anything outside it
 * is flagged in the UI instead of silently extrapolated.
 *
 * `CORE_DOMAIN` must stay in sync with `core_domain` in
 * `test/reference/generate_reference.py` — the test suite asserts they agree, so
 * the declared band can never drift from the band the oracle actually validates.
 */

import { humidityRatio, wetBulbSolve } from './psychro.js';

/** The band the core is validated against CoolProp in. */
export const CORE_DOMAIN = {
  /** Dry-bulb °C. Chart range is 0–54.4 °C; margin below freezing included. */
  tMinC: -20,
  tMaxC: 55,
  /** Total pressure kPa. 60 kPa ≈ 13,800 ft — beyond any real site. */
  pMinKpa: 60,
  pMaxKpa: 108,
  /** Humidity ratio ceiling, kg/kg. Far beyond any data-hall condition. */
  wMaxKgKg: 0.15,
};

/**
 * Where individual equations stop being valid, independent of the validated
 * band. These produce their own, more specific messages.
 */
const EQUATION_LIMITS = {
  /** ASHRAE Eq. 5 upper limit (over water). */
  satWaterMaxC: 200,
  /** ASHRAE Eq. 6 lower limit (over ice). */
  satIceMinC: -100,
  /** ASHRAE Eq. 3 altitude validity translated to pressure. */
  pressureEqMinKpa: 22.6,
  pressureEqMaxKpa: 108.9,
};

/**
 * Check a state point against the validated domain.
 *
 * Returns `{ ok, warnings }` where each warning is `{ code, message }`. `ok` is
 * true when the point sits fully inside the CoolProp-validated band AND no
 * equation-specific limit is breached. The chart renders a warning chip whenever
 * `ok` is false; calculations still run (an operator planning an excursion needs
 * numbers, not a refusal) — they are just labelled as outside the validated band.
 *
 * @param {number} tc dry-bulb °C
 * @param {number} rh relative humidity %
 * @param {number} p total pressure kPa
 * @returns {{ok: boolean, warnings: {code: string, message: string}[]}}
 */
export function checkDomain(tc, rh, p) {
  const warnings = [];
  const push = (code, message) => warnings.push({ code, message });

  if (!isFinite(tc) || !isFinite(rh) || !isFinite(p)) {
    push('invalid', 'Non-numeric state point');
    return { ok: false, warnings };
  }

  if (tc < CORE_DOMAIN.tMinC || tc > CORE_DOMAIN.tMaxC) {
    push(
      'temp',
      `Dry bulb ${tc.toFixed(1)} °C is outside the validated ${CORE_DOMAIN.tMinC}…${CORE_DOMAIN.tMaxC} °C band`,
    );
  }
  if (p < CORE_DOMAIN.pMinKpa || p > CORE_DOMAIN.pMaxKpa) {
    push(
      'pressure',
      `Pressure ${p.toFixed(1)} kPa is outside the validated ${CORE_DOMAIN.pMinKpa}…${CORE_DOMAIN.pMaxKpa} kPa band`,
    );
  }
  if (rh < 0 || rh > 100) {
    push('rh', `Relative humidity ${rh.toFixed(1)} % is outside 0–100 %`);
  }

  if (tc > EQUATION_LIMITS.satWaterMaxC || tc < EQUATION_LIMITS.satIceMinC) {
    push('sat-eq', 'Beyond the range of the ASHRAE saturation equations themselves');
  }
  if (p < EQUATION_LIMITS.pressureEqMinKpa || p > EQUATION_LIMITS.pressureEqMaxKpa) {
    push('pressure-eq', 'Beyond the range of ASHRAE Eq. 3 (pressure–altitude)');
  }

  // Only worth computing W if the basic inputs are sane.
  if (warnings.length === 0 || (rh >= 0 && rh <= 100)) {
    const W = humidityRatio(tc, rh, p);
    if (!isFinite(W) || W > CORE_DOMAIN.wMaxKgKg) {
      push(
        'w',
        `Humidity ratio ${isFinite(W) ? (W * 1000).toFixed(1) + ' g/kg' : '∞'} exceeds the validated ${CORE_DOMAIN.wMaxKgKg * 1000} g/kg ceiling`,
      );
    }
  }

  // Near-freezing wet-bulb ambiguity: both Eq. 35 wick states are self-consistent.
  // Report it so the UI can annotate the wet-bulb readout specifically.
  if (warnings.length === 0 && tc >= 0 && tc <= 15) {
    const wb = wetBulbSolve(tc, rh, p);
    if (wb.ambiguous) {
      push('wetbulb-ambiguous', 'Wet bulb is near freezing: ice- and water-wick readings differ; the ice value is shown');
    }
  }

  return { ok: warnings.length === 0, warnings };
}

/**
 * True when a point is inside the CoolProp-validated band (ignoring the
 * softer equation-specific and ambiguity warnings). Used by the test suite.
 */
export function inCoreDomain(tc, p, W) {
  return (
    tc >= CORE_DOMAIN.tMinC &&
    tc <= CORE_DOMAIN.tMaxC &&
    p >= CORE_DOMAIN.pMinKpa &&
    p <= CORE_DOMAIN.pMaxKpa &&
    W <= CORE_DOMAIN.wMaxKgKg
  );
}
