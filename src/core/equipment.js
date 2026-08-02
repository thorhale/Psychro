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
export const EQUIP_KINDS = ['cool', 'heat', 'dehum', 'humid'];

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
 * @typedef {object} EquipUnit
 * @property {string} id
 * @property {'cool'|'heat'|'dehum'|'humid'} kind
 * @property {string} name
 * @property {number} count      how many identical units
 * @property {number} cap        capacity EACH, in `unit`
 * @property {string} unit
 * @property {number} condPct    this unit's condition vs its own nameplate
 * @property {boolean} online    in service
 * @property {{cfm:number, effPct:number}|null} evap wetted-media parameters
 */

/** Is this kind measured in thermal units (vs water output)? */
export const isThermalKind = (kind) => kind === 'cool' || kind === 'heat';

/** Capacity units valid for a kind — the UI offers exactly these. */
export function unitsForKind(kind) {
  return isThermalKind(kind) ? Object.keys(THERMAL_TO_KW) : Object.keys(WATER_TO_LBHR);
}

const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  const factor = isThermalKind(u.kind) ? THERMAL_TO_KW[u.unit] : WATER_TO_LBHR[u.unit];
  return (u.cap || 0) * (factor ?? 1) * u.count * cond;
}

/**
 * Roll an inventory up into per-kind totals.
 *
 * @param {EquipUnit[]} inv normalized inventory
 * @param {(evap:{cfm:number, effPct:number}) => number} [evapLbHr]
 * @returns {{coolKW:number, heatKW:number, dehumLbHr:number, humidLbHr:number,
 *            counts:{cool:number, heat:number, dehum:number, humid:number},
 *            offline:number, degraded:number}}
 *   `counts` are units IN SERVICE (quantity, not line items). `offline` and
 *   `degraded` count line items needing attention, for an at-a-glance banner.
 */
export function inventoryTotals(inv, evapLbHr) {
  const t = {
    coolKW: 0, heatKW: 0, dehumLbHr: 0, humidLbHr: 0,
    counts: { cool: 0, heat: 0, dehum: 0, humid: 0 },
    offline: 0, degraded: 0,
  };
  for (const u of Array.isArray(inv) ? inv : []) {
    if (!u || !EQUIP_KINDS.includes(u.kind)) continue;
    if (!u.online) { t.offline++; continue; }
    if (u.condPct < 100) t.degraded++;
    t.counts[u.kind] += u.count;
    const out = unitOutput(u, evapLbHr);
    if (u.kind === 'cool') t.coolKW += out;
    else if (u.kind === 'heat') t.heatKW += out;
    else if (u.kind === 'dehum') t.dehumLbHr += out;
    else t.humidLbHr += out;
  }
  return t;
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
