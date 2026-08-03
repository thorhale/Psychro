/**
 * Equipment inventory — what a hall is actually made of.
 *
 * A hall used to be four numbers: cooling °F/hr, warming °F/hr, dehumidify
 * lb/hr, humidify lb/hr. Those describe a capability without describing the
 * plant that produces it, which makes several ordinary operational questions
 * unanswerable:
 *
 *   "CRAH-3 is down for a compressor swap — what can we still do?"
 *   "Two of the four humidifiers have scaled media. How much have we lost?"
 *   "We're adding a fifth CRAC next quarter. What does that buy us?"
 *
 * So the hall carries an INVENTORY instead: individual units, each with its
 * own capacity, its own condition, and its own online/offline state. Capability
 * is then a consequence — the sum of what is installed AND working — rather
 * than a number somebody typed and nobody revisited.
 *
 * Two independent multipliers per unit, because they mean different things and
 * degrade on different timescales:
 *
 *   condPct  what THIS unit delivers against its own nameplate. Fouled media,
 *            a tired compressor, a partly blocked coil. Set from observation.
 *   online   in service or not. A binary, not a derate — a unit tagged out
 *            contributes nothing, and should not be quietly averaged in.
 *
 * The hall-wide `effPct` (mixing, stratification, control lag) still applies
 * on top in the planner: that is a property of the ROOM, not of any one
 * machine, and multiplying it in here would double-count it.
 *
 * Everything in this module is pure arithmetic over declared capacities. The
 * conversion of a thermal total into °F/hr needs the hall's thermal mass and
 * lives with the calculator that owns it; the conversion of water units into
 * lb/hr lives here because it is unit algebra with no physics in it.
 */

/** Equipment kinds the environment plant is made of. */
export const EQUIP_KINDS = ['cool', 'heat', 'dehum', 'humid', 'air'];

/** Thermal capacity units → kW. */
const THERMAL_TO_KW = {
  kw: 1,
  ton: 3.51685, //   ton of refrigeration
  btu: 1 / 3412.14, // BTU/hr
  mbh: 1 / 3.41214, // thousand BTU/hr
};

/** Water-output units → lb/hr. Water ≈ 8.34 lb/gal; a pint is 1/8 gal. */
const WATER_TO_LBHR = {
  lbhr: 1,
  gph: 8.34,
  gpd: 8.34 / 24,
  pintday: 8.34 / 8 / 24,
};

/**
 * Airflow units → CFM.
 *
 * Fans are environment plant too: a slipping belt, a loading filter or a dead
 * fan in an array all mean less air over the coil and the media, and none of
 * them announce themselves. Air movement gets counted and derated like
 * everything else.
 */
const AIR_TO_CFM = {
  cfm: 1,
  m3h: 0.5885778, //  m³/hr
  cmm: 35.31467, //   m³/min
  lps: 2.118880, //   litres/second
};

/**
 * @typedef {object} EquipUnit
 * @property {string} id
 * @property {'cool'|'heat'|'dehum'|'humid'|'air'} kind
 * @property {string} name
 * @property {number} count      how many identical units
 * @property {number} cap        capacity EACH, in `unit`
 * @property {string} unit
 * @property {number} condPct    this unit's condition vs its own nameplate
 * @property {boolean} online    in service
 * @property {{cfm:number, effPct:number}|null} evap wetted-media parameters
 * @property {{d:string, c:number}[]} hist dated condition readings, oldest first
 */

/** Is this kind measured in thermal units (vs water output or airflow)? */
export const isThermalKind = (kind) => kind === 'cool' || kind === 'heat';

/** Is this kind measured as airflow? */
export const isAirKind = (kind) => kind === 'air';

/** The conversion table a kind's capacity is expressed in. */
const scaleFor = (kind) =>
  isAirKind(kind) ? AIR_TO_CFM : isThermalKind(kind) ? THERMAL_TO_KW : WATER_TO_LBHR;

/** Base unit a kind totals into: 'kW', 'lb/hr' or 'CFM'. */
export function baseUnitOf(kind) {
  return isAirKind(kind) ? 'CFM' : isThermalKind(kind) ? 'kW' : 'lb/hr';
}

/** Capacity units valid for a kind — the UI offers exactly these. */
export function unitsForKind(kind) {
  return Object.keys(scaleFor(kind));
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** How many condition readings a unit keeps. Enough to see a slope. */
export const HIST_MAX = 12;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Coerce a unit's condition history: dated readings, oldest first. */
function normalizeHistory(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((e) => e && isDay(e.d) && isNum(e.c))
    .map((e) => ({ d: e.d, c: clamp(e.c, 0, 100) }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .slice(-HIST_MAX);
}

/**
 * Record where a unit's condition stands today.
 *
 * The inventory knew a machine's condition NOW but kept no memory of it, so
 * "HUM-1 has been fading since spring" was a thing an operator held in their
 * head or lost. One reading per day — the last write on a day wins, because a
 * day's fiddling with a number is one observation, not six. Mutates.
 *
 * @param {EquipUnit} u
 * @param {number} pct the condition being recorded
 * @param {string} today ISO date, YYYY-MM-DD — passed in so this stays pure
 */
export function logCondition(u, pct, today) {
  if (!u || !isNum(pct) || !isDay(today)) return u;
  const c = clamp(pct, 0, 100);
  const h = Array.isArray(u.hist) ? u.hist : (u.hist = []);
  const last = h[h.length - 1];
  if (last && last.d === today) last.c = c;
  else if (!last || last.c !== c) h.push({ d: today, c });
  if (h.length > HIST_MAX) h.splice(0, h.length - HIST_MAX);
  return u;
}

/**
 * How a unit's condition has moved, for a line an operator can act on.
 *
 * @returns {{from:number, to:number, delta:number, since:string, readings:number}|null}
 *   null until there are two readings to compare — one number is a fact, not
 *   a trend, and drawing a slope through it would be invention.
 */
export function conditionTrend(u) {
  const h = (u && Array.isArray(u.hist) ? u.hist : []);
  if (h.length < 2) return null;
  const first = h[0], last = h[h.length - 1];
  return {
    from: first.c, to: last.c, delta: last.c - first.c,
    since: first.d, readings: h.length,
  };
}

/**
 * Coerce one inventory entry into a complete, typed unit.
 *
 * @param {any} u raw entry (from storage, a save file, or the editor) —
 *   deliberately untyped: the whole job of this function is to accept
 *   whatever arrives and return something trustworthy or nothing
 * @returns {EquipUnit|null}
 *   null when the entry cannot be repaired into something meaningful.
 */
export function normalizeEquip(u) {
  if (u == null || typeof u !== 'object') return null;
  const kind = EQUIP_KINDS.includes(u.kind) ? u.kind : null;
  if (!kind) return null;
  const units = unitsForKind(kind);
  const unit = units.includes(u.unit) ? u.unit : units[0];
  // An evaporative humidifier's output is computed from air state, not from a
  // declared capacity, so it carries its own parameters instead.
  // cfm 0 is allowed and means "not entered yet": a freshly added media unit
  // is still a media unit, it just cannot produce a number until its airflow
  // is known. Requiring cfm > 0 here silently turned new units into ordinary
  // rated humidifiers with no way back.
  const evap =
    kind === 'humid' && u.evap != null && typeof u.evap === 'object' && isNum(u.evap.cfm) && u.evap.cfm >= 0
      ? { cfm: u.evap.cfm, effPct: isNum(u.evap.effPct) ? clamp(u.evap.effPct, 1, 100) : 85 }
      : null;
  return {
    id: typeof u.id === 'string' && u.id ? u.id : `eq_${Math.random().toString(36).slice(2, 10)}`,
    kind,
    name: typeof u.name === 'string' ? u.name.slice(0, 60) : '',
    count: isNum(u.count) ? clamp(Math.round(u.count), 1, 999) : 1,
    cap: isNum(u.cap) && u.cap >= 0 ? u.cap : 0,
    hist: normalizeHistory(u.hist),
    unit,
    condPct: isNum(u.condPct) ? clamp(u.condPct, 0, 100) : 100,
    online: u.online !== false, // absent means in service
    evap,
  };
}

/** Normalize a whole inventory, dropping entries that cannot be repaired. */
export function normalizeInventory(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeEquip).filter(Boolean).slice(0, 200);
}

/**
 * What one unit contributes right now, in the kind's base unit
 * (kW for thermal, lb/hr for water), counting quantity and condition.
 *
 * An evaporative humidifier needs the air state to answer, so the caller
 * supplies `evapLbHr(evap)` — the psychrometric model from evapmedia.js —
 * rather than this module importing physics it does not otherwise need.
 *
 * @param {EquipUnit} u normalized unit
 * @param {(evap:{cfm:number, effPct:number}) => number} [evapLbHr]
 * @returns {number} 0 when offline, in poor condition, or uncomputable
 */
export function unitOutput(u, evapLbHr) {
  if (!u || !u.online) return 0;
  const cond = u.condPct / 100;
  if (u.evap) {
    // No airflow, no evaporation — independent of whatever model the caller
    // hands in. A unit awaiting its airflow figure produces nothing.
    if (!(u.evap.cfm > 0)) return 0;
    if (typeof evapLbHr !== 'function') return 0;
    const each = evapLbHr(u.evap);
    return isNum(each) && each > 0 ? each * u.count * cond : 0;
  }
  const factor = scaleFor(u.kind)[u.unit];
  return (u.cap || 0) * (factor ?? 1) * u.count * cond;
}

/**
 * What ONE machine of this line item delivers — the whole line divided by how
 * many are in it. This is the number redundancy is measured in: a line item
 * reading "4 × 30 ton" loses a quarter of itself when a machine trips, not
 * all of it.
 */
export function perMachineOutput(u, evapLbHr) {
  const total = unitOutput(u, evapLbHr);
  return u && u.count > 0 ? total / u.count : 0;
}

/**
 * Roll an inventory up into per-kind totals.
 *
 * @param {EquipUnit[]} inv normalized inventory
 * @param {(evap:{cfm:number, effPct:number}) => number} [evapLbHr]
 * @returns {{coolKW:number, heatKW:number, dehumLbHr:number, humidLbHr:number,
 *            airCfm:number,
 *            counts:{cool:number, heat:number, dehum:number, humid:number, air:number},
 *            offline:number, degraded:number}}
 *   `counts` are units IN SERVICE (quantity, not line items). `offline` and
 *   `degraded` count line items needing attention, for an at-a-glance banner.
 */
export function inventoryTotals(inv, evapLbHr) {
  const t = {
    coolKW: 0, heatKW: 0, dehumLbHr: 0, humidLbHr: 0, airCfm: 0,
    counts: { cool: 0, heat: 0, dehum: 0, humid: 0, air: 0 },
    offline: 0, degraded: 0,
  };
  const bucket = { cool: 'coolKW', heat: 'heatKW', dehum: 'dehumLbHr', humid: 'humidLbHr', air: 'airCfm' };
  for (const u of Array.isArray(inv) ? inv : []) {
    if (!u || !EQUIP_KINDS.includes(u.kind)) continue;
    if (!u.online) { t.offline++; continue; }
    if (u.condPct < 100) t.degraded++;
    t.counts[u.kind] += u.count;
    t[bucket[u.kind]] += unitOutput(u, evapLbHr);
  }
  return t;
}

/**
 * Turn inventory totals into the hall's four planning rates.
 *
 * This is the join between the twin and the planner, and it is deliberately
 * pure: the caller works out the hall's thermal capacitance (which needs air
 * volume, pressure and the live moisture) and the IT load, and this does the
 * arithmetic. Keeping it here rather than in the UI is what lets the derived
 * rates be tested against the same numbers the rate calculator produces.
 *
 * A rate comes back null when it genuinely cannot be stated:
 *
 *   - no equipment of that kind installed — the hall cannot do it at all;
 *   - cooling that does not exceed the IT load — there is no pulldown margin,
 *     and a positive number here would promise a move that never finishes;
 *   - a thermal rate with no hall volume — kW cannot become °F/hr without
 *     knowing what mass is being heated or cooled.
 *
 * Null is the honest answer in each case, and the planner already knows how to
 * say "enter a rate to time this move".
 *
 * @param {ReturnType<typeof inventoryTotals>} totals
 * @param {{cKJperK?:number|null, itKW?:number|null}} [ctx]
 *   cKJperK  hall thermal capacitance, kJ/K (null when volume is unknown)
 *   itKW     steady IT load the cooling has to beat before it can pull down
 * @returns {{rateCoolF:number|null, rateWarmF:number|null,
 *            rateDehumLb:number|null, rateHumLb:number|null,
 *            airflowCfm:number|null}}
 */
export function ratesFromTotals(totals, ctx = {}) {
  const t = totals || inventoryTotals([]); // a zeroed rollup, not a bare {}
  const c = isNum(ctx.cKJperK) && ctx.cKJperK > 0 ? ctx.cKJperK : null;
  const itKW = isNum(ctx.itKW) && ctx.itKW > 0 ? ctx.itKW : 0;
  // kW → °F/hr for this hall's mass: (kW · 3600 s/hr) ÷ (kJ/K) × 1.8 °F/K
  const degF = (kw) => (c && kw > 0 ? Math.round(((kw * 3600) / c) * 1.8 * 10) / 10 : null);
  const lb = (v) => (v > 0 ? Math.round(v * 10) / 10 : null);
  return {
    // Cooling has to carry the IT load before any of it is available to pull
    // the room down; only the excess is a rate.
    rateCoolF: degF((t.coolKW || 0) - itKW),
    rateWarmF: degF(t.heatKW || 0),
    rateDehumLb: lb(t.dehumLbHr || 0),
    rateHumLb: lb(t.humidLbHr || 0),
    airflowCfm: t.airCfm > 0 ? Math.round(t.airCfm) : null,
  };
}

/**
 * The redundancy question: lose one machine — the biggest one — and what is
 * left?
 *
 * Every data centre is designed to some N+1 story, and the story is only true
 * while the spare capacity is real. A hall running four CRAHs at 100 % is N+1
 * on paper; the same hall with two of them at 70 % may not be. Because the
 * inventory knows each machine's own condition, the answer falls straight out
 * of it — and it is deliberately the LARGEST in-service machine, because
 * planning against the average failure is planning against a failure that
 * does not happen.
 *
 * @param {EquipUnit[]} inv normalized inventory
 * @param {string} kind which kind to interrogate
 * @param {(evap:{cfm:number, effPct:number}) => number} [evapLbHr]
 * @returns {{total:number, worst:number, worstName:string, remaining:number,
 *            machines:number}|null}
 *   null when this kind has nothing in service to lose.
 */
export function worstSingleLoss(inv, kind, evapLbHr) {
  let total = 0, worst = 0, worstName = '', machines = 0;
  for (const u of Array.isArray(inv) ? inv : []) {
    if (!u || u.kind !== kind || !u.online) continue;
    const out = unitOutput(u, evapLbHr);
    total += out;
    machines += u.count;
    const each = perMachineOutput(u, evapLbHr);
    if (each > worst) { worst = each; worstName = u.name || ''; }
  }
  if (machines === 0) return null;
  return { total, worst, worstName, remaining: total - worst, machines };
}

/**
 * What the inventory WOULD deliver at full health — the yardstick that makes
 * a degraded total meaningful. "You have 120 lb/hr of 200 installed" is a
 * sentence an operator can act on; "you have 120 lb/hr" is not.
 */
export function inventoryNameplate(inv, evapLbHr) {
  const pristine = (Array.isArray(inv) ? inv : []).map((u) => ({ ...u, condPct: 100, online: true }));
  return inventoryTotals(pristine, evapLbHr);
}
