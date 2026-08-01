/**
 * Saturated-salt humidity fixed points — the classic hygrometer-calibration
 * reference (Greenspan 1977).
 *
 * A sealed chamber holding a saturated salt slurry settles to a known relative
 * humidity that depends only on the salt and the temperature. Put the sensor
 * in the jar, wait for equilibrium, and you have a reference an RH sensor can
 * be graded against with nothing but table salt and patience.
 *
 * Source of truth: L. Greenspan, "Humidity Fixed Points of Binary Saturated
 * Aqueous Solutions", J. Res. Nat. Bur. Stand. 81A(1), 89–96 (1977) — the
 * NBS/NIST compilation of 1106 measurements from 21 investigations, fitted to
 * least-squares polynomials RH(t) = Σ aᵢ·tᵢ. The coefficients below are the
 * paper's own (Table 1), transcribed from the NBS full text and verified at
 * three temperatures per salt against the paper's tabulated values:
 * the 0 °C intercept, the universally-cited 25 °C anchor, and the 50 °C
 * endpoint all reproduce to ±0.01 %RH. (One OCR sign in the LiCl linear term
 * was corrected by exactly this cross-check.)
 *
 * Uncertainty: Greenspan tabulates per-temperature uncertainties that vary
 * along each curve. Rather than transcribe every entry, `u` below is a single
 * CONSERVATIVE bound per salt — at or above the paper's largest tabulated
 * uncertainty anywhere in 0–50 °C — so the verdict band is never tighter than
 * the reference justifies. Conservatism here can only make a PASS harder,
 * never easier.
 *
 * Valid range: 0–50 °C (the span all six salts share in the paper and the
 * span a data-hall check could plausibly occupy). Outside it, `saltRh`
 * returns null rather than extrapolate a calibration reference.
 */

/**
 * @typedef {object} SaltDef
 * @property {string} id
 * @property {string} name     display name with formula
 * @property {number[]} poly   RH(t) polynomial coefficients, %RH, t in °C
 * @property {number} u        conservative reference uncertainty, ±%RH
 * @property {string} note     practical handling note shown in the UI
 */

/** @type {SaltDef[]} */
export const SALTS = [
  {
    id: 'licl',
    name: 'Lithium chloride (LiCl)',
    poly: [11.2323, 0.00824245, -2.1489e-4],
    u: 0.6,
    note: 'Very low RH point. Hygroscopic — keep the jar sealed; slurry, not solution.',
  },
  {
    id: 'mgcl2',
    name: 'Magnesium chloride (MgCl₂)',
    poly: [33.6686, -0.00797397, -1.08988e-3],
    u: 0.4,
    note: 'The workhorse low-mid point. Stable and forgiving.',
  },
  {
    id: 'mgno32',
    name: 'Magnesium nitrate (Mg(NO₃)₂)',
    poly: [60.3514, -0.298153],
    u: 0.7,
    note: 'Mid-range point. Noticeably temperature-sensitive (−0.3 %RH per °C).',
  },
  {
    id: 'nacl',
    name: 'Sodium chloride (NaCl)',
    poly: [75.5164, 0.0398321, -2.65459e-3, 2.848e-5],
    u: 0.4,
    note: 'Plain table salt; the most-used point of all. Nearly flat with temperature.',
  },
  {
    id: 'kcl',
    name: 'Potassium chloride (KCl)',
    poly: [88.619, -0.19334, 8.99706e-4],
    u: 0.6,
    note: 'High point. Allow extra equilibration time above 80 %RH.',
  },
  {
    id: 'k2so4',
    name: 'Potassium sulfate (K₂SO₄)',
    poly: [98.7792, -0.0590502],
    u: 1.1,
    note: 'Near-saturation point. Slow to equilibrate; condensation risk if the jar cools.',
  },
];

/** The shared validity window of all six fits (°C). */
export const SALT_T_MIN_C = 0;
export const SALT_T_MAX_C = 50;

/**
 * Equilibrium RH over a saturated salt at a chamber temperature.
 *
 * @param {string} saltId one of SALTS[].id
 * @param {number} tc chamber temperature °C
 * @returns {{rh: number, u: number, salt: SaltDef}|null} expected %RH with the
 *   conservative reference uncertainty, or null when the salt is unknown or
 *   the temperature is outside the fits' validity window.
 */
export function saltRh(saltId, tc) {
  const salt = SALTS.find((s) => s.id === saltId);
  if (!salt || !isFinite(tc) || tc < SALT_T_MIN_C || tc > SALT_T_MAX_C) return null;
  let rh = 0;
  for (let i = salt.poly.length - 1; i >= 0; i--) rh = rh * tc + salt.poly[i];
  return { rh, u: salt.u, salt };
}
