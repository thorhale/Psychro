/**
 * BMS/BAS trend-export parser: CSV in, {time, tempF, rh} rows out.
 *
 * Building-management exports are messy in boring, predictable ways: UTF-8
 * BOMs, semicolon delimiters with comma decimals (EU locales), quoted fields,
 * shuffled column orders, and temperature in either unit. This parses
 * defensively and REFUSES rather than guesses when it cannot tell what a
 * column is — a mis-parsed trend overlaid on the chart would look exactly like
 * real data, which is the one failure a verification feature cannot have.
 *
 * Unit detection is reported back (`tempUnit`, `tempUnitSource`) so the UI can
 * show what was assumed and let the user flip it if the heuristic was wrong.
 */

const TIME_KEYS = ['time', 'timestamp', 'date', 'datetime', 'recorded'];
const TEMP_KEYS = ['temp', 'temperature', 'dry bulb', 'drybulb', 'tdb', 'db'];
const RH_KEYS = ['rh', 'humidity', 'relative humidity', 'relhum'];

/** Header → column index, matching case-insensitively on containment. */
function findCol(headers, keys) {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i].toLowerCase();
    if (keys.some((k) => h.includes(k))) return i;
  }
  return -1;
}

/** Split one CSV line honoring quotes. */
function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Parse a number that may use a comma decimal separator. */
function num(s) {
  if (typeof s !== 'string' || !s) return NaN;
  const t = s.includes(',') && !s.includes('.') ? s.replace(',', '.') : s.replace(/,/g, '');
  return Number(t);
}

// Physical windows for temperature sanity. BMS exports pepper trends with
// null sentinels (−9999, 32767, 0 on comms loss) that are perfectly finite —
// one of them dragging the column mean is enough to flip the unit heuristic,
// and one at an endpoint silently defines the "achieved rate".
const RAW_TEMP_MIN = -90; //  colder than any recorded surface temperature
const RAW_TEMP_MAX = 200; //  hotter than any hall in either unit
const TEMPF_MIN = -40; //     resolved-°F window: beyond this is not room data
const TEMPF_MAX = 140;

/**
 * Date-column format detection. `new Date('03/07/2025')` is US-biased
 * (March 7), but this parser deliberately supports EU exports — where that
 * string means 3 July. Scan the WHOLE column: any first-token > 12 proves
 * day-first; any second-token > 12 proves month-first; ISO strings are
 * unambiguous. If nothing decides, assume month-first and SAY SO.
 * @returns {{format:'iso'|'mdy'|'dmy', source:'iso'|'column'|'assumed'}}
 */
function detectDateFormat(cells) {
  let sawSlash = false;
  for (const s of cells) {
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { format: 'iso', source: 'iso' };
    const m = /^(\d{1,2})[/.](\d{1,2})[/.]\d{2,4}/.exec(s);
    if (m) {
      sawSlash = true;
      if (+m[1] > 12) return { format: 'dmy', source: 'column' };
      if (+m[2] > 12) return { format: 'mdy', source: 'column' };
    }
  }
  return { format: sawSlash ? 'mdy' : 'iso', source: sawSlash ? 'assumed' : 'iso' };
}

/** Parse one timestamp under a detected format. */
function parseTime(s, format) {
  if (format === 'dmy') {
    const m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})(.*)$/.exec(s);
    if (m) {
      const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
      return new Date(`${m[2]}/${m[1]}/${yyyy}${m[4]}`);
    }
  }
  return new Date(s);
}

/**
 * @param {string} text raw file contents
 * @param {{tempUnit?: 'F'|'C'}} [opts] force the temperature unit (the UI's
 *   override toggle); omitted → header sniff, then value-range heuristic
 * @returns {{ok:true, rows:{time:Date, tempF:number, rh:number}[],
 *            tempUnit:'F'|'C', tempUnitSource:'header'|'range'|'forced',
 *            dateFormat:'iso'|'mdy'|'dmy', dateFormatSource:'iso'|'column'|'assumed',
 *            medianStepMs:number, skipped:number}
 *          |{ok:false, error:string}}
 */
export function parseTrendCsv(text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'The file is empty.' };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 3)
    return { ok: false, error: 'Need a header row and at least two data rows.' };

  // Delimiter: whichever of ; , \t splits the header into the most columns.
  const delim = [';', ',', '\t'].reduce((best, d) =>
    splitLine(lines[0], d).length > splitLine(lines[0], best).length ? d : best,
  );
  const headers = splitLine(lines[0], delim);
  if (headers.length < 3)
    return { ok: false, error: `Could not find three columns in the header (delimiter "${delim}").` };

  const tCol = findCol(headers, TIME_KEYS);
  const tempCol = findCol(headers, TEMP_KEYS);
  const rhCol = findCol(headers, RH_KEYS);
  const missing = [
    tCol < 0 && 'a time column',
    tempCol < 0 && 'a temperature column',
    rhCol < 0 && 'an RH column',
  ].filter(Boolean);
  if (missing.length)
    return {
      ok: false,
      error: `Could not identify ${missing.join(', ')} in the header (${headers.join(' | ')}). Rename the columns to include e.g. "time", "temp", "rh".`,
    };

  // Date format is decided from the WHOLE column before any row parses, so
  // one ambiguous early row cannot commit the file to the wrong calendar.
  const timeCells = [];
  for (let i = 1; i < lines.length; i++) timeCells.push(splitLine(lines[i], delim)[tCol] || '');
  const { format: dateFormat, source: dateFormatSource } = detectDateFormat(timeCells);

  const raw = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const time = parseTime(cells[tCol] || '', dateFormat);
    const temp = num(cells[tempCol]);
    const rh = num(cells[rhCol]);
    if (
      !isFinite(time.getTime()) || !isFinite(temp) || !isFinite(rh) ||
      rh < 0 || rh > 100 ||
      // Stage-1 sanity: sentinels are rejected BEFORE the unit heuristic —
      // a single −9999 in the mean is enough to flip it.
      temp < RAW_TEMP_MIN || temp > RAW_TEMP_MAX
    ) {
      skipped++;
      continue;
    }
    raw.push({ time, temp, rh });
  }
  if (raw.length < 2)
    return { ok: false, error: `Only ${raw.length} usable data row(s) (${skipped} skipped).` };
  raw.sort((a, b) => a.time - b.time);

  // Temperature unit: forced > header sniff > value-range heuristic.
  let tempUnit, tempUnitSource;
  if (opts.tempUnit === 'F' || opts.tempUnit === 'C') {
    tempUnit = opts.tempUnit;
    tempUnitSource = 'forced';
  } else {
    const h = headers[tempCol].toLowerCase();
    if (/(\(|°|\b)f\)?$|°f|\bfahrenheit/.test(h)) {
      tempUnit = 'F';
      tempUnitSource = 'header';
    } else if (/(\(|°|\b)c\)?$|°c|\bcelsius/.test(h)) {
      tempUnit = 'C';
      tempUnitSource = 'header';
    } else {
      // A data hall lives ~59–95 °F (15–35 °C); a mean above 45 can only be °F.
      const mean = raw.reduce((s, r) => s + r.temp, 0) / raw.length;
      tempUnit = mean > 45 ? 'F' : 'C';
      tempUnitSource = 'range';
    }
  }
  // Stage-2 sanity, AFTER unit resolution: a value that survived the raw
  // window can still be nonsense once interpreted (e.g. 190 read as °C).
  const rows = [];
  for (const r of raw) {
    const tempF = tempUnit === 'F' ? r.temp : (r.temp * 9) / 5 + 32;
    if (tempF < TEMPF_MIN || tempF > TEMPF_MAX) {
      skipped++;
      continue;
    }
    rows.push({ time: r.time, tempF, rh: r.rh });
  }
  if (rows.length < 2)
    return { ok: false, error: `Only ${rows.length} usable data row(s) (${skipped} skipped).` };

  // Median sample interval — the yardstick for spotting dropout gaps, so a
  // six-hour comms hole is drawn as a break, not a confident straight line.
  const steps = [];
  for (let i = 1; i < rows.length; i++) steps.push(rows[i].time - rows[i - 1].time);
  steps.sort((a, b) => a - b);
  const medianStepMs = steps.length ? steps[Math.floor(steps.length / 2)] : 0;

  return { ok: true, rows, tempUnit, tempUnitSource, dateFormat, dateFormatSource, medianStepMs, skipped };
}

/**
 * Fastest sustained rate over a rolling time window — the number an SLA ramp
 * limit is actually about. The endpoint-to-endpoint average dilutes a hard
 * ramp with every idle hour around it; this slides a window of `windowMs`
 * across the trend and reports the worst |Δ|/Δt found, per hour.
 *
 * Windows that span a data gap (> 3× the median sample interval) are skipped:
 * a rate computed across missing data is a guess, not a measurement.
 *
 * When the data is sampled more coarsely than the requested window (hourly
 * BMS logs vs a 15-min window), the window widens to the sample interval —
 * the fastest per-sample rate is then the best available answer, and the
 * returned `windowMs` says which question was actually answered.
 *
 * @param {{time: Date, tempF:number, rh:number}[]} rows time-sorted trend
 * @param {number} windowMs rolling window, e.g. 15 min
 * @param {number} medianStepMs from parseTrendCsv
 * @returns {{tempFPerHr:number, rhPerHr:number, windowMs:number}|null}
 *   null when no window fits
 */
export function maxWindowedRate(rows, windowMs, medianStepMs) {
  if (!Array.isArray(rows) || rows.length < 2 || !(windowMs > 0)) return null;
  const w = Math.max(windowMs, medianStepMs || 0);
  const gapMs = Math.max(3 * (medianStepMs || 0), 1);
  const ms = (i) => rows[i].time.getTime();
  let maxT = null;
  let maxRh = null;
  let lo = 0;
  for (let hi = 1; hi < rows.length; hi++) {
    if (ms(hi) - ms(hi - 1) > gapMs) {
      lo = hi; // never rate across a dropout
      continue;
    }
    while (ms(hi) - ms(lo) > w) lo++;
    const dtMs = ms(hi) - ms(lo);
    // A window must span at least half its nominal width: extrapolating a
    // single one-minute step to a per-hour rate amplifies sensor noise into
    // fake ramps (±0.3 °F over 1 min "is" 18 °F/hr). Sustained means sustained.
    if (dtMs < w / 2) continue;
    const hrs = dtMs / 3600000;
    const rT = Math.abs(rows[hi].tempF - rows[lo].tempF) / hrs;
    const rRh = Math.abs(rows[hi].rh - rows[lo].rh) / hrs;
    if (maxT === null || rT > maxT) maxT = rT;
    if (maxRh === null || rRh > maxRh) maxRh = rRh;
  }
  return maxT === null ? null : { tempFPerHr: maxT, rhPerHr: maxRh, windowMs: w };
}
