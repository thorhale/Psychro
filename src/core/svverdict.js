/**
 * Sensor-check verdict grading with guard-banding (ISO 14253-1 / ILAC-G8).
 *
 * The question a validation check answers is "is this sensor inside its
 * tolerance?", and the reference used to answer it has an uncertainty of its
 * own. Guard-banding says: to CLAIM a pass, the error must be inside the
 * tolerance by at least the reference's uncertainty — otherwise the reference
 * itself could be the reason the number looks good. So:
 *
 *   PASS               |err| ≤ tol − u_ref        (confident conformance)
 *   TOO CLOSE TO CALL  tol − u_ref < |err| ≤ tol + u_ref
 *                      (the reference's own ±u straddles the limit — a
 *                       tighter reference is needed to decide)
 *   MARGINAL           tol + u_ref < |err| ≤ marginal + u_ref
 *   FAIL               |err| > marginal + u_ref   (confident non-conformance)
 *
 * An earlier version WIDENED the pass band to tol + u_ref, which is
 * backwards: it made a worse reference make PASS easier. Under guard-banding
 * a worse reference makes every confident claim harder — which is what
 * uncertainty means. Note the asymmetry is deliberate: FAIL also requires the
 * error to clear the band by u_ref, so both confident verdicts are protected;
 * only the in-between is honest about being undecidable.
 */

/** Default tolerance bands. PR-H will let a per-sensor spec override these. */
export const SV_TOL = {
  rhPass: 2, //     %RH — typical capacitive-sensor spec
  rhMarginal: 5, // %RH — beyond this: recalibrate
  tPassF: 0.9, //   °F (0.5 °C) — typical RTD/thermistor spec
  tMarginalF: 1.8, // °F (1.0 °C)
};

/**
 * Grade a sensor error against pass/marginal tolerances with a reference of
 * uncertainty uRef (same unit as err).
 *
 * @param {number|null} err  sensor reading − reference true value
 * @param {number} pass      the sensor's tolerance (spec limit)
 * @param {number} marginal  beyond this: recalibrate now
 * @param {number} [uRef]    the reference's own uncertainty
 * @returns {{cls:string, word:string, band:number, indet:boolean}|null}
 *   `band` is the decision band the verdict was graded against, for display.
 *   null when there is no reading to grade.
 */
export function svVerdict(err, pass, marginal, uRef = 0) {
  if (err == null || !isFinite(err)) return null;
  const a = Math.abs(err);
  const passBand = Math.max(0, pass - uRef);
  const closeBand = pass + uRef;
  const marginalBand = marginal + uRef;
  if (a <= passBand) return { cls: 'sv-pass', word: 'PASS', band: passBand, indet: false };
  if (a <= closeBand)
    return { cls: 'sv-indet', word: 'TOO CLOSE TO CALL', band: closeBand, indet: true };
  if (a <= marginalBand)
    return { cls: 'sv-marginal', word: 'MARGINAL', band: marginalBand, indet: false };
  return { cls: 'sv-fail', word: 'FAIL', band: marginalBand, indet: false };
}
