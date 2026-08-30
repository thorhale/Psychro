/**
 * Getting the plan back out, in a shape a building-management system can take.
 *
 * Trend data comes IN as CSV and nothing ever went back out, so the last mile
 * — handing a BMS operator the set-points, or handing a manager the campus —
 * was retyping from a screen. These build the two files that closes.
 *
 * Pure string builders, deliberately: a CSV that only exists once it has been
 * clicked cannot be tested, and this is the file someone types into acontrol system
 * from. Everything here is asserted in `test/bmsexport.test.js`.
 *
 * Conventions, chosen to survive a spreadsheet and a BACnet point list:
 *   - RFC 4180 quoting — every field quoted, internal quotes doubled. Hall
 *     names contain commas ("Hall 2, Building A") often enough to matter.
 *   - ISO-8601 timestamps, so a sort is a chronological sort.
 *   - Column names are lower_snake_case ASCII with the unit in the name, not
 *     in a separate header row: `temp_f`, not `temp` under a `°F` banner. A
 *     point list has one name per point and no room for a second row.
 *   - Temperatures are written in BOTH °F and °C. Which one a site's BMS wants
 *     is not knowable from here, and a wrong guess is a silent unit error.
 */

import { cToF, fToC } from './units.js';

/** RFC 4180 field: always quoted, internal quotes doubled. */
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** One CSV line from a list of values. */
const row = (vals) => vals.map(q).join(',');

/** Round for output without printing a false precision. */
const n1 = (v) => (v == null || !isFinite(v) ? '' : (Math.round(v * 10) / 10).toString());
const n2 = (v) => (v == null || !isFinite(v) ? '' : (Math.round(v * 100) / 100).toString());

/**
 * The set-point ladder as a schedule a BMS operator can follow or import.
 *
 * @param {object} p
 * @param {{atHr:number, tempF:number, rh:number}[]} p.rungs  from the same
 *   interpolation the chart's pacing ticks use — passed in, never re-derived,
 *   so the file cannot disagree with the picture it came from
 * @param {string} [p.hallName]
 * @param {string} [p.slaName]
 * @param {Date} [p.startAt]  wall-clock start; omitted means relative only
 * @param {(tempF:number, rh:number)=>number|null} [p.dewPointF] optional dew
 *   point for each rung, so the file carries the value an SLA actually caps
 * @returns {string} CSV text
 */
export function setpointScheduleCsv({ rungs, hallName, slaName, startAt, dewPointF }) {
  const head = [
    'step', 'elapsed_hours', 'clock_iso', 'hall', 'sla',
    'temp_f', 'temp_c', 'rh_pct', 'dew_point_f', 'dew_point_c',
  ];
  const lines = [row(head)];
  rungs.forEach((r, i) => {
    const dpF = dewPointF ? dewPointF(r.tempF, r.rh) : null;
    const clock = startAt ? new Date(startAt.getTime() + r.atHr * 3600e3).toISOString() : '';
    lines.push(row([
      i + 1,
      n2(r.atHr),
      clock,
      hallName || '',
      slaName || '',
      n1(r.tempF),
      n1(fToC(r.tempF)),
      n1(r.rh),
      dpF == null ? '' : n1(dpF),
      dpF == null ? '' : n1(fToC(dpF)),
    ]));
  });
  return lines.join('\n');
}

/**
 * Every hall on one row — the campus as a spreadsheet.
 *
 * @param {object} p
 * @param {any[]} p.halls           normalised hall profiles
 * @param {{name?:string}} p.sla    the contract they are graded against
 * @param {(h:any)=>number} p.pressureOf        site pressure kPa for a hall
 * @param {(h:any)=>{ok:boolean, detail?:string}|null} p.verdictOf  null when
 *   the hall has never been worked on and so has nothing to grade
 * @param {(h:any)=>{tempF:number, rh:number}|null} p.conditionOf
 * @returns {string} CSV text
 */
export function fleetCsv({ halls, sla, pressureOf, verdictOf, conditionOf }) {
  const head = [
    'hall', 'building', 'site', 'elevation_ft', 'pressure_kpa', 'pressure_source',
    'temp_f', 'temp_c', 'rh_pct',
    'sla', 'sla_verdict', 'sla_detail',
    'cool_f_per_hr', 'warm_f_per_hr', 'dehum_lb_per_hr', 'hum_lb_per_hr',
    'efficiency_pct', 'hall_volume_ft3', 'supply_cfm', 'doas_cfm',
  ];
  const lines = [row(head)];
  for (const h of halls) {
    const c = conditionOf(h);
    const v = verdictOf(h);
    lines.push(row([
      h.name || '', h.building || '', h.siteName || '',
      n1(h.elevFt ?? 0),
      n2(pressureOf(h)),
      h.baroKpa != null ? 'measured' : 'from elevation',
      c ? n1(c.tempF) : '',
      c ? n1(fToC(c.tempF)) : '',
      c ? n1(c.rh) : '',
      sla?.name || '',
      v == null ? 'not set up' : v.ok ? 'in SLA' : 'OUT OF SLA',
      v == null || v.ok ? '' : v.detail || '',
      n1(h.rateCoolF), n1(h.rateWarmF), n1(h.rateDehumLb), n1(h.rateHumLb),
      n1(h.effPct), n1(h.hallVolFt3), n1(h.airflowCfm), n1(h.doasCfm),
    ]));
  }
  return lines.join('\n');
}

/** Exported for tests that need the same rounding the files use. */
export const _fmt = { q, row, n1, n2, cToF };
