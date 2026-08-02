/**
 * Save-file and profile schema: validation, normalization, and migration.
 *
 * Everything that enters persistent state — from localStorage, an imported JSON
 * file, or a colleague's share — passes through here. v1 validated loosely and
 * could half-apply a malformed import before throwing; v2 validates the whole
 * payload FIRST and only then merges, so an import either applies cleanly or
 * not at all.
 *
 * Migration history:
 *   v0 (legacy)  hall data (elevation, plant rates, calc) lived on each SLA
 *                profile — `migrateLegacyProfiles` lifts it onto the hall.
 *   v1           split hall profiles / SLA profiles / scenarios / customSites.
 */

/** Fields that belong to the physical HALL, not the customer contract. */
export const HALL_KEYS = [
  'siteName',
  'elevFt',
  'hallVolFt3',
  'airflowCfm',
  'canHeat',
  'canDehumidify',
  'canHumidify',
  'rateCoolF',
  'rateWarmF',
  'rateDehumLb',
  'rateHumLb',
  'calc',
];

const isNum = (v) => typeof v === 'number' && isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Ensure a hall object has every field with a sane, typed default. Mutates. */
export function normalizeHall(h) {
  if (typeof h.siteName !== 'string') h.siteName = '';
  if (typeof h.building !== 'string') h.building = '';
  h.elevFt = isNum(h.elevFt) ? clamp(h.elevFt, -15000, 20000) : 0;
  // Optional MEASURED barometric pressure (kPa). The standard atmosphere at
  // elevation is worth ±2 kPa against real weather; a hall with a barometer
  // can pin the truth. Bounded to the pressures the physics is vouched for.
  h.baroKpa = isNum(h.baroKpa) && h.baroKpa >= 55 && h.baroKpa <= 110 ? h.baroKpa : null;
  h.hallVolFt3 = numOrNull(h.hallVolFt3);
  h.airflowCfm = numOrNull(h.airflowCfm);
  for (const k of ['canHeat', 'canDehumidify', 'canHumidify']) h[k] = h[k] === true;
  for (const k of ['rateCoolF', 'rateWarmF', 'rateDehumLb', 'rateHumLb'])
    h[k] = numOrNull(h[k]);
  if (h.calc == null || typeof h.calc !== 'object') h.calc = {};
  if (!h.name || typeof h.name !== 'string')
    h.name = h.siteName ? `${h.siteName} · Hall` : 'Hall 1';
  // 1–150, matching the UI: a plant genuinely can beat nameplate (staged
  // equipment, favorable conditions), and the calibration flow produces
  // >100 values. This was 1–100 once — a calibrated 120 % silently became
  // 100 % on every reload. test/schema.test.js pins the survival.
  h.effPct = isNum(h.effPct) ? clamp(h.effPct, 1, 150) : 85;
  for (const k of ['derateCoolPct', 'derateWarmPct', 'derateDehumPct', 'derateHumPct'])
    h[k] = isNum(h[k]) ? clamp(h[k], 0, 100) : 100;
  if (!Array.isArray(h.results)) h.results = [];
  return h;
}

/** Ensure an SLA profile is a pure, typed contract. Mutates. */
export function normalizeSla(s) {
  if (!s.name || typeof s.name !== 'string') s.name = 'SLA';
  s.tMinF = isNum(s.tMinF) ? s.tMinF : 50;
  s.tMaxF = isNum(s.tMaxF) ? s.tMaxF : 95;
  if (s.tMaxF < s.tMinF) [s.tMinF, s.tMaxF] = [s.tMaxF, s.tMinF];
  s.rhMin = isNum(s.rhMin) ? clamp(s.rhMin, 0, 100) : 5;
  s.rhMax = isNum(s.rhMax) ? clamp(s.rhMax, 0, 100) : 80;
  if (s.rhMax < s.rhMin) [s.rhMin, s.rhMax] = [s.rhMax, s.rhMin];
  s.dpMaxF = s.dpMaxF === '' || s.dpMaxF == null ? null : numOrNull(s.dpMaxF);
  s.maxDtHr = numOrNull(s.maxDtHr);
  s.maxDrhHr = numOrNull(s.maxDrhHr);
  s.locked = s.locked === true;
  return s;
}

/**
 * MIGRATION (v0 → v1): legacy saves kept hall data on each SLA profile. Lift it
 * onto the given hall once (from the first profile carrying real values), then
 * strip those keys so profiles become pure contracts.
 * @returns the same profiles array, cleaned.
 */
export function migrateLegacyProfiles(profiles, hall) {
  const src = profiles.find(
    (p) =>
      p.hallVolFt3 != null ||
      p.rateCoolF != null ||
      p.canDehumidify ||
      p.canHumidify ||
      (p.calc && Object.keys(p.calc).length) ||
      (p.elevFt != null && p.elevFt !== 0) ||
      (p.siteName && p.siteName !== ''),
  );
  if (src && hall) {
    for (const k of HALL_KEYS) {
      const cur = hall[k];
      const empty =
        cur === undefined ||
        cur === null ||
        cur === false ||
        cur === '' ||
        (k === 'calc' && !Object.keys(cur || {}).length);
      if (empty && src[k] !== undefined && src[k] !== null) hall[k] = src[k];
    }
    normalizeHall(hall);
  }
  profiles.forEach((s) => {
    for (const k of HALL_KEYS) delete s[k];
  });
  return profiles;
}

/** A scenario is valid if it has the four state-point numbers. */
export function isValidScenario(s) {
  return (
    s != null &&
    typeof s === 'object' &&
    isNum(s.aTemp) &&
    isNum(s.aRH) &&
    isNum(s.bTemp) &&
    isNum(s.bRH)
  );
}

/** A custom site needs at least city + state; elevation defaults to 0. */
export function isValidSite(c) {
  return (
    c != null &&
    typeof c === 'object' &&
    typeof c.city === 'string' &&
    c.city.length > 0 &&
    typeof c.state === 'string' &&
    c.state.length > 0
  );
}

/**
 * Validate a whole save-file payload WITHOUT applying anything.
 *
 * @returns {{ok: boolean, error?: string,
 *            halls: object[], slas: object[], sites: object[], scenarios: object[]}}
 *   The returned arrays contain only entries that passed validation, already
 *   normalized — the caller can merge them without further checks.
 */
/** Cap on stored sensor-log entries — bounds storage; oldest are dropped. */
export const SENSOR_LOG_MAX = 500;

/**
 * One logged sensor-validation check. `quantity` scopes the error's unit
 * ('rh' → %RH, 'temp' → °F); mixing them in one trend would be meaningless,
 * so it is part of the record, not an afterthought.
 */
export function isValidLogEntry(e) {
  return (
    e != null &&
    typeof e === 'object' &&
    typeof e.sensor === 'string' &&
    e.sensor.trim().length > 0 &&
    typeof e.method === 'string' &&
    (e.quantity === 'rh' || e.quantity === 'temp') &&
    isNum(e.ref) &&
    isNum(e.u) &&
    e.u >= 0 &&
    isNum(e.reading) &&
    isNum(e.err) &&
    typeof e.date === 'string' &&
    isFinite(new Date(e.date).getTime())
  );
}

/**
 * Normalize a stored sensor log: keep only valid entries, oldest-first,
 * capped at SENSOR_LOG_MAX (newest win — history is for trends, and a trend
 * that needs >500 points has a different problem).
 *
 * Optional audit fields (`hallName`, `siteName`, `tech`) ride along when they
 * are strings and are dropped otherwise — a pre-existing save file without
 * them stays valid forever.
 */
export function normalizeSensorLog(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter(isValidLogEntry)
    .map((e) => {
      const out = { ...e };
      for (const k of ['hallName', 'siteName', 'tech']) {
        if (out[k] != null && (typeof out[k] !== 'string' || !out[k].trim())) delete out[k];
      }
      return out;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return list.slice(-SENSOR_LOG_MAX);
}

/** Cap on registered sensors — a hall floor has dozens, not thousands. */
export const SENSOR_REG_MAX = 200;

/**
 * One registered sensor's metadata: its OWN spec (which then replaces the
 * generic tolerance defaults in verdicts) and its calibration cadence.
 * Everything except the name is optional — a registry entry with just a name
 * is a valid placeholder.
 */
export function isValidSensorMeta(m) {
  const optNum = (v, lo) => v == null || (isNum(v) && v > (lo ?? 0));
  return (
    m != null &&
    typeof m === 'object' &&
    typeof m.name === 'string' &&
    m.name.trim().length > 0 &&
    optNum(m.specRh) &&
    optNum(m.specTF) &&
    optNum(m.calIntervalDays) &&
    (m.lastCalDate == null ||
      (typeof m.lastCalDate === 'string' && isFinite(new Date(m.lastCalDate).getTime())))
  );
}

/**
 * Normalize a stored sensor registry: valid entries only, de-duplicated by
 * name (last write wins — a merge brings the newer spec), capped.
 */
export function normalizeSensorRegistry(raw) {
  const byName = new Map();
  for (const m of Array.isArray(raw) ? raw : []) {
    if (!isValidSensorMeta(m)) continue;
    byName.set(m.name.trim(), {
      name: m.name.trim(),
      specRh: m.specRh ?? null,
      specTF: m.specTF ?? null,
      calIntervalDays: m.calIntervalDays ?? null,
      lastCalDate: m.lastCalDate ?? null,
    });
  }
  return [...byName.values()].slice(-SENSOR_REG_MAX);
}

export function validateSaveFile(data) {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'Not a save file', halls: [], slas: [], sites: [], scenarios: [] };
  }
  const anyPayload =
    Array.isArray(data.hallProfiles) ||
    Array.isArray(data.slaProfiles) ||
    Array.isArray(data.scenarios) ||
    Array.isArray(data.customSites);
  if (!anyPayload) {
    return {
      ok: false,
      error: 'No planner data in this file',
      halls: [],
      slas: [],
      sites: [],
      scenarios: [],
    };
  }

  const halls = (Array.isArray(data.hallProfiles) ? data.hallProfiles : [])
    .filter((h) => h != null && typeof h === 'object')
    .map((h) => normalizeHall({ ...h }));
  const slas = (Array.isArray(data.slaProfiles) ? data.slaProfiles : [])
    .filter((s) => s != null && typeof s === 'object' && typeof s.name === 'string' && s.name)
    .map((s) => normalizeSla({ ...s }));
  const sites = (Array.isArray(data.customSites) ? data.customSites : []).filter(isValidSite);
  const scenarios = (Array.isArray(data.scenarios) ? data.scenarios : []).filter(isValidScenario);
  const sensorLog = normalizeSensorLog(data.sensorLog);
  const sensorRegistry = normalizeSensorRegistry(data.sensorRegistry);

  return { ok: true, halls, slas, sites, scenarios, sensorLog, sensorRegistry };
}
