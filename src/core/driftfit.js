/**
 * Sensor drift estimation over logged validation checks.
 *
 * Ordinary least-squares of error-vs-time. Deliberately simple and stated as
 * such in the UI: two points make a line, not a trend — `driftFit` reports how
 * many points and how many days it saw so the display can qualify itself, and
 * the days-to-band figure is labelled an extrapolation wherever it appears.
 */

const MS_PER_DAY = 86400000;

/**
 * @param {{date: string|number|Date, err: number}[]} entries validation checks
 *   for ONE sensor and ONE quantity (mixing °F and %RH errors is meaningless)
 * @param {number} band the |error| that means "recalibrate" (marginal bound)
 * @returns {{n:number, spanDays:number, slopePerDay:number, perMonth:number,
 *            seSlope:number|null, residualSd:number|null, latestErr:number,
 *            daysToBand:number|null, daysToBandLo:number|null,
 *            daysToBandHi:number|null}|null}
 *   null when fewer than 2 points or zero time span. daysToBand is the days
 *   until the fitted line (anchored at the latest reading) crosses whichever
 *   ±band the trend is heading toward — a sensor "improving" through zero at
 *   −0.2/day still exits the far side, and a linear model owes that answer.
 *   It is 0 when the latest error is already outside the band, and null only
 *   for a perfectly flat fit ("never, at this trend").
 *
 *   Honesty gates: a slope needs scatter to judge it, so `seSlope` (standard
 *   error of the slope) and the days-to-band figures require n ≥ 3 — two
 *   points fit a line EXACTLY and can claim any precision. With n ≥ 3 the
 *   ETA is a RANGE [daysToBandLo, daysToBandHi] from slope ± seSlope; when
 *   even the shallow end of that range never reaches the band, the range is
 *   open-ended (daysToBandHi null while daysToBandLo is finite).
 */
export function driftFit(entries, band) {
  if (!Array.isArray(entries) || entries.length < 2 || !(band > 0)) return null;
  const pts = entries
    .map((e) => ({ t: new Date(e.date).getTime() / MS_PER_DAY, err: e.err }))
    .filter((p) => isFinite(p.t) && isFinite(p.err))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const spanDays = pts[pts.length - 1].t - pts[0].t;
  if (spanDays <= 0) return null;

  const n = pts.length;
  const meanT = pts.reduce((s, p) => s + p.t, 0) / n;
  const meanE = pts.reduce((s, p) => s + p.err, 0) / n;
  let num = 0, den = 0;
  for (const p of pts) {
    num += (p.t - meanT) * (p.err - meanE);
    den += (p.t - meanT) ** 2;
  }
  const slopePerDay = den > 0 ? num / den : 0;
  const intercept = meanE - slopePerDay * meanT;
  const latestErr = pts[pts.length - 1].err;

  // Residual scatter and the slope's standard error (n ≥ 3: with two points
  // the residuals are identically zero and the "precision" is fiction).
  let seSlope = null, residualSd = null;
  if (n >= 3 && den > 0) {
    let ssr = 0;
    for (const p of pts) ssr += (p.err - (intercept + slopePerDay * p.t)) ** 2;
    residualSd = Math.sqrt(ssr / (n - 2));
    seSlope = residualSd / Math.sqrt(den);
  }

  // Days until the fitted line, anchored at the latest reading, crosses the
  // band the trend heads toward — for a given slope.
  const etaFor = (slope) => {
    if (Math.abs(latestErr) >= band) return 0;
    if (slope === 0) return null;
    const target = slope > 0 ? band : -band;
    const days = (target - latestErr) / slope;
    return days > 0 ? days : null;
  };

  // "Already outside the band" is an observation, not an extrapolation — it
  // does not need the n ≥ 3 gate. Forecasts do.
  let daysToBand = null;
  if (Math.abs(latestErr) >= band) daysToBand = 0;
  else if (n >= 3) daysToBand = etaFor(slopePerDay);
  let daysToBandLo = null, daysToBandHi = null;
  if (n >= 3 && seSlope != null && daysToBand != null && daysToBand > 0) {
    // Steeper slope → sooner (lo); shallower → later (hi). Keep the pair
    // ordered even when the interval straddles zero slope (hi open-ended).
    const steep = slopePerDay > 0 ? slopePerDay + seSlope : slopePerDay - seSlope;
    const shallow = slopePerDay > 0 ? slopePerDay - seSlope : slopePerDay + seSlope;
    daysToBandLo = etaFor(steep);
    const hi = Math.sign(shallow) === Math.sign(slopePerDay) ? etaFor(shallow) : null;
    daysToBandHi = hi;
  } else if (daysToBand === 0) {
    daysToBandLo = 0;
    daysToBandHi = 0;
  }

  return {
    n, spanDays, slopePerDay, perMonth: slopePerDay * 30,
    seSlope, residualSd, latestErr, daysToBand, daysToBandLo, daysToBandHi,
  };
}
