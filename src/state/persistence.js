/**
 * Persisted-state parsing and cross-version migration.
 *
 * This is the code path that decides whether an operator's saved halls, SLAs and
 * unit preference survive an app update. It was inline and untested in v1; it is
 * pure here so `test/persistence.test.js` can pin every historical layout with
 * real fixtures.
 *
 * Storage layouts, newest first — the first one that parses wins:
 *
 *   v4  `sdc_hep_v4`                 multi-hall: hallProfiles[] + activeHall +
 *                                    hallView + slaProfiles[] + activeSla
 *   v3  `sdc_hep_v3`                 single `hall` object + slaProfiles[]
 *   v1  `sdc_psychro_slaProfiles_v1` slaProfiles[] only, with hall data still
 *                                    living ON the SLA profiles (lifted out by
 *                                    `migrateLegacyProfiles`)
 *
 * `parseStoredState` never touches live state: it returns a plain patch the
 * caller applies. That separation is what makes the migration testable without a
 * DOM, and what makes a corrupt payload a no-op rather than a half-applied mess.
 */

import { normalizeHall, normalizeSla, migrateLegacyProfiles } from './schema.js';

export const LS_KEY_V1 = 'sdc_psychro_slaProfiles_v1';
export const LS_KEY_V3 = 'sdc_hep_v3';
export const LS_KEY_V4 = 'sdc_hep_v4';

/** The Base SLA that must always occupy index 0. */
export function baseSla() {
  return {
    name: 'Base SLA',
    tMinF: 50,
    tMaxF: 95,
    rhMin: 5,
    rhMax: 80,
    dpMaxF: null,
    maxDtHr: 18,
    maxDrhHr: 20,
    locked: true,
  };
}

/**
 * Ensure a locked Base SLA leads the list, and normalize every entry.
 * Older saves predate several fields; `normalizeSla` backfills them.
 */
function withBaseSla(list) {
  const profiles = list.some((s) => s && s.locked) ? [...list] : [baseSla(), ...list];
  return profiles.filter((s) => s && typeof s === 'object').map((s) => normalizeSla({ ...s }));
}

/** JSON.parse that yields null instead of throwing. */
function tryParse(raw) {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {object} StatePatch
 * @property {object[]} [hallProfiles]
 * @property {number} [activeHall]
 * @property {{loc:string, bld:string}} [hallView]
 * @property {object} [hall]        v3 only: a single hall to merge onto the active one
 * @property {object[]} [slaProfiles]
 * @property {number} [activeSla]
 * @property {'F'|'C'|'K'} [tempUnit]
 */

/**
 * Parse whatever is in storage into a patch, without applying it.
 *
 * @param {{v4?: string|null, v3?: string|null, v1?: string|null}} raw
 *   Raw strings straight from storage, by layout version.
 * @param {object} [currentHall] the live active hall — v1 saves carry hall data
 *   on their SLA profiles, and `migrateLegacyProfiles` lifts it onto this object.
 * @returns {{found: boolean, sourceVersion: 0|1|3|4, patch: StatePatch}}
 *   `found: false` with `sourceVersion: 0` means nothing usable was stored and
 *   the caller should keep its defaults.
 */
export function parseStoredState(raw, currentHall) {
  // ── v4: the current layout ────────────────────────────────────────────────
  const d4 = tryParse(raw.v4);
  if (d4 && d4.v === 4) {
    /** @type {StatePatch} */
    const patch = {};
    if (Array.isArray(d4.hallProfiles) && d4.hallProfiles.length) {
      patch.hallProfiles = d4.hallProfiles
        .filter((h) => h && typeof h === 'object')
        .map((h) => normalizeHall({ ...h }));
      if (patch.hallProfiles.length) {
        patch.activeHall = Math.min(
          Math.max(0, Number(d4.activeHall) || 0),
          patch.hallProfiles.length - 1,
        );
      } else {
        delete patch.hallProfiles;
      }
    }
    if (d4.hallView && typeof d4.hallView === 'object') {
      patch.hallView = { loc: d4.hallView.loc || '', bld: d4.hallView.bld || '' };
    }
    if (Array.isArray(d4.slaProfiles) && d4.slaProfiles.length) {
      patch.slaProfiles = withBaseSla(d4.slaProfiles);
      patch.activeSla = Math.min(
        Math.max(0, Number(d4.activeSla) || 0),
        patch.slaProfiles.length - 1,
      );
    }
    if (d4.tempUnit) patch.tempUnit = d4.tempUnit;
    return { found: true, sourceVersion: 4, patch };
  }

  // ── v3: single hall ───────────────────────────────────────────────────────
  const d3 = tryParse(raw.v3);
  if (d3 && d3.v === 3) {
    /** @type {StatePatch} */
    const patch = {};
    if (d3.hall && typeof d3.hall === 'object') {
      // Blank the name when the save had none so normalizeHall re-derives it
      // from the site — a v3 hall that was never renamed should pick up the
      // "<site> · Hall" label rather than keep a stale default.
      const merged = { ...d3.hall };
      if (!d3.hall.name) merged.name = '';
      patch.hall = normalizeHall(merged);
    }
    if (Array.isArray(d3.slaProfiles) && d3.slaProfiles.length) {
      patch.slaProfiles = withBaseSla(d3.slaProfiles);
      patch.activeSla = Math.min(
        Math.max(0, Number(d3.activeSla) || 0),
        patch.slaProfiles.length - 1,
      );
    }
    if (d3.tempUnit) patch.tempUnit = d3.tempUnit;
    return { found: true, sourceVersion: 3, patch };
  }

  // ── v1: SLA profiles carrying hall data ───────────────────────────────────
  const d1 = tryParse(raw.v1);
  if (d1 && Array.isArray(d1.slaProfiles) && d1.slaProfiles.length) {
    const slaProfiles = withBaseSla(d1.slaProfiles);
    // Lift hall fields off the profiles onto the hall, then strip them, so
    // profiles become pure contracts from here on.
    migrateLegacyProfiles(slaProfiles, currentHall);
    /** @type {StatePatch} */
    const patch = {
      slaProfiles,
      activeSla: Math.min(Math.max(0, Number(d1.activeSla) || 0), slaProfiles.length - 1),
    };
    if (d1.tempUnit) patch.tempUnit = d1.tempUnit;
    return { found: true, sourceVersion: 1, patch };
  }

  return { found: false, sourceVersion: 0, patch: {} };
}

/** Build the v4 payload written on every state change. */
export function buildStoredState(state) {
  return {
    v: 4,
    hallProfiles: state.hallProfiles,
    activeHall: state.activeHall,
    hallView: state.hallView,
    slaProfiles: state.slaProfiles,
    activeSla: state.activeSla,
    tempUnit: state.tempUnit,
  };
}
