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
 *            latestErr:number, daysToBand:number|null}|null}
 *   null when fewer than 2 points or zero time span. daysToBand is the days
 *   until the fitted line (anchored at the latest reading) crosses whichever
 *   ±band the trend is heading toward — a sensor "improving" through zero at
 *   −0.2/day still exits the far side, and a linear model owes that answer.
 *   It is 0 when the latest error is already outside the band, and null only
 *   for a perfectly flat fit ("never, at this trend").
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
  const latestErr = pts[pts.length - 1].err;

  let daysToBand = null;
  if (Math.abs(latestErr) >= band) daysToBand = 0;
  else if (slopePerDay !== 0) {
    // Time until the FITTED line, anchored at the latest reading, reaches the
    // band the drift is heading toward.
    const target = slopePerDay > 0 ? band : -band;
    const days = (target - latestErr) / slopePerDay;
    daysToBand = days > 0 ? days : null;
  }
  return { n, spanDays, slopePerDay, perMonth: slopePerDay * 30, latestErr, daysToBand };
}
