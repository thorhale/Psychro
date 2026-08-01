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

/**
 * @param {string} text raw file contents
 * @param {{tempUnit?: 'F'|'C'}} [opts] force the temperature unit (the UI's
 *   override toggle); omitted → header sniff, then value-range heuristic
 * @returns {{ok:true, rows:{time:Date, tempF:number, rh:number}[],
 *            tempUnit:'F'|'C', tempUnitSource:'header'|'range'|'forced',
 *            skipped:number}
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

  const raw = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const time = new Date(cells[tCol]);
    const temp = num(cells[tempCol]);
    const rh = num(cells[rhCol]);
    if (!isFinite(time.getTime()) || !isFinite(temp) || !isFinite(rh) || rh < 0 || rh > 100) {
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
  const rows = raw.map((r) => ({
    time: r.time,
    tempF: tempUnit === 'F' ? r.temp : (r.temp * 9) / 5 + 32,
    rh: r.rh,
  }));
  return { ok: true, rows, tempUnit, tempUnitSource, skipped };
}
