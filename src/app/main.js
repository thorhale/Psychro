/**
 * Stream Hall Environment Planner — application entry.
 *
 * All physics comes from `src/core/` (headlessly tested against CoolProp — see
 * `test/psychro.test.js`); this module owns state, DOM wiring, the canvas chart,
 * profiles, scenarios, and exports. Extracted from the v1 single-file app; the
 * UI structure is intentionally preserved so the change history stays reviewable.
 */

import {
  pressureFromAltitude,
  satPressure,
  vaporPressure,
  humidityRatio,
  humidityRatioFromPw,
  humidityRatioG,
  saturationHumidityRatio,
  vaporPressureFromW,
  rhFromW,
  dewPoint,
  specificVolume,
  wetBulb,
  rhFromWetBulb,
  rhFromPsychrometer,
  rhFromDewPoint,
} from '../core/psychro.js';
import { SALTS, saltRh, saltRhSlope, SALT_T_MIN_C, SALT_T_MAX_C } from '../core/saltref.js';
import { boilingPointC, U_PRACTICAL_C } from '../core/boilref.js';
import { fToC, cToF, TEMP_UNITS, deltaFromF, deltaLabelFor } from '../core/units.js';
import {
  ASHRAE_ENVELOPES,
  envelopePolygon,
  slaPolygon,
  checkSLA as checkSLACore,
} from '../core/envelopes.js';
import { rampPlanFor as rampPlanCore, fmtHrs } from '../core/planner.js';
import { checkDomain } from '../core/domain.js';
import { deriveState, deriveStateF } from '../core/derive.js';
import { stAbbr, allSites as allSitesFor } from '../config/sites.js';
import {
  normalizeHall,
  migrateLegacyProfiles,
  validateSaveFile,
  isValidScenario,
  normalizeSensorLog,
} from '../state/schema.js';
import { driftFit } from '../core/driftfit.js';
import { parseTrendCsv } from '../lib/trendcsv.js';
import { SCENARIOS, refereeRun } from '../core/trainer.js';
import {
  LS_KEY_V1,
  LS_KEY_V3,
  LS_KEY_V4,
  parseStoredState,
  buildStoredState,
} from '../state/persistence.js';
import { toast, confirmDialog, copyText, imageDialog } from '../ui/notify.js';
import { encodeStateHash, parseStateHash } from '../state/urlstate.js';
import { drawQr } from '../lib/qr.js';
import { buildBriefing } from './briefing.js';
import {
  logError,
  installGlobalHandlers,
  getErrorLog,
  formatErrorLog,
  clearErrorLog,
  onErrorLogChange,
} from '../lib/errors.js';
import {
  storage,
  saveFile as platformSaveFile,
  shareFile,
  haptic,
  hydrateFromNative,
  initNativeShell,
} from '../platform/index.js';
import { runSelfTest } from './selftest.js';
import { VERSION_LABEL } from './version.js';
import { PRIVACY_TITLE, PRIVACY_TEXT } from './privacy.js';
import { registerServiceWorker, initInstallBanner } from './pwa.js';

installGlobalHandlers();
registerServiceWorker();
initInstallBanner();

// ── Temperature display helpers ─────────────────────────────────────────────
// Internal storage & all ASHRAE math use °F (canonical input) / °C (math). The
// UI displays ONE unit at a time; state.tempUnit ∈ 'F' | 'C' | 'K'.
function tU() { return TEMP_UNITS[state.tempUnit || 'F']; }
const dispT  = f => tU().fromF(f);                    // °F → display number
const dispTs = f => Math.round(dispT(f)).toString();  // whole-number display
const tLabel = () => tU().label;
const dispDeltaT = dF => deltaFromF(dF, state.tempUnit || 'F');
const deltaLabel = () => deltaLabelFor(state.tempUnit || 'F');

// ── v1-compat helpers over the new core signatures ──────────────────────────
// The core's humidityRatio now takes (tc, rh, p) — the dry bulb is needed for
// the enhancement factor. These wrappers keep the extracted UI code readable
// where it already holds a vapour pressure.
const humidityRatioGPw = (pw, p, tc) => humidityRatioFromPw(pw, p, tc) * 1000;

/** Storage quota warning — shown once per session, not per keystroke. */
let quotaWarned = false;
function persistJSON(key, value) {
  const r = storage.setJSON(key, value);
  if (!r.ok && r.quota && !quotaWarned) {
    quotaWarned = true;
    toast('Device storage is full — changes are NOT being saved. Export a save file now to avoid losing work.', {
      kind: 'error',
      duration: 12000,
    });
  }
  return r.ok;
}

// User-added sites persist separately; merged with built-ins for the picker.
const SITES_KEY = 'sdc_psychro_custom_sites_v1';
let customSites = [];
function loadCustomSites() {
  const r = storage.getJSON(SITES_KEY, []);
  customSites = Array.isArray(r) ? r : [];
}
function persistCustomSites() {
  persistJSON(SITES_KEY, customSites);
}
// Full list (built-in + custom) for the picker — see src/config/sites.js.
function allSites() {
  return allSitesFor(customSites);
}

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
const state = {
  pressure: pressureFromAltitude(1066),
  aTemp: 68, aRH: 45,
  bTemp: 87, bRH: 28,
  showEnvelopes: true,
  // Per-boundary visibility — each can be toggled independently from the legend.
  visible: { Rec:true, A1:true, A2:true, A3:true, A4:true, SLA:true, plan:true, timepts:true, specvol:true, enthalpy:false, actual:false },

  tempUnit: 'F',   // 'F' | 'C' | 'K' — display only; default Fahrenheit

  // ── DATA HALL PROFILES: each is one physical facility — site, elevation,
  //    air volume, installed plant (capabilities + rates), real-world
  //    efficiency factor, and current capacity derates. Every building / hall
  //    gets its own profile; tabs switch between them. Separate from the
  //    customer SLAs below, which are pure contracts evaluated inside the
  //    ACTIVE hall. `state.hall` (defined below) is always the active profile.
  hallProfiles: [{
    name: 'PHX · Hall 1',
    siteName: 'Goodyear, AZ', building: '', elevFt: 1066, hallVolFt3: null, airflowCfm: null,
    canHeat: false, canDehumidify: false, canHumidify: false,
    rateCoolF: null, rateWarmF: null, rateDehumLb: null, rateHumLb: null,
    // Efficiency factor (%): predicted fraction of nameplate performance the
    // hall actually delivers (mixing losses, stratification, control deadbands,
    // sensor lag). 85% is the planning default; calibrate it from logged
    // predicted-vs-actual results.
    effPct: 85,
    // Current capacity derates (%): temporary reductions — chillers offline,
    // crusty evaporative media on the humidifiers, coils fouled. 100 = full.
    derateCoolPct: 100, derateWarmPct: 100, derateDehumPct: 100, derateHumPct: 100,
    // Logged predicted-vs-actual results for this hall (calibration data).
    results: [],
    calc: {},
  }],
  activeHall: 0,
  // Hall-tab view filter: which location / building the tab list is narrowed
  // to. Empty string = "All". Filters only narrow the visible tabs — the
  // active hall still drives every calculation.
  hallView: { loc: '', bld: '' },
  // SLA profiles now carry site identity (name + elevation) AND envelope +
  // ramp limits. The active profile's elevFt drives barometric pressure.
  // Preloaded with real Stream Data Centers campus elevations (ft).
  // dpMaxF null = no dew-point cap. maxDtHr/maxDrhHr = ASHRAE ramp limits.
  // Customer SLAs are pure contracts: envelope + ramp limits only. The Data
  // Hall above owns site, elevation, volume, and plant. dpMaxF null = no cap.
  slaProfiles: [
    { name:'Base SLA', tMinF:50, tMaxF:95, rhMin:5, rhMax:80, dpMaxF:null,  maxDtHr:18, maxDrhHr:20, locked:true },
    { name:'Customer 1 (ASHRAE A1)', tMinF:59, tMaxF:89.6, rhMin:8, rhMax:80, dpMaxF:62.6, maxDtHr:9, maxDrhHr:20 },
    { name:'Customer 2 (Recommended)', tMinF:64.4, tMaxF:80.6, rhMin:8, rhMax:60, dpMaxF:59, maxDtHr:9, maxDrhHr:20 },
  ],
  activeSla: 0,
};
// `state.hall` is ALWAYS the active hall profile — a live accessor, so every
// existing call site (physics, readouts, editors) transparently follows the
// tab switch. Assigning to state.hall replaces the active profile in place.
Object.defineProperty(state, 'hall', {
  get() { return this.hallProfiles[this.activeHall] || this.hallProfiles[0]; },
  set(h) { this.hallProfiles[Math.min(this.activeHall, this.hallProfiles.length - 1)] = h; },
});
// Convenience: the active profile's elevation is the live site elevation.

// Capability flags control DEGREES OF FREEDOM, not slider bounds. Temperature
// is always free (cooling lowers it; IT load / heating raises it — every hall
// can warm by backing off cooling). The MOISTURE levers decide whether RH is
// independent of temp or coupled to it along the constant-moisture line:
//   canDehumidify → can lower absolute moisture (push RH below the W-line)
//   canHumidify   → can raise absolute moisture (push RH above the W-line)
//   canHeat       → informational only (active reheat vs. load-driven warming)
// With BOTH moisture levers: temp & RH fully decoupled (any point in the box).
// With NEITHER: RH is locked to temp on the fixed-W line (move temp, RH follows).
// With ONE: RH is bounded on one side by the W-line (asymmetric control).
// Normalisation and the legacy (hall-data-on-SLA) migration live in
// src/state/schema.js so they are unit-tested. These thin wrappers bind them to
// the live state object.
function normalizeCaps(profiles) {
  return migrateLegacyProfiles(profiles, state.hall);
}

// ════════════════════════════════════════════════════════════
//  SITE / PRESSURE — driven by the active SLA profile's elevation
// ════════════════════════════════════════════════════════════
function applyElevation() {
  const ft = state.hall.elevFt ?? 0;
  state.pressure = pressureFromAltitude(ft);
  const inHg = state.pressure * 0.2953;
  const pr = document.getElementById('pressure-readout');
  if (pr) pr.innerHTML = `${state.pressure.toFixed(3)} kPa <span class="sub">(${inHg.toFixed(2)} inHg)</span>`;
  const fp = document.getElementById('fn-pressure');
  if (fp) fp.textContent = `${state.pressure.toFixed(3)} kPa`;
  const chipLabel = document.getElementById('chip-label');
  if (chipLabel) {
    const site = state.hall.siteName ? `${state.hall.siteName} · ` : '';
    chipLabel.textContent = `${site}${ft.toLocaleString()} ft`;
  }
  // keep the chip's editable field in sync (unless it's the one being typed in)
  const ei = document.getElementById('chip-elev-input');
  if (ei && document.activeElement !== ei) ei.value = ft;
}

// Elevation/site chip open/close
document.getElementById('chip-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('chip-panel').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const chip = document.getElementById('chip-panel');
  if (chip && chip.classList.contains('open') && !e.target.closest('.site-chip')) {
    chip.classList.remove('open');
  }
});
// Editable elevation directly in the chip — updates the active SLA profile
// and recomputes barometric pressure (and every humidity value) live.
document.getElementById('chip-elev-input').addEventListener('input', function() {
  // Accept a leading minus and digits; tolerate partial entry like "-" while typing.
  const raw = this.value.trim();
  if (raw === '' || raw === '-') return;          // wait for a real number
  let v = parseFloat(raw.replace(/[^0-9.-]/g, ''));
  if (isNaN(v)) return;
  v = Math.max(-15000, Math.min(20000, Math.round(v)));  // clamp to valid range
  state.hall.elevFt = v;
  applyElevation();
  const se = document.getElementById('hall-elev'); if (se && document.activeElement !== se) se.value = v;
  update();
});

// ════════════════════════════════════════════════════════════
//  COUPLED MOISTURE MODEL
//  CURRENT (point A) fixes the total moisture content W (no dehumidification).
//  TARGET (point B) rides that constant-W line: temp & RH are locked together.
//    - drag Target temp  → RH = rhFromW(temp, W_current)
//    - drag Target RH    → temp = tempForW_RH(W_current, RH)
//  Changing CURRENT redefines W, so Target's RH is recomputed at its temp.
// ════════════════════════════════════════════════════════════

// W (kg/kg) of the CURRENT point at site pressure — the fixed moisture line.
function currentW() {
  return humidityRatio(fToC(state.aTemp), state.aRH, state.pressure);
}
// RH (%) at a given °F on a fixed-W line — the core's enhanced-Eq.20 inversion.
function rhFromW_F(tempF, Wkg) {
  return Math.min(100, Math.max(0, rhFromW(fToC(tempF), Wkg, state.pressure)));
}

// RH (%) and vapor pressure at an arbitrary chart point (t °C, W g/kg) —
// inverse of the enhanced humidity ratio. Powers the hover inspector and
// the chart click-to-set controls.
function rhAtPoint(tc, hrG) {
  const Wkg = Math.max(0, hrG) / 1000;
  const pw = vaporPressureFromW(Wkg, state.pressure, tc);
  return { rh: pw / satPressure(tc) * 100, pw };
}

const clampF  = f => Math.max(32, Math.min(130, f));  // 32°F floor (chart anchored at freezing) · 130°F ceiling
const clampRH = r => Math.max(1, Math.min(100, r));

// Target temperature is bounded by the active SLA's allowed band, so you
// can't drive the target outside the contractual envelope. Temperature, RH,
// and dew point each move independently — dragging one never auto-adjusts
// another. (Plant capability still governs the TIME a move would take, via
// planMove() / the water-flag annotation — it just doesn’t lock the sliders.)
function clampTargetF(f) {
  const sla = state.slaProfiles[state.activeSla];
  const lo = Math.max(32,  sla.tMinF ?? 32);
  const hi = Math.min(130, sla.tMaxF ?? 130);
  return Math.max(lo, Math.min(hi, f));
}
// Dew point ↔ RH at a fixed dry-bulb (bijective; DP is the moisture truth-teller:
// constant DP = constant water, rising DP = adding water). dewPoint() is an
// exact Newton inversion of the saturation curve and rh_from_dpF is the same
// curve as a ratio, so the pair are exact inverses — the invariant the
// temperature slider depends on.
const dpF_from   = (tempF, rh)  => { const pw = vaporPressure(fToC(tempF), rh); return pw > 0 ? cToF(dewPoint(pw)) : -100; };
const rh_from_dpF = (tempF, dpF) => clampRH(satPressure(fToC(dpF)) / satPressure(fToC(tempF)) * 100);
// Dew point has its own slider bounds: it runs far below the 32°F dry-bulb
// floor (68°F at 1% RH dews out near −26°F), so clampF would pin the thumb and
// misreport dry air. Ceiling is the dry-bulb max — DP can never exceed it.
const clampDpF = f => Math.max(-40, Math.min(130, f));

// ── Temperature and dew point are the independent pair; RH is what they
//    produce. Heating or cooling air doesn't add or remove water, so moving
//    temperature holds the dew point and re-derives RH — the behaviour a
//    psychrometric chart shows as sliding along a constant-W line. Moving dew
//    point holds temperature and re-derives RH. Moving RH directly re-derives
//    dew point instead (RH is what's stored, so that falls out for free). ──
function setTempHoldingDp(key, newTempF) {
  const tKey = key === 'a' ? 'aTemp' : 'bTemp';
  const rKey = key === 'a' ? 'aRH'   : 'bRH';
  const dpF = dpF_from(state[tKey], state[rKey]);   // water content before the move
  state[tKey] = newTempF;
  // If the new temp falls below the dew point, RH pins at 100 and the dew
  // point follows the dry bulb down — you cannot hold water past saturation.
  state[rKey] = rh_from_dpF(newTempF, dpF);
}

// Push state into the four sliders + input boxes. `skipInput` is the id of an
// input box currently being typed in — it is left untouched so typing isn't
// disrupted. Sliders always receive the CLAMPED value (thumb stays in range)
// while input boxes show the true (possibly out-of-range) value.
function syncAllControls(skipInput) {
  // Target sliders are physically bounded to the active SLA's temp band so the
  // thumb can't be dragged into a dead zone that snaps back. Current sliders use
  // the full 32–160°F range.
  const sla = state.slaProfiles[state.activeSla];
  const bLo = Math.max(32, Math.round(clampF(sla.tMinF)));
  const bHi = Math.min(130, Math.round(clampF(sla.tMaxF)));
  const bt = document.getElementById('slider-b-temp');
  if (bt) { bt.min = bLo; bt.max = Math.max(bLo, bHi); }

  setControl('slider-a-temp', 'a-temp', 'slider-a-temp-val', state.aTemp, 'temp', skipInput);
  setControl('slider-a-rh',   'a-rh',   'slider-a-rh-val',   state.aRH,   'rh',   skipInput);
  setControl('slider-b-temp', 'b-temp', 'slider-b-temp-val', state.bTemp, 'temp', skipInput);
  setControl('slider-b-rh',   'b-rh',   'slider-b-rh-val',   state.bRH,   'rh',   skipInput);
  setControl('slider-a-dp', 'a-dp', null, dpF_from(state.aTemp, state.aRH), 'dp', skipInput);
  setControl('slider-b-dp', 'b-dp', null, dpF_from(state.bTemp, state.bRH), 'dp', skipInput);
  document.querySelectorAll('.tunit').forEach(el => el.textContent = tLabel());
}
function syncControlsExcept(skipInput) { syncAllControls(skipInput); }

function setControl(sliderId, inputId, valId, valF, kind, skipInput) {
  const slider = document.getElementById(sliderId);
  const input  = document.getElementById(inputId);
  const val    = document.getElementById(valId);
  // sliders are bounded; input boxes are free
  const sliderClampF = kind === 'dp' ? clampDpF
    : (sliderId.includes('-b-')) ? clampTargetF : clampF;
  if (kind === 'temp' || kind === 'dp') {
    if (slider) slider.value = Math.round(sliderClampF(valF));   // slider clamped
    if (input && inputId !== skipInput)  input.value  = dispTs(valF);  // box: true value
    if (val)    val.textContent = dispTs(valF) + ' ' + tLabel();
  } else {
    if (slider) slider.value = Math.round(clampRH(valF));
    if (input && inputId !== skipInput)  input.value  = Math.round(valF);
    if (val)    val.textContent = Math.round(valF) + ' %';
  }
}

// ── CURRENT sliders (independent; they redefine the moisture line) ──
// After changing CURRENT's W, recompute TARGET's RH at its current temp so the
// Target point stays physically on the new line.
function afterCurrentChange() {
  // Current's own point is self-consistent (RH sets W at its own temp).
  // Target is fully independent — changing Current never touches it.
  syncAllControls(); update();
}
document.getElementById('slider-a-temp').addEventListener('input', function() {
  setTempHoldingDp('a', clampF(parseFloat(this.value))); afterCurrentChange();
});
document.getElementById('slider-a-rh').addEventListener('input', function() {
  state.aRH = clampRH(parseFloat(this.value)); afterCurrentChange();
});

// ── TARGET sliders — fully independent. Each sets only its own value;
// dragging one never moves another. (DP is inherently derived from T & RH —
// setting DP directly adjusts RH at the CURRENT target temp, same as typing
// an RH value would; it does not touch temperature.)
document.getElementById('slider-b-temp').addEventListener('input', function() {
  setTempHoldingDp('b', clampTargetF(parseFloat(this.value)));
  syncAllControls(); update();
});
document.getElementById('slider-b-rh').addEventListener('input', function() {
  state.bRH = clampRH(parseFloat(this.value));
  syncAllControls(); update();
});

// ── Typed input boxes — independent, same as sliders. ──
document.getElementById('a-temp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  setTempHoldingDp('a', tU().toF(v));
  syncControlsExcept('a-temp'); update();
});
document.getElementById('a-rh').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.aRH = clampRH(v);
  syncControlsExcept('a-rh'); update();
});
document.getElementById('b-temp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  setTempHoldingDp('b', clampTargetF(tU().toF(v)));
  syncControlsExcept('b-temp'); update();
});
document.getElementById('b-rh').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.bRH = clampRH(v);
  syncControlsExcept('b-rh'); update();
});

// ── Dew point controls: DP sets RH at the fixed dry-bulb (temp untouched). ──
document.getElementById('slider-a-dp').addEventListener('input', function() {
  state.aRH = rh_from_dpF(state.aTemp, parseFloat(this.value));
  afterCurrentChange();
});
document.getElementById('a-dp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.aRH = rh_from_dpF(state.aTemp, tU().toF(v));
  syncControlsExcept('a-dp'); update();
});
document.getElementById('slider-b-dp').addEventListener('input', function() {
  state.bRH = clampRH(rh_from_dpF(state.bTemp, parseFloat(this.value)));
  syncAllControls(); update();
});
document.getElementById('b-dp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.bRH = clampRH(rh_from_dpF(state.bTemp, tU().toF(v)));
  syncControlsExcept('b-dp'); update();
});

// Back-compat shim: unit toggle calls syncTempInputs(); route to syncAllControls.
function syncTempInputs() { syncAllControls(); }

// Temperature unit toggle (°F / °C / K) — display only.
document.querySelectorAll('#unit-toggle .unit-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    state.tempUnit = this.dataset.unit;
    document.querySelectorAll('#unit-toggle .unit-btn').forEach(b => b.classList.toggle('active', b===this));
    syncTempInputs();
    renderSlaEditor(); // the SLA contract is edited in the display unit
    update();
  });
});

// ════════════════════════════════════════════════════════════
//  SENSOR VALIDATION SUITE — six external reference methods.
//  Readings are stored in °F (canonical) so the unit toggle re-displays
//  them without drift; pressure-dependent methods run at the active site
//  pressure, so an elevation change re-grades the sensor automatically.
//
//  Every method produces "true value ± reference uncertainty" and the
//  verdict band WIDENS by that uncertainty — a check can never claim more
//  confidence than its reference has. Bands are named constants, not
//  magic numbers scattered through render code.
// ════════════════════════════════════════════════════════════
const SV_TOL = {
  rhPass: 2, //     %RH — typical capacitive-sensor spec
  rhMarginal: 5, // %RH — beyond this: recalibrate
  tPassF: 0.9, //   °F (0.5 °C) — typical RTD/thermistor spec
  tMarginalF: 1.8, // °F (1.0 °C)
};

/**
 * Uncertainty-aware verdict. |err| is graded against pass/marginal bands
 * widened by the reference's own uncertainty, and the band actually used is
 * reported so the operator sees WHY a verdict was reached.
 * @returns {{cls:string, word:string, band:number}|null} null when no reading
 */
function svVerdict(err, pass, marginal, uRef = 0) {
  if (err == null || !isFinite(err)) return null;
  const passBand = pass + uRef;
  const marginalBand = marginal + uRef;
  const a = Math.abs(err);
  if (a <= passBand) return { cls: 'sv-pass', word: 'PASS', band: passBand };
  if (a <= marginalBand) return { cls: 'sv-marginal', word: 'MARGINAL', band: marginalBand };
  return { cls: 'sv-fail', word: 'FAIL', band: marginalBand };
}

/** One line of verdict HTML for an RH check. */
function svRhVerdictHtml(sensorRh, trueRh, uRef) {
  if (sensorRh == null) return '';
  const err = sensorRh - trueRh;
  const v = svVerdict(err, SV_TOL.rhPass, SV_TOL.rhMarginal, uRef);
  return `<br>Sensor reads ${sensorRh.toFixed(1)}% → error <span class="${v.cls}">${err >= 0 ? '+' : ''}${err.toFixed(1)}% RH · ${v.word}</span> <span class="cap-hint">(±${v.band.toFixed(1)} band incl. reference ±${uRef.toFixed(1)})</span>`;
}

/** One line of verdict HTML for a temperature check (all math in °F). */
function svTempVerdictHtml(sensorF, trueF, uRefF) {
  if (sensorF == null) return '';
  const errF = sensorF - trueF;
  const v = svVerdict(errF, SV_TOL.tPassF, SV_TOL.tMarginalF, uRefF);
  const disp = Math.round(dispDeltaT(errF) * 100) / 100;
  return `<br>Sensor error <span class="${v.cls}">${errF >= 0 ? '+' : ''}${disp}${deltaLabel()} · ${v.word}</span> <span class="cap-hint">(±${(Math.round(dispDeltaT(v.band) * 100) / 100)}${deltaLabel()} band incl. reference)</span>`;
}

const svState = {
  tab: 'psy',
  // psychrometer
  dbF: null, wbF: null, sensorRh: null, method: 'psy',
  // dew-point instrument
  dpDbF: null, dpDpF: null, dpRh: null,
  // salt chamber (saltUTc = how well the chamber temp is known, ±°C)
  saltId: 'nacl', saltTF: null, saltSensorRh: null, saltUTc: 0.5,
  // ice / boiling temperature checks
  iceTF: null, boilTF: null,
  // reference instrument comparison
  refQty: 'rh', refVal: null, refU: null, refReading: null,
};
// Which inverse to use — see rhFromPsychrometer() in the core. A real
// instrument reads the psychrometric wet bulb; Eq. 35 is the thermodynamic
// one. They differ by ~0.5 RH points, systematically.
const svRh = (tc, twb, p) => svState.method === 'thermo'
  ? rhFromWetBulb(tc, twb, p) : rhFromPsychrometer(tc, twb, p);
let svLastUnit = state.tempUnit;

// ── Ladder mode: big type + spoken verdicts, for when both hands are busy ──
// Feature-detected (speechSynthesis); off by default; local voices only.
let ladderOn = false;
let ladderLastSpoken = '';

/** Speak the verdict line just rendered — once per distinct verdict, so
 *  retyping a digit doesn't chant. Only while ladder mode is on. */
function ladderSpeak(resEl) {
  if (!ladderOn || !('speechSynthesis' in window)) return;
  const v = resEl.querySelector('.sv-pass, .sv-marginal, .sv-fail');
  if (!v) return;
  const text = v.textContent.trim();
  if (!text || text === ladderLastSpoken) return;
  ladderLastSpoken = text;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Display a stored °F reading in the active unit, one decimal, no trailing .0
const svFmtT = f => (Math.round(tU().fromF(f) * 10) / 10).toString();

/** Per-method renderers return {html, summary, canSetCurrent} for #sv-res. */
const SV_METHODS = {
  psy() {
    if (svState.dbF == null || svState.wbF == null)
      return { html: 'Enter dry-bulb and wet-bulb readings to compute RH.', summary: 'psychrometer' };
    const tc = fToC(svState.dbF), twbC = fToC(svState.wbF), p = state.pressure;
    const rh = svRh(tc, twbC, p);
    if (rh == null)
      return {
        html: '<span class="calc-warn">Wet bulb is above dry bulb — physically impossible. Check the wick is wet and the probes aren\'t swapped.</span>',
        summary: 'invalid reading',
      };
    const pw = vaporPressure(tc, rh);
    const W = humidityRatioGPw(pw, p, tc);
    const dpC = dewPoint(pw);
    const depF = svState.dbF - svState.wbF;
    // The instrument formulas are the reference here; their systematic spread
    // (~0.5 %RH between the two wet-bulb definitions) is the honest floor.
    const uRef = 0.5;
    return {
      html:
        `True RH <span class="sv-big">${rh.toFixed(1)}%</span>` +
        ` · dew point <strong>${dpC != null ? svFmtT(cToF(dpC)) + ' ' + tLabel() : '—'}</strong>` +
        ` · W <strong>${W.toFixed(2)} g/kg</strong>` +
        ` · depression ${(Math.round(dispDeltaT(depF) * 10) / 10)}${deltaLabel()}` +
        svRhVerdictHtml(svState.sensorRh, rh, uRef),
      summary: `${svFmtT(svState.dbF)}/${svFmtT(svState.wbF)}${tLabel()} → ${rh.toFixed(1)}% RH`,
      canSetCurrent: { tempF: svState.dbF, rh },
      loggable: svState.sensorRh != null
        ? { quantity: 'rh', ref: rh, u: uRef, reading: svState.sensorRh, err: svState.sensorRh - rh }
        : null,
    };
  },

  dp() {
    if (svState.dpDbF == null || svState.dpDpF == null)
      return { html: 'Enter dry-bulb and the instrument\'s dew-point reading.', summary: 'dew-point meter' };
    if (svState.dpDpF > svState.dpDbF + 1e-9)
      return {
        html: '<span class="calc-warn">Dew point above dry bulb is impossible — that air would already be condensing.</span>',
        summary: 'invalid reading',
      };
    const tc = fToC(svState.dpDbF), tdpC = fToC(svState.dpDpF);
    const rh = Math.min(100, Math.max(0, rhFromDewPoint(tc, tdpC)));
    // A maintained chilled mirror is reference-grade: ±0.2 °C dew point ≈
    // ±1 %RH at hall conditions; stated, not hidden.
    const uRef = 1.0;
    return {
      html:
        `True RH <span class="sv-big">${rh.toFixed(1)}%</span> from T<sub>dp</sub>` +
        ` <strong>${svFmtT(svState.dpDpF)}${tLabel()}</strong> at T<sub>db</sub> <strong>${svFmtT(svState.dpDbF)}${tLabel()}</strong>` +
        svRhVerdictHtml(svState.dpRh, rh, uRef),
      summary: `dew point → ${rh.toFixed(1)}% RH`,
      canSetCurrent: { tempF: svState.dpDbF, rh },
      loggable: svState.dpRh != null
        ? { quantity: 'rh', ref: rh, u: uRef, reading: svState.dpRh, err: svState.dpRh - rh }
        : null,
    };
  },

  salt() {
    if (svState.saltTF == null)
      return { html: 'Pick a salt and enter the chamber temperature.', summary: 'salt chamber' };
    const tc = fToC(svState.saltTF);
    const r = saltRh(svState.saltId, tc, svState.saltUTc);
    if (!r)
      return {
        html: `<span class="calc-warn">Outside the Greenspan tables' validity (${SALT_T_MIN_C}–${SALT_T_MAX_C} °C chamber temperature). Bring the chamber into range rather than extrapolating a calibration reference.</span>`,
        summary: 'out of range',
      };
    // The uncertainty is COMPUTED, and the breakdown is shown: a salt jar is
    // an absolute reference whose realized accuracy is set by temperature
    // knowledge — for NaCl that term is negligible (the gold standard for a
    // reason); for Mg(NO₃)₂ it dominates. Operators should see which regime
    // they are in, not a lumped number.
    const uTF = Math.round(dispDeltaT(svState.saltUTc * 1.8) * 10) / 10;
    return {
      html:
        `Equilibrium RH over ${r.salt.name}: <span class="sv-big">${r.rh.toFixed(1)}%</span>` +
        ` <span class="cap-hint">± ${r.u.toFixed(2)} — table ±${r.uTable.toFixed(2)} (Greenspan 1977) ⊕ temp ±${r.uTemp.toFixed(2)} (${r.slope.toFixed(2)} %RH/°C × ±${uTF}${deltaLabel()} chamber)</span>` +
        svRhVerdictHtml(svState.saltSensorRh, r.rh, r.u),
      summary: `${r.salt.name.split(' ')[0]} → ${r.rh.toFixed(1)}% RH`,
      loggable: svState.saltSensorRh != null
        ? { quantity: 'rh', ref: r.rh, u: r.u, reading: svState.saltSensorRh, err: svState.saltSensorRh - r.rh }
        : null,
    };
  },

  ice() {
    if (svState.iceTF == null)
      return { html: 'Enter the sensor\'s reading in the ice bath. Reference: 32.0 °F / 0.00 °C.', summary: 'ice point' };
    // A properly made slurry holds 0 °C to better than ±0.05 °C — call it ±0.1 °F.
    return {
      html:
        `Reference <span class="sv-big">${svFmtT(32)}${tLabel()}</span> <span class="cap-hint">(ice point, ±0.1 °F for a proper slurry)</span>` +
        svTempVerdictHtml(svState.iceTF, 32, 0.1),
      summary: 'ice-point temp check',
      loggable: { quantity: 'temp', ref: 32, u: 0.1, reading: svState.iceTF, err: svState.iceTF - 32 },
    };
  },

  boil() {
    const tBoilC = boilingPointC(state.pressure);
    const note = document.getElementById('sv-boil-note');
    if (tBoilC == null)
      return { html: '<span class="calc-warn">Site pressure is outside the boiling-reference window.</span>', summary: 'out of range' };
    const tBoilF = cToF(tBoilC);
    const uF = U_PRACTICAL_C * 1.8;
    if (note)
      note.textContent = `Rolling boil, probe mid-water off the pot. At this site's ${state.pressure.toFixed(2)} kPa, pure water boils at ${svFmtT(tBoilF)} ${tLabel()} — not ${svFmtT(cToF(100))} ${tLabel()}. Impurities and superheat limit a field check to about ±${(Math.round(dispDeltaT(uF) * 10) / 10)}${deltaLabel()}.`;
    if (svState.boilTF == null)
      return {
        html: `Boiling point at this site: <span class="sv-big">${svFmtT(tBoilF)}${tLabel()}</span> <span class="cap-hint">(${state.pressure.toFixed(2)} kPa · Hyland–Wexler, steam-table checked)</span>. Enter the sensor's reading.`,
        summary: `boils at ${svFmtT(tBoilF)}${tLabel()} here`,
      };
    return {
      html:
        `Reference <span class="sv-big">${svFmtT(tBoilF)}${tLabel()}</span> <span class="cap-hint">(boiling at ${state.pressure.toFixed(2)} kPa)</span>` +
        svTempVerdictHtml(svState.boilTF, tBoilF, uF),
      summary: 'boiling-point temp check',
      loggable: { quantity: 'temp', ref: tBoilF, u: uF, reading: svState.boilTF, err: svState.boilTF - tBoilF },
    };
  },

  ref() {
    const isRh = svState.refQty === 'rh';
    if (svState.refVal == null || svState.refReading == null)
      return { html: 'Enter the reference instrument\'s reading and the sensor\'s.', summary: 'reference compare' };
    const uRef = svState.refU ?? 1.0;
    if (isRh) {
      return {
        html:
          `Reference RH <span class="sv-big">${svState.refVal.toFixed(1)}%</span> <span class="cap-hint">± ${uRef.toFixed(1)} (certificate)</span>` +
          svRhVerdictHtml(svState.refReading, svState.refVal, uRef),
        summary: 'reference compare (RH)',
        loggable: { quantity: 'rh', ref: svState.refVal, u: uRef, reading: svState.refReading, err: svState.refReading - svState.refVal },
      };
    }
    // Temperature: inputs arrive in the ACTIVE unit; store/compare in °F.
    const refF = tU().toF(svState.refVal);
    const readF = tU().toF(svState.refReading);
    // The certificate states its uncertainty in the DISPLAY unit; convert that
    // delta to °F, where all verdict math lives.
    const uRefF = uRef / dispDeltaT(1);
    return {
      html:
        `Reference <span class="sv-big">${svFmtT(refF)}${tLabel()}</span> <span class="cap-hint">± ${uRef.toFixed(1)}${deltaLabel()} (certificate)</span>` +
        svTempVerdictHtml(readF, refF, uRefF),
      summary: 'reference compare (temp)',
      loggable: { quantity: 'temp', ref: refF, u: uRefF, reading: readF, err: readF - refF },
    };
  },
};

function renderSensorValidation() {
  const res = document.getElementById('sv-res');
  if (!res) return;
  const pEl = document.getElementById('sv-pressure');
  if (pEl) pEl.textContent = `${state.pressure.toFixed(2)} kPa`;

  // Re-display temp boxes only when the unit actually changed — never rewrite
  // a box mid-typing (values are exact in °F underneath regardless).
  if (state.tempUnit !== svLastUnit) {
    svLastUnit = state.tempUnit;
    [['sv-db', 'dbF'], ['sv-wb', 'wbF'], ['sv-dp-db', 'dpDbF'], ['sv-dp-dp', 'dpDpF'],
     ['sv-salt-t', 'saltTF'], ['sv-ice-t', 'iceTF'], ['sv-boil-t', 'boilTF']].forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el && el !== document.activeElement)
        el.value = svState[key] != null ? svFmtT(svState[key]) : '';
    });
  }

  const out = SV_METHODS[svState.tab]();
  res.innerHTML = out.html;
  ladderSpeak(res);
  const btn = document.getElementById('sv-to-current');
  if (btn) {
    btn.disabled = !out.canSetCurrent;
    btn.style.display = svState.tab === 'psy' || svState.tab === 'dp' ? '' : 'none';
  }
  const summary = document.getElementById('sv-summary');
  if (summary) summary.textContent = out.summary;
  svSetCurrent = out.canSetCurrent || null;
  svLoggable = out.loggable || null;
  const logBtn = document.getElementById('sv-log');
  if (logBtn) logBtn.disabled = !svLoggable;
}
let svSetCurrent = null;
let svLoggable = null;

// ── Drift logbook: every check, remembered per sensor ──────────────────────
const SENSOR_LOG_KEY = 'sdc_psychro_sensorlog_v1';
let sensorLog = [];

function loadSensorLog() {
  try {
    sensorLog = normalizeSensorLog(JSON.parse(storage.get(SENSOR_LOG_KEY) || '[]'));
  } catch {
    sensorLog = [];
  }
}
function persistSensorLog() {
  sensorLog = normalizeSensorLog(sensorLog);
  storage.set(SENSOR_LOG_KEY, JSON.stringify(sensorLog));
}

function renderSensorLogbook() {
  const host = document.getElementById('sv-logbook');
  if (!host) return;
  const sensors = [...new Set(sensorLog.map((e) => e.sensor))].sort();
  if (!sensors.length) {
    host.innerHTML =
      '<div class="sv-hint">No checks logged yet. Run any method with a sensor reading, name the sensor, and press “＋ Log check” — history turns single verdicts into a drift trend.</div>';
    return;
  }
  const sel = document.getElementById('svlog-sel');
  const selected = sensors.includes(sel?.value) ? sel.value : sensors[0];
  const entries = sensorLog.filter((e) => e.sensor === selected);
  const qty = entries[entries.length - 1].quantity;
  const scoped = entries.filter((e) => e.quantity === qty);
  const unit = qty === 'rh' ? '%RH' : '°F';
  const band = qty === 'rh' ? SV_TOL.rhMarginal : SV_TOL.tMarginalF;

  const rows = scoped
    .slice(-8)
    .map(
      (e) =>
        `<tr><td>${new Date(e.date).toLocaleDateString()}</td><td>${e.method}</td>` +
        `<td>${e.ref.toFixed(1)} ± ${e.u.toFixed(1)}</td><td>${e.reading.toFixed(1)}</td>` +
        `<td style="color:${Math.abs(e.err) <= band ? 'var(--ok)' : 'var(--danger)'}">${e.err >= 0 ? '+' : ''}${e.err.toFixed(2)}</td></tr>`,
    )
    .join('');

  const fit = driftFit(scoped, band);
  let driftLine = `<span class="cap-hint">${scoped.length} check${scoped.length === 1 ? '' : 's'} — two or more spread over time unlock the drift trend.</span>`;
  if (fit) {
    const drift = `${fit.perMonth >= 0 ? '+' : ''}${fit.perMonth.toFixed(2)} ${unit}/month`;
    const eta =
      fit.daysToBand === 0
        ? `<span class="sv-fail">outside the ±${band} band NOW — recalibrate</span>`
        : fit.daysToBand != null
          ? `~${Math.round(fit.daysToBand)} days to the ±${band} band`
          : `not heading for the ±${band} band on this trend`;
    driftLine = `Drift <strong>${drift}</strong> · ${eta} <span class="cap-hint">(linear extrapolation over ${fit.n} checks / ${Math.round(fit.spanDays)} days — a forecast, not a promise)</span>`;
  }

  host.innerHTML =
    `<div class="sla-field" style="margin:10px 0 6px"><label>Logbook — sensor</label>` +
    `<select id="svlog-sel" class="sla-select">${sensors.map((n) => `<option${n === selected ? ' selected' : ''}>${n.replace(/</g, '&lt;')}</option>`).join('')}</select></div>` +
    `<table class="svlog-table"><thead><tr><th>date</th><th>method</th><th>reference</th><th>read</th><th>err ${unit}</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="sv-hint">${driftLine}</div>` +
    `<div class="sv-actions"><button class="scn-btn" id="svlog-del">🗑 Delete this sensor's history</button></div>`;

  document.getElementById('svlog-sel').addEventListener('change', renderSensorLogbook);
  document.getElementById('svlog-del').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Delete history',
      message: `Delete all ${entries.length} logged check(s) for "${selected}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    sensorLog = sensorLog.filter((e) => e.sensor !== selected);
    persistSensorLog();
    renderSensorLogbook();
  });
}

document.getElementById('sv-log')?.addEventListener('click', () => {
  if (!svLoggable) return;
  const label = document.getElementById('sv-sensor-label')?.value.trim();
  if (!label) {
    toast('Name the sensor first (e.g. "CRAH-3 supply") so its history has a home.', { kind: 'warn' });
    document.getElementById('sv-sensor-label')?.focus();
    return;
  }
  sensorLog.push({
    sensor: label,
    method: svState.tab,
    quantity: svLoggable.quantity,
    ref: svLoggable.ref,
    u: svLoggable.u,
    reading: svLoggable.reading,
    err: svLoggable.err,
    date: new Date().toISOString(),
  });
  persistSensorLog();
  renderSensorLogbook();
  toast(`Logged for "${label}".`, { kind: 'ok' });
});

// ── Suite wiring: tabs, per-method inputs, shared actions ──────────────────
const SV_TABS = ['psy', 'dp', 'salt', 'ice', 'boil', 'ref'];
for (const tab of SV_TABS) {
  document.getElementById(`sv-tab-${tab}`).addEventListener('click', () => {
    svState.tab = tab;
    for (const t of SV_TABS) {
      document.getElementById(`sv-tab-${t}`).setAttribute('aria-selected', String(t === tab));
      document.getElementById(`sv-pane-${t}`).classList.toggle('active', t === tab);
    }
    renderSensorValidation();
  });
}

// The salt list comes from the reference module — the UI cannot drift from
// the data it grades against.
{
  const sel = document.getElementById('sv-salt-sel');
  for (const s of SALTS) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
  sel.value = svState.saltId;
  sel.addEventListener('change', () => {
    svState.saltId = sel.value;
    const note = document.getElementById('sv-salt-note');
    const salt = SALTS.find((s) => s.id === sel.value);
    if (note && salt) {
      const slope = saltRhSlope(sel.value, 25);
      note.textContent =
        `${salt.note} Temperature sensitivity ${slope.toFixed(2)} %RH/°C at 25 °C — ` +
        (Math.abs(slope) < 0.1
          ? 'nearly immune to chamber-temperature error; this is gold-standard territory.'
          : 'control and measure the chamber temperature; the uncertainty readout shows the cost.') +
        ' Sealed jar, slurry with visible solids, sensor above the slurry; hours to equilibrate. Reference: Greenspan (1977), NBS.';
    }
    renderSensorValidation();
  });
}

// Chamber-temp uncertainty: entered as a temperature DELTA in the active
// display unit, stored canonically in ±°C.
document.getElementById('sv-salt-ut').addEventListener('input', function () {
  const v = parseFloat(this.value);
  svState.saltUTc = isNaN(v) || v < 0 ? 0.5 : v / dispDeltaT(1) / 1.8;
  renderSensorValidation();
});

/** Wire a temperature input (active display unit → canonical °F). */
function svTempWire(id, key) {
  document.getElementById(id).addEventListener('input', function () {
    const v = parseFloat(this.value);
    svState[key] = isNaN(v) ? null : tU().toF(v);
    renderSensorValidation();
  });
}
/** Wire a plain numeric input (RH %, uncertainties). */
function svNumWire(id, key, lo = -Infinity, hi = Infinity) {
  document.getElementById(id).addEventListener('input', function () {
    const v = parseFloat(this.value);
    svState[key] = isNaN(v) ? null : Math.min(hi, Math.max(lo, v));
    renderSensorValidation();
  });
}

svTempWire('sv-db', 'dbF');
svTempWire('sv-wb', 'wbF');
svNumWire('sv-rh', 'sensorRh', 0, 100);
svTempWire('sv-dp-db', 'dpDbF');
svTempWire('sv-dp-dp', 'dpDpF');
svNumWire('sv-dp-rh', 'dpRh', 0, 100);
svTempWire('sv-salt-t', 'saltTF');
svNumWire('sv-salt-rh', 'saltSensorRh', 0, 100);
svTempWire('sv-ice-t', 'iceTF');
svTempWire('sv-boil-t', 'boilTF');
svNumWire('sv-ref-val', 'refVal');
svNumWire('sv-ref-u', 'refU', 0, 50);
svNumWire('sv-ref-reading', 'refReading');

document.getElementById('sv-method').addEventListener('change', function () {
  svState.method = this.value;
  renderSensorValidation();
});
document.getElementById('sv-ref-qty').addEventListener('change', function () {
  svState.refQty = this.value;
  const isRh = this.value === 'rh';
  document.getElementById('sv-ref-val-label').textContent = isRh
    ? 'Reference reads (RH %)' : 'Reference reads (temp)';
  document.getElementById('sv-ref-reading-label').textContent = isRh
    ? 'Sensor under test reads (RH %)' : 'Sensor under test reads (temp)';
  renderSensorValidation();
});
document.getElementById('sv-to-current').addEventListener('click', function () {
  if (!svSetCurrent) return;
  state.aTemp = clampF(svSetCurrent.tempF);
  state.aRH = clampRH(svSetCurrent.rh);
  syncAllControls();
  update();
});

// Ladder mode toggle — only shown where speech synthesis exists at all.
if ('speechSynthesis' in window) {
  const ladderBtn = document.getElementById('sv-ladder');
  if (ladderBtn) {
    ladderBtn.style.display = '';
    ladderBtn.addEventListener('click', () => {
      ladderOn = !ladderOn;
      ladderLastSpoken = ''; // re-announce the verdict on screen right now
      ladderBtn.setAttribute('aria-pressed', String(ladderOn));
      ladderBtn.classList.toggle('scn-btn-primary', ladderOn);
      document.getElementById('sv-res')?.classList.toggle('sv-ladder-on', ladderOn);
      if (!ladderOn) window.speechSynthesis.cancel();
      renderSensorValidation();
    });
  }
}

// ════════════════════════════════════════════════════════════
//  CHART
//  PC = full data extent (the "fit" view). view = live zoom window.
// ════════════════════════════════════════════════════════════
// Chart extent: anchored at freezing (0°C / 32°F) on the left, through the full
// ASHRAE A4 allowable ceiling on the right (45°C / 113°F). This frames the data-
// center operating range so envelopes fill the plot instead of floating in dead space.
const PC = { tMin:0, tMax:45, hrMin:0, hrMax:30 };
const view = { tMin:0, tMax:45, hrMin:0, hrMax:30 };  // mutated by zoom/pan
let lastGeom = null;  // {W,H,pad} from last drawChart, for hit-testing

function resetView() {
  view.tMin = PC.tMin; view.tMax = PC.tMax;
  view.hrMin = PC.hrMin; view.hrMax = PC.hrMax;
}

function toXY(tc, hr, W, H, pad) {
  const x = pad.l + (tc-view.tMin)/(view.tMax-view.tMin)*(W-pad.l-pad.r);
  const y = (H-pad.b) - (hr-view.hrMin)/(view.hrMax-view.hrMin)*(H-pad.t-pad.b);
  return [x,y];
}
// inverse: pixel → data (for zoom-at-cursor and pan)
function fromXY(px, py, W, H, pad) {
  const tc = view.tMin + (px-pad.l)/(W-pad.l-pad.r)*(view.tMax-view.tMin);
  const hr = view.hrMin + ((H-pad.b)-py)/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
  return [tc, hr];
}
// "nice" tick step for a given span and target tick count
// Decimal places needed so adjacent tick VALUES are actually distinguishable —
// scales with how fine the step gets, instead of capping out at a fixed
// precision (which made deep-zoom ticks show duplicate rounded numbers).
function decimalsFor(step) {
  if (!(step > 0)) return 0;
  return Math.max(0, Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)));
}
function tickStep(span, target) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

// Find a legible spot to label a curve, GIVEN THE CURRENT VIEWPORT — not a
// fixed data coordinate. Curves get zoomed/panned in and out of view, so a
// label anchored to one fixed point disappears whenever that point scrolls
// off-screen. Instead: sample the curve, find the longest run of points that
// actually falls inside the plot rectangle right now, and label its midpoint.
// Returns null if the curve isn't visible at all (correctly no label then).
function labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB) {
  const margin = 4; // keep labels off the very edge of the plot
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < pxPts.length; i++) {
    const [x, y] = pxPts[i];
    const inside = x >= plotL + margin && x <= plotR - margin && y >= plotT + margin && y <= plotB - margin;
    if (inside) {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen === 0) return null;
  const mid = bestStart + Math.floor(bestLen / 2);
  const [x, y] = pxPts[mid];
  // local slope for a faint text tilt so the label rides along the curve
  const a = pxPts[Math.max(0, mid - 3)], b = pxPts[Math.min(pxPts.length - 1, mid + 3)];
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  return { x, y, angle };
}
// Draw a label with a halo (outline) so it stays legible over grid lines,
// other curves, or shaded envelopes — regardless of what's underneath.
function haloText(ctx, text, x, y, color, angle) {
  ctx.save();
  ctx.translate(x, y);
  if (angle) ctx.rotate(angle);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(13,17,23,0.9)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawChart() {
  const p = state.pressure;
  const canvas = document.getElementById('psychCanvas');
  const dispW = canvas.parentElement.clientWidth || 800;
  const dpr = Math.min(2, window.devicePixelRatio||1);
  const W = dispW, H = Math.round(W*0.62);
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr);
  const pad = {l:52,r:58,t:20,b:42};
  lastGeom = { W, H, pad };
  const xy = (tc,hr) => toXY(tc,hr,W,H,pad);
  const fs = sz => Math.max(9, Math.round(W*sz));

  ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);

  // Clip everything to the plot rectangle so zoomed curves don't bleed out
  const plotL=pad.l, plotR=W-pad.r, plotT=pad.t, plotB=H-pad.b;
  ctx.save();
  ctx.beginPath(); ctx.rect(plotL, plotT, plotR-plotL, plotB-plotT); ctx.clip();

  // Tick steps from the live view span
  const tStep  = Math.max(1, tickStep(view.tMax - view.tMin, 9));
  const hrStep = Math.max(1, tickStep(view.hrMax - view.hrMin, 8));
  const tStart  = Math.ceil(view.tMin / tStep) * tStep;
  const hrStart = Math.ceil(view.hrMin / hrStep) * hrStep;

  // Grid
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=0.5;
  for(let t=tStart; t<=view.tMax; t+=tStep){const[x1,y1]=xy(t,view.hrMin),[x2,y2]=xy(t,view.hrMax);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}
  for(let hr=hrStart; hr<=view.hrMax; hr+=hrStep){const[x1,y1]=xy(view.tMin,hr),[x2,y2]=xy(view.tMax,hr);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();}

  // Freezing reference line (0°C / 32°F) — a hard operational boundary.
  // Vertical line at t=0°C; only visible if the view includes it.
  if (view.tMin <= 0 && view.tMax >= 0) {
    const [fx, fyTop] = xy(0, view.hrMax);
    const [, fyBot] = xy(0, view.hrMin);
    ctx.strokeStyle = 'rgba(120,170,255,0.35)'; ctx.lineWidth = 1.2; ctx.setLineDash([5,4]);
    ctx.beginPath(); ctx.moveTo(fx, fyTop); ctx.lineTo(fx, fyBot); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(120,170,255,0.6)'; ctx.font = `bold ${fs(0.0105)}px sans-serif`;
    ctx.textAlign = 'left'; ctx.save();
    ctx.translate(fx + 3, plotT + 4 + fs(0.05));
    ctx.fillText('FREEZING 32°F', 0, 0); ctx.restore();
  }

  // Drawing range follows the VISIBLE view (with margin) so curves fill out
  // toward "infinity" on the top and right rather than stopping at a fixed wall.
  const drawTmin = Math.max(PC.tMin, view.tMin - 2);
  const drawTmax = Math.min(MAX_T, view.tMax + 2);
  const drawHrMax = Math.min(MAX_HR, view.hrMax + 2);

  // ── Dynamic curve density: how many RH / wet-bulb lines actually fall in
  // the CURRENT viewport, so zooming in shows finer spacing instead of the
  // same fixed 10%/5° lines (which thin out to zero or one line visible).
  // Sample RH at the view's four corners — RH is monotonic in T (down) and
  // in humidity ratio (up), so the corners bound the range reliably.
  const rhAtCorner = (tc, hrG) =>
    Math.min(100, Math.max(0, rhAtPoint(tc, hrG).rh));
  const corners = [
    [view.tMin, view.hrMin], [view.tMin, view.hrMax],
    [view.tMax, view.hrMin], [view.tMax, view.hrMax],
  ];
  const cornerRH = corners.map(([tc, hr]) => rhAtCorner(tc, hr));
  const rhSpan = Math.max(0.5, Math.max(...cornerRH) - Math.min(...cornerRH));
  const rhStep = Math.max(1, Math.min(20, tickStep(rhSpan, 9)));
  const rhLo = Math.max(0, Math.floor(Math.min(...cornerRH) / rhStep) * rhStep - rhStep);
  const rhHi = Math.min(100, Math.ceil(Math.max(...cornerRH) / rhStep) * rhStep + rhStep);
  const rhList = [];
  for (let rh = rhLo; rh <= rhHi; rh += rhStep) rhList.push(Math.round(rh));
  if (!rhList.includes(80)) rhList.push(80);    // always keep the ASHRAE-ish warning line
  if (!rhList.includes(100)) rhList.push(100);  // always keep the saturation line
  rhList.sort((a,b)=>a-b);

  // Wet-bulb corners use the same viewport, solved via the exact Eq. 35 binary search.
  const wbAtCorner = (tc, hr) => wetBulb(tc, rhAtCorner(tc, hr), p);
  const cornerWB = corners.map(([tc, hr]) => wbAtCorner(tc, hr));
  const wbSpan = Math.max(0.5, Math.max(...cornerWB) - Math.min(...cornerWB));
  const wbStep = Math.max(1, Math.min(5, tickStep(wbSpan, 7)));
  const wbLo = Math.max(-10, Math.floor(Math.min(...cornerWB) / wbStep) * wbStep - wbStep);
  const wbHi = Math.min(50, Math.ceil(Math.max(...cornerWB) / wbStep) * wbStep + wbStep);

  // RH iso-curves (pressure-aware) — density adapts to the current zoom.
  rhList.forEach(rh => {
    const rhColor = rh===100?'rgba(100,180,255,0.85)':rh===80?'rgba(248,81,73,0.5)':`rgba(80,130,200,${0.15+rh*0.002})`;
    const rhLabelColor = rh===100?'#8fc4ff':rh===80?'#ff8a80':'#7fa8e0';
    ctx.strokeStyle = rhColor;
    ctx.lineWidth = (rh===80||rh===100)?1.6:0.7;
    ctx.beginPath(); let started=false;
    const tStepCurve = (drawTmax-drawTmin)/400;
    const pxPts = [];   // pixel points along this curve, for viewport-aware labeling
    for(let t=drawTmin;t<=drawTmax;t+=tStepCurve){
      const hr2=humidityRatioG(t,rh,p);
      const[x,y]=xy(t,hr2);
      pxPts.push([x,y]);
      if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);
      if(hr2>drawHrMax) break; // one point past the top; clip handles the trim
    }
    ctx.stroke();
    // Label wherever this curve is actually visible in the CURRENT viewport —
    // not a fixed data point — so it stays legible at any zoom/pan position.
    const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
    if (spot) {
      ctx.font = `bold ${fs(0.0115)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      haloText(ctx, rh+'%', spot.x, spot.y - 9, rhLabelColor, 0);
    }
  });

  // Wet-bulb iso-lines — EXACT ASHRAE Eq. 35, same physics as the table.
  // For a fixed wet-bulb twb, W at dry-bulb t is solved forward from Eq. 35:
  //   W = ((2501 − 2.326·twb)·Ws* − 1.006·(t − twb)) / (2501 + 1.86·t − 4.186·twb)   (t,twb ≥ 0°C)
  //   W = ((2830 − 0.24·twb)·Ws* − 1.006·(t − twb)) / (2830 + 1.86·t − 2.1·twb)       (twb < 0°C, over ice)
  // where Ws* = saturation humidity ratio at twb and site pressure.
  // Density (wbStep) adapts to the current zoom, same as the RH curves above.
  ctx.strokeStyle='rgba(120,180,120,0.16)'; ctx.lineWidth=0.6;
  ctx.font=`${fs(0.0095)}px sans-serif`;
  const wbDec = wbStep < 1 ? 1 : 0;
  for(let wb=wbLo; wb<=wbHi; wb+=wbStep){
    const WsStar = saturationHumidityRatio(wb, p); // kg/kg at the wet-bulb temp
    ctx.beginPath(); let s=false;
    const tStepWb=(drawTmax-wb)/200 || 0.4;
    const pxPtsWb = [];
    for(let t=wb; t<=drawTmax; t+=tStepWb){
      let W;
      if (wb >= 0)
        W = ((2501 - 2.326*wb)*WsStar - 1.006*(t - wb)) / (2501 + 1.86*t - 4.186*wb);
      else
        W = ((2830 - 0.24*wb)*WsStar - 1.006*(t - wb)) / (2830 + 1.86*t - 2.1*wb);
      const hrT = W*1000; // g/kg
      if(hrT < 0) break;
      const[x,y]=xy(t,hrT);
      pxPtsWb.push([x,y]);
      if(!s){ctx.moveTo(x,y);s=true;}else ctx.lineTo(x,y);
      if(hrT > drawHrMax) break;
    }
    ctx.stroke();
    // Label wherever this wet-bulb line is actually visible right now.
    if(s){
      const spot = labelSpotOnCurve(pxPtsWb, plotL, plotR, plotT, plotB);
      if (spot) {
        ctx.font = `${fs(0.0098)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        haloText(ctx, `${wb.toFixed(wbDec)}°wb`, spot.x, spot.y, 'rgba(150,210,150,0.85)', spot.angle);
      }
    }
  }

  // Constant specific-volume iso-lines (m³/kg dry air) — ASHRAE Eq. 26 solved
  // for W at fixed v:  W = (v·p/(Rda·T) − 1) / 1.607858.  Steeper than the RH
  // curves, so they read as a distinct family. Toggleable via the legend.
  if (state.visible.specvol) {
    const Rda = 0.287042;
    ctx.strokeStyle = 'rgba(210,180,120,0.22)'; ctx.lineWidth = 0.6;
    for (let v = 0.74; v <= 1.02 + 1e-9; v += 0.02) {
      ctx.beginPath(); let s = false; const pxPts = [];
      const tStepV = (drawTmax - drawTmin) / 200;
      for (let t = drawTmin; t <= drawTmax; t += tStepV) {
        const Tk = t + 273.15;
        const Wg = ((v * p / (Rda * Tk)) - 1) / 1.607858 * 1000; // g/kg
        if (Wg < -0.5) continue;
        const [x, y] = xy(t, Math.max(0, Wg));
        pxPts.push([x, y]);
        if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (s) {
        const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
        if (spot) { ctx.font = `${fs(0.0092)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          haloText(ctx, `${v.toFixed(2)} m³/kg`, spot.x, spot.y, 'rgba(216,192,136,0.9)', spot.angle); }
      }
    }
  }

  // Constant-enthalpy iso-lines (kJ/kg dry air) — chart GUIDES only, drawn from
  // ASHRAE Eq. 30's closed-form inverse. Displayed/tabulated h uses the RP-1485
  // fit in the core; the two differ by <0.5 kJ/kg, invisible at chart scale,
  // and the closed form is invertible per-pixel where the fit is not.
  // Eq. 30 solved for W at
  // fixed h:  W = (h − 1.006·t) / (2501 + 1.86·t).  Nearly parallel to the
  // wet-bulb lines (that's the psychrometrics), so OFF by default; legend-toggle.
  if (state.visible.enthalpy) {
    ctx.strokeStyle = 'rgba(170,140,230,0.24)'; ctx.lineWidth = 0.6;
    for (let hh = 0; hh <= 140; hh += 10) {
      ctx.beginPath(); let s = false; const pxPts = [];
      const tStepH = (drawTmax - drawTmin) / 200;
      for (let t = drawTmin; t <= drawTmax; t += tStepH) {
        const Wg = (hh - 1.006 * t) / (2501 + 1.86 * t) * 1000; // g/kg
        if (Wg < -0.5) continue;
        const [x, y] = xy(t, Math.max(0, Wg));
        pxPts.push([x, y]);
        if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y);
        if (Wg > drawHrMax) break;
      }
      ctx.stroke();
      if (s) {
        const spot = labelSpotOnCurve(pxPts, plotL, plotR, plotT, plotB);
        if (spot) { ctx.font = `${fs(0.0092)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          haloText(ctx, `${hh} kJ/kg`, spot.x, spot.y, 'rgba(184,166,232,0.9)', spot.angle); }
      }
    }
  }

  // Envelopes (generated from constraints, pressure-aware)
  function drawPolygon(pts,color,lw,label,dash,alpha){
    if(dash) ctx.setLineDash([4,3]); else ctx.setLineDash([]);
    ctx.strokeStyle=color; ctx.lineWidth=lw;
    ctx.globalAlpha=alpha!=null?alpha:0.06; ctx.fillStyle=color;
    ctx.beginPath(); const[sx,sy]=xy(pts[0][0],pts[0][1]); ctx.moveTo(sx,sy);
    pts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=1;
    ctx.beginPath(); const[sx2,sy2]=xy(pts[0][0],pts[0][1]); ctx.moveTo(sx2,sy2);
    pts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    if(label){
      // Label wherever the boundary is actually visible right now, not a fixed
      // vertex — so it stays legible at any zoom/pan position, same as curves.
      const pxPtsPoly = pts.map(pt => xy(pt[0], pt[1]));
      const spot = labelSpotOnCurve(pxPtsPoly, plotL, plotR, plotT, plotB);
      if (spot) {
        ctx.font = `bold ${fs(0.013)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        haloText(ctx, label, spot.x, spot.y, color, 0);
      }
    }
  }

  // ASHRAE envelopes — each drawn only if individually visible
  ['A4','A3','A2','A1'].forEach(k=>{
    if (!state.visible[k]) return;
    const e=ASHRAE_ENVELOPES[k];
    drawPolygon(envelopePolygon(e,p), e.color, e.lw, e.label, false);
  });
  if (state.visible.Rec) {
    const rec=ASHRAE_ENVELOPES.Rec;
    drawPolygon(envelopePolygon(rec,p),'rgba(255,255,255,0.5)',1.4,'Rec',true,0.04);
  }

  // ── Active SLA (bold white) — toggleable ─────────────────
  const sla = state.slaProfiles[state.activeSla];
  if (state.visible.SLA) {
  const slaPts = slaPolygon(sla, p);
  ctx.setLineDash([6,4]); ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=2.2;
  ctx.globalAlpha=0.05; ctx.fillStyle='#ffffff';
  ctx.beginPath(); let[s0x,s0y]=xy(slaPts[0][0],slaPts[0][1]); ctx.moveTo(s0x,s0y);
  slaPts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1;
  ctx.beginPath(); [s0x,s0y]=xy(slaPts[0][0],slaPts[0][1]); ctx.moveTo(s0x,s0y);
  slaPts.slice(1).forEach(pt=>{const[ex,ey]=xy(pt[0],pt[1]);ctx.lineTo(ex,ey);}); ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  // SLA label — wherever the boundary is actually visible right now.
  const slaPxPts = slaPts.map(pt => xy(pt[0], pt[1]));
  const slaSpot = labelSpotOnCurve(slaPxPts, plotL, plotR, plotT, plotB);
  if (slaSpot) {
    ctx.font = `bold ${fs(0.012)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    haloText(ctx, 'SLA', slaSpot.x, slaSpot.y, 'rgba(255,255,255,0.9)', 0);
  }
  } // end SLA visibility

  // Points
  const tcA=fToC(state.aTemp), hrA=humidityRatioG(tcA,state.aRH,p);
  // ── Actual trajectory from an imported BMS trend (legend-toggleable) ──
  // Drawn beneath the plan line and the points: reality is context, the plan
  // is the argument.
  if (state.visible.actual && actualTrail && actualTrail.rows.length > 1) {
    ctx.strokeStyle = 'rgba(57,210,192,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    actualTrail.rows.forEach((r, i) => {
      const tcR = fToC(r.tempF);
      const [px, py] = xy(tcR, humidityRatioG(tcR, r.rh, p));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
    const end = actualTrail.rows[actualTrail.rows.length - 1];
    const tcE = fToC(end.tempF);
    const [ex, ey] = xy(tcE, humidityRatioG(tcE, end.rh, p));
    ctx.beginPath(); ctx.arc(ex, ey, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#39d2c0'; ctx.fill();
    ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  const[axp,ayp]=xy(tcA,hrA);
  const tcB=fToC(state.bTemp), hrB=humidityRatioG(tcB,state.bRH,p);
  const[bxp,byp]=xy(tcB,hrB);

  // ── A→B change plan line + arrow (toggleable) ──
  if (state.visible.plan) {
    ctx.strokeStyle='rgba(255,110,240,0.6)'; ctx.lineWidth=1.5; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(axp,ayp); ctx.lineTo(bxp,byp); ctx.stroke(); ctx.setLineDash([]);
    const dist=Math.sqrt((bxp-axp)**2+(byp-ayp)**2);
    if(dist>12){
      const ang=Math.atan2(byp-ayp,bxp-axp); ctx.fillStyle='rgba(255,110,240,0.8)';
      ctx.beginPath(); ctx.moveTo(bxp,byp);
      ctx.lineTo(bxp-10*Math.cos(ang-0.38),byp-10*Math.sin(ang-0.38));
      ctx.lineTo(bxp-10*Math.cos(ang+0.38),byp-10*Math.sin(ang+0.38));
      ctx.closePath(); ctx.fill();
    }

    // ── Hourly time-points along the move, paced by the core planner ──
    // Same SLA-limit × plant-capacity model as the readout, so they agree.
    if (state.visible.timepts) {
      const totalH = planMove().hours;
      if (totalH > 0 && dist > 20) {
        // place a tick at each whole hour (the per-hour ramp boundary)
        const nTicks = Math.floor(totalH);
        ctx.fillStyle='rgba(255,110,240,0.95)'; ctx.strokeStyle='#0d1117';
        ctx.font=`bold ${fs(0.0092)}px monospace`; ctx.textAlign='center';
        for (let h=1; h<=nTicks; h++) {
          const f = h / totalH;                       // fraction along A→B
          const px = axp + (bxp-axp)*f, py = ayp + (byp-ayp)*f;
          ctx.beginPath(); ctx.arc(px,py,3.5,0,Math.PI*2); ctx.fill();
          ctx.lineWidth=1; ctx.stroke();
          ctx.fillStyle='rgba(255,150,245,0.85)';
          ctx.fillText(`${h}h`, px, py-7);
          ctx.fillStyle='rgba(255,110,240,0.95)';
        }
        // total-time label at the midpoint, offset perpendicular to the line
        const mx=(axp+bxp)/2, my=(ayp+byp)/2;
        const ang=Math.atan2(byp-ayp,bxp-axp);
        const ox=Math.sin(ang)*14, oy=-Math.cos(ang)*14;
        ctx.fillStyle='rgba(255,150,245,0.9)'; ctx.font=`bold ${fs(0.0105)}px sans-serif`;
        ctx.fillText(`≈ ${fmtHrs(totalH)}`, mx+ox, my+oy);
      }
    }

    // ── Ramp-playback marker: the hall "now", scrubbed or animated ──
    // Same pixel-space interpolation as the pacing ticks above, so the marker
    // rides exactly the line the ticks sit on.
    if (playback.f > 0) {
      const px = axp + (bxp - axp) * playback.f, py = ayp + (byp - ayp) * playback.f;
      ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,110,240,1)'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  function drawDot(cx,cy,color,top,bot,above){
    ctx.beginPath(); ctx.arc(cx,cy,7,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
    ctx.strokeStyle='#0d1117'; ctx.lineWidth=2; ctx.stroke();
    const ly = above?cy-13:cy+20;
    ctx.fillStyle=color; ctx.font=`bold ${fs(0.013)}px sans-serif`; ctx.textAlign='center'; ctx.fillText(top,cx,ly);
    ctx.font=`${fs(0.010)}px sans-serif`; ctx.fillStyle=color+'aa'; ctx.fillText(bot,cx,ly+12);
  }
  drawDot(axp,ayp,'#ffff00',`A  ${state.aRH.toFixed(0)}% RH`,`${Math.round(state.aTemp)}°F / ${Math.round(tcA)}°C`,true);
  drawDot(bxp,byp,'#f0a500',`B  ${state.bRH.toFixed(0)}% RH`,`${Math.round(state.bTemp)}°F / ${Math.round(tcB)}°C`,byp>ayp+20);

  // End clip — axes/labels live in the margins, outside the plot rect
  ctx.restore();

  // Axes
  ctx.strokeStyle='rgba(255,255,255,0.3)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(pad.l,pad.t); ctx.lineTo(pad.l,H-pad.b); ctx.lineTo(W-pad.r,H-pad.b); ctx.stroke();
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.font=`${fs(0.012)}px monospace`; ctx.textAlign='center';
  const tStep2  = Math.max(1, tickStep(view.tMax - view.tMin, 9));
  const hrStep2 = Math.max(1, tickStep(view.hrMax - view.hrMin, 8));
  const tDec  = decimalsFor(tStep2);
  const hrDec = decimalsFor(hrStep2);
  for(let t=Math.ceil(view.tMin/tStep2)*tStep2; t<=view.tMax; t+=tStep2){
    const[x]=xy(t,view.hrMin);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.beginPath();ctx.moveTo(x,H-pad.b);ctx.lineTo(x,H-pad.b+4);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.4)';ctx.fillText(t.toFixed(tDec),x,H-pad.b+15);
  }
  ctx.textAlign='right';
  for(let hr=Math.ceil(view.hrMin/hrStep2)*hrStep2; hr<=view.hrMax; hr+=hrStep2){
    const[,y]=xy(view.tMin,hr);
    ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.8;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l-4,y);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.4)';ctx.fillText(hr.toFixed(hrDec),pad.l-6,y+4);
  }
  ctx.fillStyle='rgba(255,255,255,0.4)'; ctx.font=`${fs(0.013)}px sans-serif`; ctx.textAlign='center';
  ctx.fillText('Dry Bulb Temperature (°C)',pad.l+(W-pad.l-pad.r)/2,H-5);
  ctx.save(); ctx.translate(14,pad.t+(H-pad.t-pad.b)/2); ctx.rotate(-Math.PI/2); ctx.textAlign='center'; ctx.fillText('Humidity Ratio g/kg dry air',0,0); ctx.restore();

  // Pressure stamp + zoom indicator (top-left)
  ctx.fillStyle='rgba(240,165,0,0.7)'; ctx.font=`bold ${fs(0.012)}px monospace`; ctx.textAlign='left';
  const trunc = (s, n) => { s = s || ''; return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const stampCtx = [trunc(state.hall.name, 22), trunc(state.slaProfiles[state.activeSla].name, 22)].filter(Boolean).join(' · ');
  ctx.fillText(`${stampCtx}${stampCtx ? ' · ' : ''}${(state.hall.elevFt ?? 0).toLocaleString()} ft · ${p.toFixed(2)} kPa`, pad.l+6, pad.t+14);
  const zoomed = !(view.tMin===PC.tMin && view.tMax===PC.tMax && view.hrMin===PC.hrMin && view.hrMax===PC.hrMax);
  if (zoomed) {
    const zx = (PC.tMax-PC.tMin)/(view.tMax-view.tMin);
    ctx.fillStyle='rgba(59,158,255,0.85)';
    ctx.fillText(`⊕ ${zx.toFixed(1)}× — scroll/pinch to zoom · drag to pan · dbl-click to reset`, pad.l+6, pad.t+28);
  }
}

// ════════════════════════════════════════════════════════════
//  TABLE
// ════════════════════════════════════════════════════════════
function buildTable() {
  const p = state.pressure;
  const pts = [
    {label:'● A (start)',cls:'row-a',dot:'#ffff00',temp:state.aTemp,rh:state.aRH},
    {label:'● B (target)',cls:'row-b',dot:'#f0a500',temp:state.bTemp,rh:state.bRH},
  ];
  // One derivation per point, shared with the readout, hover and export — see
  // src/core/derive.js. Field aliases keep the existing row template readable.
  const derived = pts.map(pt => {
    const d = deriveStateF(pt.temp, pt.rh, p);
    return { ...pt, ...d, ah: d.absHum, dp: d.tdpC, wb: d.twbC, W: d.Wg };
  });
  const fmt=(n,d)=>(isNaN(n)||n===null)?'—':n.toFixed(d);
  const rhCls=rh=>rh>80?'rh-bad':rh>60?'rh-warn':'rh-ok';
  const tbody=document.getElementById('tableBody'); tbody.innerHTML='';
  derived.forEach(d=>{
    const tr=document.createElement('tr'); tr.className=d.cls;
    tr.innerHTML=`
      <td style="color:${d.dot};font-weight:700">${d.label}</td>
      <td>${fmt(d.temp,1)}</td><td>${fmt(d.tc,1)}</td>
      <td class="${rhCls(d.rh)}">${fmt(d.rh,1)}</td>
      <td>${fmt(d.pws,4)}</td><td>${fmt(d.pw,4)}</td>
      <td>${fmt(d.W,2)}</td><td>${fmt(d.ah,2)}</td>
      <td>${d.dp!==null?fmt(cToF(d.dp),1):'—'}</td><td>${fmt(cToF(d.wb),1)}</td>
      <td>${fmt(d.h,1)}</td><td>${fmt(d.v,4)}</td>
      <td><span class="zpill z${d.zone}">${d.zone}</span></td>`;
    tbody.appendChild(tr);
  });
  const[a,b]=derived;
  function delta(va,vb,dec,unit=''){
    if(va===null||vb===null||isNaN(va)||isNaN(vb))return '—';
    const d=vb-va,sign=d>=0?'+':''; const cls=d>0.001?'delta-pos':d<-0.001?'delta-neg':'';
    return `<span class="${cls}">${sign}${d.toFixed(dec)}${unit}</span>`;
  }
  const tr2=document.createElement('tr'); tr2.className='row-delta';
  tr2.innerHTML=`
    <td style="color:rgba(255,110,240,0.8);font-weight:600">Δ B − A</td>
    <td>${delta(a.temp,b.temp,1)}</td><td>${delta(a.tc,b.tc,1)}</td>
    <td>${delta(a.rh,b.rh,1,'%')}</td>
    <td>${delta(a.pws,b.pws,4)}</td><td>${delta(a.pw,b.pw,4)}</td>
    <td>${delta(a.W,b.W,2)}</td><td>${delta(a.ah,b.ah,2)}</td>
    <td>${(a.dp!==null&&b.dp!==null)?delta(cToF(a.dp),cToF(b.dp),1):'—'}</td>
    <td>${delta(cToF(a.wb),cToF(b.wb),1)}</td>
    <td>${delta(a.h,b.h,1)}</td><td>${delta(a.v,b.v,4)}</td><td>—</td>`;
  tbody.appendChild(tr2);
}


// The core planner (src/core/planner.js) is pure; this binds it to live state.
function planMove(opts) {
  return rampPlanCore({
    sla: state.slaProfiles[state.activeSla],
    hall: state.hall,
    aTempF: state.aTemp, aRH: state.aRH,
    bTempF: state.bTemp, bRH: state.bRH,
    p: state.pressure,
  }, opts);
}

// ════════════════════════════════════════════════════════════
//  BADGES
// ════════════════════════════════════════════════════════════
// Check a point against the ACTIVE SLA. The contract logic itself lives in
// src/core/envelopes.js (tested); this only binds it to the current profile.
function checkSLA(tempF, rh) {
  return checkSLACore(state.slaProfiles[state.activeSla], tempF, rh);
}

/**
 * Format a checkSLA verdict's violated bound in the ACTIVE display unit.
 * The core returns the bound as data (canonical °F / %); the string an
 * operator reads must follow their unit toggle.
 */
function fmtSlaReason(chk) {
  if (chk.ok) return 'within SLA';
  const t = (f) => `${dispTs(f)} ${tLabel()}`;
  switch (chk.kind) {
    case 'tMin': return `T below ${t(chk.bound)}`;
    case 'tMax': return `T above ${t(chk.bound)}`;
    case 'rhMin': return `RH below ${chk.bound}%`;
    case 'rhMax': return `RH above ${chk.bound}%`;
    case 'dpMax': return `dew point above ${t(chk.bound)}`;
    default: return chk.detail || 'out of SLA';
  }
}

// Merged readout: big RH→RH headline + collapsible computed details for both points.
let resultsExpanded = false;  // persists across re-renders

function updateControlReadout() {
  const p = state.pressure;
  const el = document.getElementById('control-readout');
  if (!el) return;

  // Shared derivation (src/core/derive.js); `W` is g/kg here as the copy reads.
  function props(tempF, rh) {
    const d = deriveStateF(tempF, rh, p);
    return { ...d, W: d.Wg, dpF: d.tdpF, wbF: d.twbF };
  }
  const A = props(state.aTemp, state.aRH);
  const B = props(state.bTemp, state.bRH);

  const dT = B.tempF - A.tempF;
  const dRH = B.rh - A.rh;
  const dW = B.W - A.W;
  const cls = Math.abs(dRH) < 0.5 ? 'cr-flat' : dRH < 0 ? 'cr-drop' : 'cr-rise';
  const verb = Math.abs(dRH) < 0.5 ? 'holds' : dRH < 0 ? 'falls' : 'climbs';
  const sameMoisture = Math.abs(dW) < 0.15;
  // Water flag beside the Target controls — the at-a-glance moisture truth.
  const wf = document.getElementById('wflag');
  if (wf) {
    if (Math.abs(dW) >= 0.15) {
      wf.textContent = `${dW > 0 ? '＋' : '−'}${Math.abs(dW).toFixed(1)} g/kg water`;
      wf.className = 'ctl-flag ' + (dW > 0 ? 'wf-add' : 'wf-rem');
    } else { wf.textContent = ''; wf.className = 'ctl-flag'; }
  }
  const sgn = v => (v >= 0 ? '+' : '');
  const U = tLabel();
  const dDT = dispDeltaT(dT), dU = deltaLabel();
  const tempPhrase = Math.abs(dT) < 0.5 ? 'holding temperature'
    : dT > 0 ? `raising temp ${Math.round(Math.abs(dDT))}${dU}` : `lowering temp ${Math.round(Math.abs(dDT))}${dU}`;

  const lede = (sameMoisture && Math.abs(dT) >= 0.5)
    ? 'Move on the moisture line — temperature drives RH'
    : 'Planned move — current → target';
  const note = sameMoisture && Math.abs(dT) >= 0.5
    ? `${tempPhrase}, no water added or removed`
    : `${tempPhrase}, ${Math.abs(dW) >= 0.15 ? `${dW > 0 ? 'adding' : 'removing'} moisture (${Math.abs(dW).toFixed(1)} g/kg)` : `Δ ${sgn(dRH)}${Math.round(dRH)} pts RH`}`;

  const openCls = resultsExpanded ? ' open' : '';
  const row = (k, v) => `<div class="result-row"><span class="rk">${k}</span><span class="rv">${v}</span></div>`;
  const detailCol = (title, P, color) => `
    <div class="detail-col">
      <div class="detail-title" style="color:${color}">${title}</div>
      ${row('Dry-bulb', `${dispTs(P.tempF)} ${U}`)}
      ${row('RH', `${Math.round(P.rh)} %`)}
      ${row('Humidity ratio', `${P.W.toFixed(2)} g/kg`)}
      ${row('Dew point', P.dpF!=null?`${dispTs(P.dpF)} ${U}`:'—')}
      ${row('Wet bulb', `${dispTs(P.wbF)} ${U}`)}
      ${row('Enthalpy', `${P.h.toFixed(1)} kJ/kg`)}
    </div>`;

  // ── Ramp-rate advisory ──────────────────────────────────────
  // SLA caps change per hour (e.g. 18°F/hr, 20%RH/hr). The minimum safe
  // transition time is whichever variable needs longer: max(|ΔT|/rateT, |ΔRH|/rateRH).
  // Ramp limits are stored in °F/hr; display converts the magnitude only.
  const sla = state.slaProfiles[state.activeSla];
  const absDT = Math.abs(dT), absDRH = Math.abs(dRH);
  let rampHtml = '';
  if (absDT >= 0.05 || absDRH >= 0.05) {
    const plan = planMove();
    const minHrs = plan.hours;
    const capBits = [];
    if (plan.tempCap)  capBits.push(`${plan.tempCap.label} ${dispDeltaT(plan.tempCap.rate).toFixed(1).replace(/\.0$/,'')}${dU}/hr`);
    if (plan.moistCap) capBits.push(`${plan.moistCap.label} ${plan.moistCap.rate.toFixed(1).replace(/\.0$/,'')} lb/hr`);
    // Real-world factors line — only shown when something departs from 100%.
    const effP = Math.round(state.hall.effPct ?? 100);
    const derBits = [
      ['derateCoolPct','cool'], ['derateWarmPct','warm'],
      ['derateDehumPct','dehum'], ['derateHumPct','hum'],
    ].filter(([k]) => (state.hall[k] ?? 100) < 100)
     .map(([k, lbl]) => `${lbl} ${Math.round(state.hall[k])}%`);
    const factorRow = (effP !== 100 || derBits.length)
      ? `<div class="ramp-row"><span class="ramp-k">Real-world factors</span><span class="ramp-v">eff ${effP}%${derBits.length ? ' · capacity: ' + derBits.join(' · ') : ''}</span></div>`
      : '';
    const waterRow = plan.moistCap && plan.moistCap.waterLb != null
      ? `<div class="ramp-row"><span class="ramp-k">Water to ${plan.moistCap.label==='Dehum'?'remove':'add'}</span><span class="ramp-v">${plan.moistCap.waterLb.toFixed(plan.moistCap.waterLb<10?1:0)} lb (${(plan.moistCap.waterLb*0.4536).toFixed(plan.moistCap.waterLb<10?1:0)} kg)</span></div>`
      : '';
    const volHint = plan.needsVol
      ? `<div class="ramp-foot" style="color:var(--warn)">Set the hall volume in the Data Hall panel to time the moisture work (mass balance needs it).</div>`
      : '';
    const rateHint = plan.needsTempRate
      ? `<div class="ramp-foot" style="color:var(--warn)">Enter a ${dDT < 0 ? 'cooling' : 'warming'} rate in the Data Hall panel to time this move — right now the estimate has nothing to stand on.</div>`
      : '';
    const capRow = capBits.length
      ? `<div class="ramp-row"><span class="ramp-k">Plant capacity${(effP !== 100 || derBits.length) ? ' (effective)' : ''}</span><span class="ramp-v">${capBits.join(' · ')}</span></div>`
      : '';
    // "Achievable" is a promise — never make it while plant data is missing.
    const ok = minHrs <= 1 && !plan.needsTempRate && !plan.needsVol;
    const rampLimT = sla.maxDtHr != null ? `${dispDeltaT(sla.maxDtHr).toFixed(0)}${dU}/hr` : '—';
    rampHtml = `
      <div class="ramp-advisory">
        <div class="ramp-row">
          <span class="ramp-k">Total change</span>
          <span class="ramp-v">${sgn(dDT)}${dDT.toFixed(0)}${dU} · ${sgn(dRH)}${dRH.toFixed(0)}% RH</span>
        </div>
        <div class="ramp-row">
          <span class="ramp-k">SLA ramp limit</span>
          <span class="ramp-v">${rampLimT} · ${sla.maxDrhHr??'—'}%RH/hr</span>
        </div>
        ${capRow}
        ${factorRow}
        ${waterRow}
        <div class="ramp-row ramp-reco ${ok?'':'ramp-warn'}">
          <span class="ramp-k">Estimated time</span>
          <span class="ramp-v">${minHrs<=0?'immediate':`≥ ${fmtHrs(minHrs)}`}${minHrs>0?` <span class="ramp-bind">(${plan.binding})</span>`:''}</span>
        </div>
        ${ok
          ? `<div class="ramp-foot ramp-ok">✓ Achievable within about an hour</div>`
          : plan.needsTempRate || plan.needsVol
            ? ''
            : `<div class="ramp-foot ramp-bad">⏱ Plan ≥ ${fmtHrs(minHrs)} — ${plan.binding} is the constraint${plan.binding.startsWith('SLA')?` (${sla.name})`:''}</div>`}
        ${volHint}
        ${rateHint}
      </div>`;
  }

  // ── Capability annotation: informational — describes the hall's moisture
  // plant. Sliders are always independent; this just tells you what it would
  // take (equipment-wise) to actually execute the Target you've set.
  const deh = !!state.hall.canDehumidify, hum = !!state.hall.canHumidify;
  const cs = document.getElementById('couple-sub');
  if (cs) cs.textContent = (deh && hum) ? 'full moisture control'
    : (!deh && !hum) ? 'no moisture control — plan by cooling/warming only'
    : deh ? 'can dehumidify (remove moisture)'
          : 'can humidify (add moisture)';
  let capNote;
  if (deh && hum) {
    capNote = `<div class="cap-note"><strong>${state.hall.siteName || 'This hall'}: full moisture control.</strong> Cooling, warming, dehumidification, and humidification are all available — any Target in the envelope is achievable with equipment, not just by riding the temperature move.</div>`;
  } else if (!deh && !hum) {
    capNote = `<div class="cap-note"><strong>${state.hall.siteName || 'This hall'}: no moisture control.</strong> There's no dehumidifier or humidifier — if your Target's absolute moisture differs from Current's, it isn't reachable by cooling/warming alone (see the water flag above). Add plant capability in the Data Hall panel to close that gap.</div>`;
  } else if (deh && !hum) {
    capNote = `<div class="cap-note"><strong>${state.hall.siteName || 'This hall'}: dehumidify only.</strong> Removing moisture is achievable; a Target that needs moisture <strong>added</strong> isn't reachable with the current plant.</div>`;
  } else {
    capNote = `<div class="cap-note"><strong>${state.hall.siteName || 'This hall'}: humidify only.</strong> Adding moisture is achievable; a Target that needs moisture <strong>removed</strong> isn't reachable with the current plant.</div>`;
  }

  // ── "Why" annotation: failure mode as Target nears an envelope edge ──
  // Warm/dry edge → ESD risk; cool/wet edge → condensation/corrosion risk.
  let whyNote = '';
  const rhMax = sla.rhMax, rhMin = sla.rhMin, tMax = sla.tMaxF, tMin = sla.tMinF;
  const nearHi = (v, lim, span) => lim != null && v >= lim - span;
  const nearLo = (v, lim, span) => lim != null && v <= lim + span;
  if (nearHi(B.rh, rhMax, 3) || (B.dpF != null && sla.dpMaxF != null && B.dpF >= sla.dpMaxF - 2)) {
    whyNote = `<div class="why-note why-wet">⚠ Approaching the upper humidity edge — condensation and corrosion risk. On the wet/cool side, water can condense on cold surfaces and accelerate corrosion of connectors and boards.</div>`;
  } else if (nearLo(B.rh, rhMin, 3)) {
    whyNote = `<div class="why-note why-dry">⚠ Approaching the lower humidity edge — electrostatic-discharge (ESD) risk. Dry air lets static build and discharge into equipment, which can damage components.</div>`;
  } else if (nearHi(B.tempF, tMax, 2)) {
    whyNote = `<div class="why-note why-hot">⚠ Approaching the upper temperature edge — thermal throttling and higher fan power as you near the SLA ceiling.</div>`;
  } else if (nearLo(B.tempF, tMin, 2)) {
    whyNote = `<div class="why-note why-cold">⚠ Approaching the lower temperature edge — over-cooling spends energy with no reliability benefit.</div>`;
  }

  // ── Cooling-load estimate (needs supply airflow) ──────────────
  // Load to condition the supply airstream from Current(entering) → Target(leaving):
  //   ṁ_da   = V̇ / v(Current)                        [kg dry air/s]
  //   Q_total  = ṁ_da · (h_A − h_B)                    [kW]  (+ = cooling / heat removed)
  //   Q_sens   = ṁ_da · (1.006 + 1.86·W̄) · (T_A − T_B) [kW]
  //   Q_latent = Q_total − Q_sens ;  SHR = Q_sens / Q_total ; 1 ton = 3.51685 kW
  let loadHtml = '';
  const cfm = state.hall.airflowCfm;
  if (cfm > 0) {
    const tcA = fToC(A.tempF), tcB = fToC(B.tempF);
    const WAkg = A.W / 1000, WBkg = B.W / 1000;
    const vA = specificVolume(tcA, WAkg, p);              // m³/kg dry air at Current
    const mda = (cfm * 0.000471947) / vA;                // kg dry air/s  (1 CFM = 4.71947e-4 m³/s)
    const qTot = mda * (A.h - B.h);                      // kW · + = cooling
    const qSens = mda * (1.006 + 1.86 * (WAkg + WBkg) / 2) * (tcA - tcB);
    const qLat = qTot - qSens;
    const tons = qTot / 3.51685;
    if (Math.abs(qTot) > 0.005) {
      const mode = qTot >= 0 ? 'Cooling' : 'Heating';
      const shr = Math.abs(qTot) > 0.01 ? Math.abs(qSens / qTot) : null;
      const kw = v => `${Math.abs(v).toFixed(1)} kW`;
      loadHtml = `
      <div class="ramp-advisory load-advisory">
        <div class="ramp-row"><span class="ramp-k">${mode} load</span><span class="ramp-v load-big">${kw(qTot)} · ${Math.abs(tons).toFixed(1)} tons</span></div>
        <div class="ramp-row"><span class="ramp-k">Sensible · latent</span><span class="ramp-v">${kw(qSens)} · ${kw(qLat)}</span></div>
        ${shr != null ? `<div class="ramp-row"><span class="ramp-k">Sensible heat ratio</span><span class="ramp-v">${shr.toFixed(2)}</span></div>` : ''}
        <div class="ramp-row"><span class="ramp-k">Dry-air mass flow</span><span class="ramp-v">${mda.toFixed(2)} kg/s</span></div>
        <div class="ramp-foot">At ${cfm.toLocaleString()} CFM · load to bring the airstream from Current → Target (SHR = sensible ÷ total).</div>
      </div>`;
    }
  }

  // Live SLA verdicts for both points — the at-a-glance compliance truth.
  const chkA = checkSLA(state.aTemp, state.aRH);
  const chkB = checkSLA(state.bTemp, state.bRH);
  const slaChip = c => `<span class="cr-slachip"><span class="badge ${c.ok ? 'badge-ok' : 'badge-bad'}">${c.ok ? '✓ in SLA' : '✗ ' + fmtSlaReason(c)}</span></span>`;

  el.innerHTML = `
    <div class="cr-lede">${lede}</div>
    <div class="cr-headline-pair">
      <div class="cr-point"><span class="cr-ptlabel" style="color:#d4d400">CURRENT</span>
        <span><span class="cr-big">${dispTs(A.tempF)}${U}</span><span class="cr-sep">·</span><span class="cr-big">${A.rh.toFixed(0)}%</span></span>
        ${slaChip(chkA)}</div>
      <span class="cr-arrow">→</span>
      <div class="cr-point"><span class="cr-ptlabel" style="color:var(--accent)">TARGET</span>
        <span><span class="cr-big">${dispTs(B.tempF)}${U}</span><span class="cr-sep">·</span><span class="cr-big ${cls}">${B.rh.toFixed(0)}%</span></span>
        ${slaChip(chkB)}</div>
    </div>
    <div class="cr-note">RH ${verb} ${A.rh.toFixed(0)}% → ${B.rh.toFixed(0)}% · ${note}</div>
    ${whyNote}
    ${rampHtml}
    ${loadHtml}
    ${capNote}
    <div class="detail-grid${openCls}">
      ${detailCol('● Current', A, '#d4d400')}
      ${detailCol('● Target', B, 'var(--accent)')}
    </div>
    <button class="results-toggle" id="results-toggle">${resultsExpanded?'Hide details ▴':'Show full properties ▾'}</button>`;

  const tog = document.getElementById('results-toggle');
  if (tog) tog.addEventListener('click', ()=>{ resultsExpanded = !resultsExpanded; updateControlReadout(); });
}

function refreshSlaSummary() {
  const el = document.getElementById('sla-summary'); if (!el) return;
  const s = state.slaProfiles[state.activeSla];
  const dp = (s.dpMaxF != null && s.dpMaxF !== '') ? ` · DP≤${dispTs(s.dpMaxF)}${tLabel()}` : '';
  el.textContent = `${s.name} · ${dispTs(s.tMinF)}–${dispTs(s.tMaxF)}${tLabel()} · ${s.rhMin}–${s.rhMax}%${dp}`;
}
function refreshHallSummary() {
  const el = document.getElementById('hall-summary'); if (!el) return;
  const h = state.hall;
  const vol = h.hallVolFt3 > 0 ? ` · ${(h.hallVolFt3/1000).toFixed(0)}k ft³` : '';
  const caps = [h.canDehumidify && 'dehum', h.canHumidify && 'hum'].filter(Boolean).join('+');
  const derated = ['derateCoolPct','derateWarmPct','derateDehumPct','derateHumPct'].some(k => (h[k] ?? 100) < 100);
  const fx = ` · eff ${Math.round(h.effPct ?? 100)}%${derated ? ' · ⚠ reduced capacity' : ''}`;
  const bld = (h.building || '').trim();
  el.textContent = `${h.siteName || 'set site'}${bld ? ' · ' + bld : ''} · ${h.name || 'Hall'} · ${(h.elevFt ?? 0).toLocaleString()} ft${vol}${caps ? ' · ' + caps : ''}${fx}`;
}
// ── Validity-domain warning chip ────────────────────────────────────────────
// The physics core is validated against CoolProp over a declared band
// (src/core/domain.js). When either state point leaves it, say so on the chart
// instead of extrapolating silently — the v1 tool's biggest correctness gap.
let domainChip = null;
function renderDomainWarnings() {
  const wrap = document.querySelector('.psych-wrap');
  if (!wrap) return;
  if (!domainChip) {
    domainChip = document.createElement('div');
    domainChip.id = 'domain-chip';
    domainChip.setAttribute('role', 'alert');
    domainChip.style.cssText =
      'position:absolute;top:8px;left:8px;right:8px;z-index:5;display:none;' +
      'padding:6px 10px;border-radius:7px;font:600 .72rem -apple-system,Segoe UI,sans-serif;' +
      'background:rgba(58,31,36,.92);border:1px solid rgba(248,81,73,.6);color:#ffb4ae;' +
      'pointer-events:none;';
    wrap.appendChild(domainChip);
  }
  const p = state.pressure;
  const issues = [];
  const chkA = checkDomain(fToC(state.aTemp), state.aRH, p);
  const chkB = checkDomain(fToC(state.bTemp), state.bRH, p);
  if (!chkA.ok) issues.push(...chkA.warnings.map((w) => `Current: ${w.message}`));
  if (!chkB.ok) issues.push(...chkB.warnings.map((w) => `Target: ${w.message}`));
  const unique = [...new Set(issues)];
  if (unique.length) {
    domainChip.textContent = '⚠ Outside validated range — ' + unique.join(' · ');
    domainChip.style.display = 'block';
  } else {
    domainChip.style.display = 'none';
  }
}

function update() {
  drawChart();
  buildTable();
  updateControlReadout();
  refreshSlaSummary();
  refreshHallSummary();
  renderSensorValidation();  // re-grade at the new unit / site pressure
  renderTrainingBrief(); //      keep the brief's start temp in the active unit
  renderDomainWarnings();
  if (typeof saveProfiles === 'function') saveProfiles();
}
window.addEventListener('resize', update);

// ════════════════════════════════════════════════════════════
//  SLA PROFILE UI
// ════════════════════════════════════════════════════════════
function renderSlaTabs() {
  const tabs = document.getElementById('sla-tabs');
  tabs.innerHTML = '';
  state.slaProfiles.forEach((sla, i) => {
    const btn = document.createElement('button');
    btn.className = 'sla-tab' + (i === state.activeSla ? ' active' : '') + (sla.locked ? ' locked' : '');
    btn.textContent = sla.name;
    btn.onclick = () => { state.activeSla = i; applyElevation(); renderSlaTabs(); renderSlaEditor(); update(); };
    tabs.appendChild(btn);
  });
}

function renderHallEditor() {
  const hed = document.getElementById('hall-editor');
  if (!hed) return;

  hed.innerHTML = `
    <div class="sla-field">
      <label>Hall name</label>
      <input type="text" id="hall-name" value="${(state.hall.name||'').replace(/"/g,'&quot;')}" placeholder="e.g. Hall 2">
    </div>
    <div class="sla-field">
      <label>Building</label>
      <input type="text" id="hall-building" value="${(state.hall.building||'').replace(/"/g,'&quot;')}" placeholder="e.g. DFW VII or Building A">
    </div>
    <div class="sla-field"><label>Site / location <span class="cap-hint">set by the Location picker above</span></label><input type="text" id="hall-site" value="${(state.hall.siteName||'').replace(/"/g,'&quot;')}" placeholder="e.g. Goodyear, AZ" ></div>
    <div class="sla-field"><label>Elevation ft <span class="cap-hint">preset from location; fine-tune here</span></label><input type="number" id="hall-elev" value="${state.hall.elevFt ?? 0}" step="10" min="-15000" max="20000" ></div>
    <div class="sla-caps">
      <div class="sla-caps-label">Plant capability &amp; rates — what this hall can actually do</div>
      <div class="cap-explain">Temperature rates: use commissioning-observed °F/hr, or derive a physics estimate below (IT load, excess sensible capacity, thermal mass). Moisture is first-principles: hall air mass × ΔW ÷ equipment lb/hr. Enter NET capacity (nameplate minus steady makeup-air latent load). Blank = not plant-limited; the SLA ramp limit still governs.</div>
      <div class="cap-line"><span class="cap-name">Hall air volume <span class="cap-hint">for the moisture mass balance</span></span><input type="number" id="hall-vol" class="cap-rate" value="${state.hall.hallVolFt3 ?? ''}" placeholder="—" step="1000" min="0"><span class="cap-u">ft³</span></div>
      <div class="cap-line"><span class="cap-name">Supply airflow <span class="cap-hint">for the cooling-load estimate</span></span><input type="number" id="hall-cfm" class="cap-rate" value="${state.hall.airflowCfm ?? ''}" placeholder="—" step="1000" min="0"><span class="cap-u">CFM</span></div>
      <div class="cap-line"><span class="cap-name">Cooling</span><input type="number" id="rate-cool" class="cap-rate" value="${state.hall.rateCoolF ?? ''}" placeholder="—" step="0.5" min="0"><span class="cap-u">°F/hr</span></div>
      <div class="cap-line"><span class="cap-name">Warming <span class="cap-hint">reheat or IT load</span></span><input type="number" id="rate-warm" class="cap-rate" value="${state.hall.rateWarmF ?? ''}" placeholder="—" step="0.5" min="0"><span class="cap-u">°F/hr</span></div>
      <div class="cap-line"><label class="cap-ck"><input type="checkbox" id="cap-dehum" ${state.hall.canDehumidify?'checked':''}> Dehumidify</label><input type="number" id="rate-dehum" class="cap-rate" value="${state.hall.rateDehumLb ?? ''}" placeholder="—" step="5" min="0" ${state.hall.canDehumidify?'':'disabled'}><span class="cap-u">lb/hr</span></div>
      <div class="cap-line"><label class="cap-ck"><input type="checkbox" id="cap-hum" ${state.hall.canHumidify?'checked':''}> Humidify</label><input type="number" id="rate-hum" class="cap-rate" value="${state.hall.rateHumLb ?? ''}" placeholder="—" step="5" min="0" ${state.hall.canHumidify?'':'disabled'}><span class="cap-u">lb/hr</span></div>
      <details class="calc">
        <summary>Derive your rates from equipment specs <span class="sect-chev">▸</span></summary>
        <div class="calc-body">
          <div class="calc-intro">Pick the equipment you actually have; enter the number straight off the manufacturer's schedule. Uses the live Current condition, site pressure, and hall volume.</div>

          <div class="calc-method">Shared — thermal mass</div>
          <div class="calc-grid2">
            <input type="number" id="rc-it" class="cap-rate" value="${(state.hall.calc||{}).it ?? ''}" placeholder="IT load kW" min="0" step="10">
            <input type="number" id="rc-mass" class="cap-rate" value="${(state.hall.calc||{}).mass ?? ''}" placeholder="equip mass lb (opt)" min="0" step="1000">
          </div>
          <div class="calc-hint2">Capacitance = hall air + equipment mass (cₚ≈0.12 BTU/lb·°F). Blank mass = air-only ceiling.</div>

          <div class="calc-method mt">Cooling <span class="cap-hint">total sensible delivered — any source</span></div>
          <div class="calc-grid">
            <input type="number" id="cc-units" class="cap-rate" value="${(state.hall.calc||{}).ccUnits ?? ''}" placeholder="units" min="0" step="1">
            <span class="calc-x">×</span>
            <input type="number" id="cc-cap" class="cap-rate" value="${(state.hall.calc||{}).ccCap ?? ''}" placeholder="sensible ea." min="0" step="1">
            <select id="cc-capunit" class="sla-select calc-sel">
              <option value="kw"${((state.hall.calc||{}).ccUnit??'kw')==='kw'?' selected':''}>kW</option>
              <option value="ton"${(state.hall.calc||{}).ccUnit==='ton'?' selected':''}>tons</option>
              <option value="btu"${(state.hall.calc||{}).ccUnit==='btu'?' selected':''}>BTU/hr</option>
              <option value="mbh"${(state.hall.calc||{}).ccUnit==='mbh'?' selected':''}>MBH</option>
            </select>
          </div>
          <div class="calc-res" id="cc-res">—</div>

          <div class="calc-method mt">Warming <span class="cap-hint">IT load, cooling backed off</span></div>
          <div class="calc-grid2">
            <input type="number" id="wc-reheat" class="cap-rate" value="${(state.hall.calc||{}).reheat ?? ''}" placeholder="+ reheat kW (opt)" min="0" step="5">
            <span class="calc-inline-note">uses IT load above</span>
          </div>
          <div class="calc-res" id="wc-res">—</div>

          <div class="calc-method mt">Dehumidify</div>
          <select id="dh-type" class="sla-select calc-typesel">
            <option value="lbhr"${((state.hall.calc||{}).dhType??'lbhr')==='lbhr'?' selected':''}>DOAS / dedicated unit — moisture removal</option>
            <option value="latent"${(state.hall.calc||{}).dhType==='latent'?' selected':''}>Latent-rated coil — latent capacity</option>
            <option value="coil"${(state.hall.calc||{}).dhType==='coil'?' selected':''}>Condensing coil — airflow + dew point</option>
          </select>
          <div id="dh-lbhr" class="dh-pane">
            <div class="calc-grid">
              <input type="number" id="dh-qty" class="cap-rate" value="${(state.hall.calc||{}).dhQty ?? ''}" placeholder="units" min="0" step="1">
              <span class="calc-x">×</span>
              <input type="number" id="dh-each" class="cap-rate" value="${(state.hall.calc||{}).dhEach ?? ''}" placeholder="removal ea." min="0" step="1">
              <select id="dh-unit" class="sla-select calc-sel">
                <option value="lbhr"${((state.hall.calc||{}).dhUnit??'lbhr')==='lbhr'?' selected':''}>lb/hr</option>
                <option value="pintday"${(state.hall.calc||{}).dhUnit==='pintday'?' selected':''}>pints/day</option>
                <option value="gpd"${(state.hall.calc||{}).dhUnit==='gpd'?' selected':''}>gal/day</option>
              </select>
            </div>
          </div>
          <div id="dh-latent" class="dh-pane" style="display:none">
            <div class="calc-grid">
              <input type="number" id="dh-lqty" class="cap-rate" value="${(state.hall.calc||{}).dhLQty ?? ''}" placeholder="units" min="0" step="1">
              <span class="calc-x">×</span>
              <input type="number" id="dh-lat" class="cap-rate" value="${(state.hall.calc||{}).dhLat ?? ''}" placeholder="latent ea." min="0" step="0.5">
              <select id="dh-latunit" class="sla-select calc-sel">
                <option value="ton"${((state.hall.calc||{}).dhLatUnit??'ton')==='ton'?' selected':''}>lat. tons</option>
                <option value="kw"${(state.hall.calc||{}).dhLatUnit==='kw'?' selected':''}>kW</option>
                <option value="mbh"${(state.hall.calc||{}).dhLatUnit==='mbh'?' selected':''}>MBH</option>
              </select>
            </div>
          </div>
          <div id="dh-coil" class="dh-pane" style="display:none">
            <div class="calc-grid2">
              <input type="number" id="dc-cfm" class="cap-rate" value="${(state.hall.calc||{}).cfm ?? ''}" placeholder="total CFM" min="0" step="100">
              <input type="number" id="dc-dp" class="cap-rate" value="${(state.hall.calc||{}).dp ?? ''}" placeholder="supply DP °F" step="1">
            </div>
          </div>
          <div class="calc-res" id="dh-res">—</div>

          <div class="calc-method mt">Humidify <span class="cap-hint">evap · ultrasonic · fog · steam</span></div>
          <div class="calc-grid">
            <input type="number" id="hc-qty" class="cap-rate" value="${(state.hall.calc||{}).hQty ?? ''}" placeholder="units" min="0" step="1">
            <span class="calc-x">×</span>
            <input type="number" id="hc-each" class="cap-rate" value="${(state.hall.calc||{}).hEach ?? ''}" placeholder="output ea." min="0" step="1">
            <select id="hc-unit" class="sla-select calc-sel">
              <option value="lbhr"${((state.hall.calc||{}).hUnit??'lbhr')==='lbhr'?' selected':''}>lb/hr</option>
              <option value="gph"${(state.hall.calc||{}).hUnit==='gph'?' selected':''}>GPH</option>
              <option value="gpd"${(state.hall.calc||{}).hUnit==='gpd'?' selected':''}>gal/day</option>
            </select>
          </div>
          <div class="calc-res" id="hc-res">—</div>

          <div class="calc-note">Temperature rates are physics estimates — air-only is the ceiling, with equipment mass the sustained rate; commissioning-observed rates always trump derived. Humidifiers (evaporative, ultrasonic, fog, steam) are all rated by water output, converted here to lb/hr. Apply fills the fields above; IT load never enters the moisture math — servers add heat, not water.</div>
        </div>
      </details>
    </div>
    <div class="sla-caps">
      <div class="sla-caps-label">Real-world factors — efficiency &amp; current capacity</div>
      <div class="cap-explain"><strong>Efficiency factor</strong>: the fraction of nameplate performance this hall actually delivers once mixing losses, stratification, control deadbands, and sensor lag are paid — <strong>85% is the planning default</strong>; calibrate it with logged results below. <strong>Capacity derates</strong>: today's temporary reductions — chillers offline, crusty evaporative media on the humidifiers, fouled coils. Every plant rate is scaled by efficiency × derate before timing a move.</div>
      <div class="cap-line"><span class="cap-name">Efficiency factor <span class="cap-hint">predicted real-world vs. nameplate</span></span><input type="number" id="hall-eff" class="cap-rate" value="${state.hall.effPct ?? 85}" step="1" min="1" max="150"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Cooling capacity today <span class="cap-hint">e.g. chillers down for service</span></span><input type="number" id="der-cool" class="cap-rate" value="${state.hall.derateCoolPct ?? 100}" step="5" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Warming capacity today</span><input type="number" id="der-warm" class="cap-rate" value="${state.hall.derateWarmPct ?? 100}" step="5" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Dehumidify capacity today</span><input type="number" id="der-dehum" class="cap-rate" value="${state.hall.derateDehumPct ?? 100}" step="5" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Humidify capacity today <span class="cap-hint">e.g. crusty evap media</span></span><input type="number" id="der-hum" class="cap-rate" value="${state.hall.derateHumPct ?? 100}" step="5" min="1" max="100"><span class="cap-u">%</span></div>
    </div>
    <div class="sla-caps">
      <div class="sla-caps-label">Predicted vs. actual — calibrate the efficiency factor</div>
      <div class="cap-explain">After a real move finishes, log how long it actually took. Implied efficiency = time predicted at nameplate (with today's capacity derates) ÷ actual time. Runs where the SLA ramp limit — not the plant — was the binding constraint are kept for the record but excluded from calibration, since they can't reveal plant efficiency.</div>
      <div class="calc-res" id="pva-pred">—</div>
      <div class="calc-grid2">
        <input type="number" id="pva-actual" class="cap-rate" placeholder="actual duration" min="0" step="5">
        <select id="pva-unit" class="sla-select calc-sel"><option value="min">minutes</option><option value="hr">hours</option></select>
      </div>
      <div class="addcity-actions" style="margin-top:8px"><button type="button" class="scn-btn scn-btn-primary" id="pva-log">Log this move's result</button></div>
      <div id="pva-list" style="margin-top:10px"></div>
      <div class="cap-explain" style="margin-top:12px"><strong>Or import the trend export.</strong> Drop the BMS/BAS CSV of the move (time, temp, RH columns) — the actual trajectory overlays the chart next to the plan, and the measured duration feeds the same calibration with no stopwatch honesty required.</div>
      <div class="addcity-actions"><button type="button" class="scn-btn" id="trend-import">⤒ Import trend CSV</button><input type="file" id="trend-file" accept=".csv,text/csv" style="display:none"></div>
      <div class="calc-res" id="trend-res" style="display:none"></div>
    </div>
  `;
  // Capability checkboxes are always active (a site characteristic, like elevation).
  const capWire = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', function() {
      state.hall[key] = this.checked;   // Target sliders stay wherever they are — no reclamp needed.
      syncAllControls(); update();
      renderHallEditor();   // refresh paired rate-field enabled state
    });
  };
  capWire('cap-dehum', 'canDehumidify');
  capWire('cap-hum', 'canHumidify');
  // Plant rate fields — always editable (a site attribute, like elevation).
  const rateWire = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function() {
      const v = parseFloat(this.value);
      state.hall[key] = (isNaN(v) || v <= 0) ? null : v;
      update();
    });
  };
  rateWire('rate-cool',  'rateCoolF');
  rateWire('rate-warm',  'rateWarmF');
  rateWire('rate-dehum', 'rateDehumLb');
  rateWire('rate-hum',   'rateHumLb');
  rateWire('hall-vol',   'hallVolFt3');
  rateWire('hall-cfm',   'airflowCfm');

  // Hall identity fields — name renames the tab; building/site feed the
  // Location/Building filters above the tabs; site/elevation drive pressure.
  const nameEl = document.getElementById('hall-name');
  if (nameEl) nameEl.addEventListener('input', function() {
    state.hall.name = this.value;
    renderHallTabs(); update();
  });
  const bldEl = document.getElementById('hall-building');
  if (bldEl) bldEl.addEventListener('input', function() {
    state.hall.building = this.value;
    // Editing must never filter the hall you're typing in out of view.
    if (state.hallView.bld && this.value.trim() !== state.hallView.bld) state.hallView.bld = '';
    renderHallTabs(); update();
  });
  const siteEl = document.getElementById('hall-site');
  if (siteEl) siteEl.addEventListener('input', function() {
    state.hall.siteName = this.value;
    if (state.hallView.loc && this.value.trim() !== state.hallView.loc) state.hallView.loc = '';
    applyElevation(); renderHallTabs(); update();
  });
  const elevEl = document.getElementById('hall-elev');
  if (elevEl) elevEl.addEventListener('input', function() {
    const v = parseFloat(this.value); if (isNaN(v)) return;
    state.hall.elevFt = Math.max(-15000, Math.min(20000, Math.round(v)));
    applyElevation(); update();
  });

  // Real-world factor fields (%): efficiency + per-system capacity derates.
  const pctWire = (id, key, lo, hi, dflt) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', function() {
      const v = parseFloat(this.value);
      state.hall[key] = isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v));
      update();
    });
  };
  pctWire('hall-eff', 'effPct',        1, 150, 85);
  pctWire('der-cool',  'derateCoolPct',  1, 100, 100);
  pctWire('der-warm',  'derateWarmPct',  1, 100, 100);
  pctWire('der-dehum', 'derateDehumPct', 1, 100, 100);
  pctWire('der-hum',   'derateHumPct',   1, 100, 100);

  // ── Predicted vs. actual — log real results, back out implied efficiency ──
  function renderPva() {
    const planEff = planMove();                       // with efficiency
    const planNom = planMove({ nameplate: true });  // nameplate × derates
    const predEl = document.getElementById('pva-pred');
    if (predEl) {
      if (planNom.hours > 0) {
        predEl.innerHTML = `Current move ${dispTs(state.aTemp)}${tLabel()}/${Math.round(state.aRH)}% → ${dispTs(state.bTemp)}${tLabel()}/${Math.round(state.bRH)}%: predicted <strong>${fmtHrs(planEff.hours)}</strong> at ${Math.round(state.hall.effPct ?? 100)}% eff · ${fmtHrs(planNom.hours)} at nameplate · binding: ${planNom.binding}`;
      } else {
        predEl.textContent = 'Set plant rates (and hall volume for moisture) above to get a prediction worth logging against.';
      }
    }
    const list = document.getElementById('pva-list');
    if (!list) return;
    const rs = state.hall.results;
    if (!rs.length) { list.innerHTML = '<div class="scn-empty">No results logged yet for this hall.</div>'; return; }
    const usable = rs.filter(r => !r.slaBound && r.eff > 0);
    const avgEff = usable.length ? usable.reduce((a, r) => a + r.eff, 0) / usable.length : null;
    const rows = rs.map((r, i) => {
      const effTxt = r.slaBound ? '<span class="cap-hint">SLA-bound — excluded</span>'
        : r.eff > 0 ? `<strong>${Math.round(r.eff * 100)}%</strong>` : '—';
      return `<div class="scn-item">
        <div class="scn-item-main">
          <div class="scn-item-name">${Math.round(r.aTemp)}°F/${Math.round(r.aRH)}% → ${Math.round(r.bTemp)}°F/${Math.round(r.bRH)}%</div>
          <div class="scn-item-detail">${new Date(r.date).toLocaleDateString()} · predicted ${fmtHrs(r.nomHrs)} nameplate · actual ${fmtHrs(r.actualHrs)} · implied eff ${r.slaBound ? '(SLA-bound)' : (r.eff > 0 ? Math.round(r.eff * 100) + '%' : '—')}</div>
        </div>
        <span style="font-size:.78rem">${effTxt}</span>
        <button class="scn-del" data-pvadel="${i}" title="Delete">✕</button>
      </div>`;
    }).join('');
    const summary = avgEff != null
      ? `<div class="calc-res" style="margin-top:8px">Measured efficiency ≈ <strong>${Math.round(avgEff * 100)}%</strong> over ${usable.length} plant-bound run${usable.length === 1 ? '' : 's'} <button class="calc-apply" id="pva-apply">Apply as efficiency factor</button></div>`
      : `<div class="calc-hint2" style="margin-top:8px">No plant-bound runs yet — every logged run was limited by the SLA ramp, which says nothing about plant efficiency.</div>`;
    list.innerHTML = `<div class="scn-list" style="margin-bottom:0">${rows}</div>${summary}`;
    list.querySelectorAll('[data-pvadel]').forEach(b => b.addEventListener('click', () => {
      state.hall.results.splice(+b.dataset.pvadel, 1); renderPva(); update();
    }));
    const applyBtn = document.getElementById('pva-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      state.hall.effPct = Math.max(1, Math.min(150, Math.round(avgEff * 100)));
      renderHallEditor(); update();
    });
  }
  const pvaLog = document.getElementById('pva-log');
  if (pvaLog) pvaLog.addEventListener('click', () => {
    const v = parseFloat(document.getElementById('pva-actual').value);
    if (!(v > 0)) { toast('Enter the actual duration the move took.', { kind: 'warn' }); return; }
    const hrs = document.getElementById('pva-unit').value === 'hr' ? v : v / 60;
    const planEff = planMove();
    const planNom = planMove({ nameplate: true });
    if (!(planNom.hours > 0)) { toast('No prediction to compare against — set plant rates (and hall volume for moisture moves) first.', { kind: 'warn', duration: 7000 }); return; }
    const slaBound = planNom.binding.startsWith('SLA');
    state.hall.results.push({
      date: new Date().toISOString(),
      aTemp: state.aTemp, aRH: state.aRH, bTemp: state.bTemp, bRH: state.bRH,
      predHrs: planEff.hours, nomHrs: planNom.hours, actualHrs: hrs,
      binding: planNom.binding, slaBound,
      eff: slaBound ? null : planNom.hours / hrs,
    });
    document.getElementById('pva-actual').value = '';
    renderPva(); update();
  });
  renderPva();

  // ── Trend-CSV import: overlay reality on the chart, feed calibration ──
  const trendBtn = document.getElementById('trend-import');
  const trendFile = document.getElementById('trend-file');
  if (trendBtn && trendFile) {
    trendBtn.addEventListener('click', () => trendFile.click());
    trendFile.addEventListener('change', () => {
      const f = trendFile.files?.[0];
      trendFile.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = parseTrendCsv(String(reader.result));
        const out = document.getElementById('trend-res');
        if (!res.ok) {
          if (out) { out.style.display = ''; out.innerHTML = `<span class="calc-warn">${res.error}</span>`; }
          toast('Could not read the trend file.', { kind: 'error' });
          return;
        }
        actualTrail = { rows: res.rows, name: f.name };
        state.visible.actual = true;
        syncLegend();

        const first = res.rows[0], last = res.rows[res.rows.length - 1];
        const hrs = (last.time - first.time) / 3600000;
        const ratePerHr = hrs > 0 ? (last.tempF - first.tempF) / hrs : 0;
        const unitNote =
          res.tempUnitSource === 'header'
            ? `°${res.tempUnit} from the header`
            : res.tempUnitSource === 'forced'
              ? `°${res.tempUnit} (forced)`
              : `°${res.tempUnit} guessed from the value range — if that's wrong the overlay will look wrong`;
        if (out) {
          out.style.display = '';
          out.innerHTML =
            `${res.rows.length} points over ${fmtHrs(hrs)} (${unitNote}${res.skipped ? `, ${res.skipped} bad row${res.skipped === 1 ? '' : 's'} skipped` : ''}). ` +
            `Achieved <strong>${Math.abs(ratePerHr).toFixed(1)} °F/hr</strong> ` +
            `${first.tempF.toFixed(1)}→${last.tempF.toFixed(1)}°F, ${first.rh.toFixed(0)}→${last.rh.toFixed(0)}%RH.` +
            (hrs > 0
              ? ` <button type="button" class="scn-btn" id="trend-to-pva" style="margin-left:6px">Log to calibration</button>`
              : '');
        }
        document.getElementById('trend-to-pva')?.addEventListener('click', () => {
          // Same entry shape as the stopwatch path, endpoints from the trail —
          // renderPva and the efficiency apply-button treat both identically.
          const plan = rampPlanCore({
            sla: state.slaProfiles[state.activeSla], hall: state.hall,
            aTempF: first.tempF, aRH: first.rh, bTempF: last.tempF, bRH: last.rh,
            p: state.pressure,
          });
          const nom = rampPlanCore({
            sla: state.slaProfiles[state.activeSla], hall: state.hall,
            aTempF: first.tempF, aRH: first.rh, bTempF: last.tempF, bRH: last.rh,
            p: state.pressure,
          }, { nameplate: true });
          if (!(nom.hours > 0)) { toast('The trail is too small a move to calibrate against.', { kind: 'warn' }); return; }
          const slaBound = nom.binding.startsWith('SLA');
          state.hall.results.push({
            date: last.time.toISOString(),
            aTemp: first.tempF, aRH: first.rh, bTemp: last.tempF, bRH: last.rh,
            predHrs: plan.hours, nomHrs: nom.hours, actualHrs: hrs,
            binding: nom.binding, slaBound,
            eff: slaBound ? null : nom.hours / hrs,
          });
          toast('Trend logged to calibration.', { kind: 'ok' });
          renderPva(); update();
        });
        update();
      };
      reader.readAsText(f);
    });
  }

  // ── Rate calculator: derive all four plant rates from equipment specs ──
  // Temperature: Q[kW] / (C_air + C_equipment), where C_air = m_da·cp_moist
  // and C_eq = mass·0.5 kJ/kg·K (steel-class). Air-only = fastest ceiling.
  // Dehum: latent → lb/hr via h_fg ≈ 2454 kJ/kg (1060 BTU/lb), or airflow +
  // supply DP with the exact exponential dry-down. Humidify: steam kW →
  // lb/hr via ≈ 2675 kJ/kg water→steam (≈ 2.97 lb/hr per kW).
  const calcState = () => (state.hall.calc = state.hall.calc || {});
  function thermalC() {                       // kJ/K, or null if no volume
    if (!(state.hall.hallVolFt3 > 0)) return null;
    const p = state.pressure, W0 = currentW();
    const v = specificVolume(fToC(state.aTemp), W0, p);
    const mda = (state.hall.hallVolFt3 * 0.0283168) / v;
    const cAir = mda * (1.006 + 1.86 * W0);
    const massLb = parseFloat(document.getElementById('rc-mass')?.value);
    const cEq = massLb > 0 ? massLb * 0.45359237 * 0.5 : 0;
    return { c: cAir + cEq, airOnly: !(massLb > 0) };
  }
  const toKW = (val, unit) => unit === 'ton' ? val * 3.51685
    : unit === 'btu' ? val / 3412.14
    : unit === 'mbh' ? val / 3.41214
    : val;
  // Water-output units → lb/hr. Water ≈ 8.34 lb/gal; pint = 1/8 gal.
  const waterToLbHr = (val, unit) => unit === 'gph' ? val * 8.34
    : unit === 'gpd' ? val * 8.34 / 24
    : unit === 'pintday' ? val * 8.34 / 8 / 24
    : val;                                    // 'lbhr'
  function runRateCalc() {
    const cs = calcState();
    const g = id => document.getElementById(id);
    const num = id => { const v = parseFloat(g(id)?.value); return isNaN(v) ? null : v; };
    // persist shared + temp
    cs.it = num('rc-it'); cs.mass = num('rc-mass');
    cs.ccUnits = num('cc-units'); cs.ccCap = num('cc-cap'); cs.ccUnit = g('cc-capunit')?.value || 'kw';
    cs.reheat = num('wc-reheat');
    // persist dehum (all panes) + humidify
    cs.dhType = g('dh-type')?.value || 'lbhr';
    cs.dhQty = num('dh-qty'); cs.dhEach = num('dh-each'); cs.dhUnit = g('dh-unit')?.value || 'lbhr';
    cs.dhLQty = num('dh-lqty'); cs.dhLat = num('dh-lat'); cs.dhLatUnit = g('dh-latunit')?.value || 'ton';
    cs.cfm = num('dc-cfm'); cs.dp = num('dc-dp');
    cs.hQty = num('hc-qty'); cs.hEach = num('hc-each'); cs.hUnit = g('hc-unit')?.value || 'lbhr';

    // show the active dehum pane
    ['dh-lbhr','dh-latent','dh-coil'].forEach(id => { const el = g(id); if (el) el.style.display = 'none'; });
    const paneMap = { lbhr:'dh-lbhr', latent:'dh-latent', coil:'dh-coil' };
    const activePane = g(paneMap[cs.dhType]); if (activePane) activePane.style.display = '';

    const C = thermalC();
    const rateF = kw => kw * 3600 / C.c * 1.8;                    // °F/hr
    const tag = C && C.airOnly ? ' <span class="cap-hint">(air-only ceiling)</span>' : '';

    // Cooling — excess sensible over IT load
    const cc = g('cc-res');
    if (cc) {
      if (cs.ccUnits > 0 && cs.ccCap > 0 && cs.it != null) {
        if (!C) cc.innerHTML = '<span class="calc-warn">Set hall volume first.</span>';
        else {
          const excess = toKW(cs.ccUnits * cs.ccCap, cs.ccUnit) - cs.it;
          if (excess <= 0) cc.innerHTML = '<span class="calc-warn">No pulldown margin — sensible capacity ≤ IT load.</span>';
          else cc.innerHTML = `excess ${excess.toFixed(0)} kW → <strong>${rateF(excess).toFixed(1)} °F/hr</strong>${tag} <button class="calc-apply" data-rk="rateCoolF" data-rv="${rateF(excess).toFixed(1)}">Apply</button>`;
        }
      } else cc.textContent = '—';
    }
    // Warming — IT load (+ reheat)
    const wc = g('wc-res');
    if (wc) {
      if (cs.it > 0) {
        if (!C) wc.innerHTML = '<span class="calc-warn">Set hall volume first.</span>';
        else {
          const q = cs.it + (cs.reheat || 0);
          wc.innerHTML = `${q.toFixed(0)} kW → <strong>${rateF(q).toFixed(1)} °F/hr</strong>${tag} <button class="calc-apply" data-rk="rateWarmF" data-rv="${rateF(q).toFixed(1)}">Apply</button>`;
        }
      } else wc.textContent = '—';
    }
    // Dehumidify — three input styles, all → lb/hr
    const dr = g('dh-res');
    if (dr) {
      if (cs.dhType === 'lbhr') {
        if (cs.dhQty > 0 && cs.dhEach > 0) {
          const lbhr = waterToLbHr(cs.dhQty * cs.dhEach, cs.dhUnit);
          dr.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateDehumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
        } else dr.textContent = '—';
      } else if (cs.dhType === 'latent') {
        if (cs.dhLQty > 0 && cs.dhLat > 0) {
          const lbhr = toKW(cs.dhLQty * cs.dhLat, cs.dhLatUnit) * 3412.14 / 1060;
          dr.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateDehumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
        } else dr.textContent = '—';
      } else { // coil — exact exponential dry-down
        if (cs.cfm > 0 && cs.dp != null) {
          const p = state.pressure, W0 = currentW();
          const Ws = saturationHumidityRatio(fToC(cs.dp), p);
          const v = specificVolume(fToC(state.aTemp), W0, p);
          const mCoil = cs.cfm * 0.000471947 / v * 3600;
          if (Ws >= W0) dr.innerHTML = '<span class="calc-warn">Supply DP ≥ hall dew point — no removal at current conditions.</span>';
          else {
            const initLb = mCoil * (W0 - Ws) / 0.45359237;
            let extra = '', applyRate = initLb;
            const Wb = humidityRatio(fToC(state.bTemp), state.bRH, p);
            if (state.hall.hallVolFt3 > 0 && Wb < W0 - 0.00005) {
              const mHall = (state.hall.hallVolFt3 * 0.0283168) / v;
              const tau = mHall / mCoil;
              if (Wb <= Ws) extra = '<div class="calc-warn">Target at/below supply DP — unreachable with this coil (colder coil or desiccant).</div>';
              else {
                const tEx = tau * Math.log((W0 - Ws) / (Wb - Ws));
                applyRate = mHall * (W0 - Wb) / 0.45359237 / tEx;
                extra = `<div class="calc-detail">This move: exact ${fmtHrs(tEx)} · avg <strong>${applyRate.toFixed(1)} lb/hr</strong> (τ = ${fmtHrs(tau)})</div>`;
              }
            }
            dr.innerHTML = `initial <strong>${initLb.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateDehumLb" data-rv="${applyRate.toFixed(1)}">Apply${applyRate !== initLb ? ' avg' : ''}</button>${extra}`;
          }
        } else dr.textContent = '—';
      }
    }
    // Humidify — water output → lb/hr (evap/ultrasonic/fog/steam all rated this way)
    const hc = g('hc-res');
    if (hc) {
      if (cs.hQty > 0 && cs.hEach > 0) {
        const lbhr = waterToLbHr(cs.hQty * cs.hEach, cs.hUnit);
        hc.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateHumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
      } else hc.textContent = '—';
    }
    // Apply buttons
    hed.querySelectorAll('.calc-apply').forEach(b => b.onclick = () => {
      const k = b.dataset.rk;
      state.hall[k] = parseFloat(b.dataset.rv);
      if (k === 'rateDehumLb') state.hall.canDehumidify = true;
      if (k === 'rateHumLb')   state.hall.canHumidify = true;
      syncAllControls(); update(); renderHallEditor();
    });
  }
  ['rc-it','rc-mass','cc-units','cc-cap','cc-capunit','wc-reheat',
   'dh-type','dh-qty','dh-each','dh-unit','dh-lqty','dh-lat','dh-latunit',
   'dc-cfm','dc-dp','hc-qty','hc-each','hc-unit'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const ev = el.tagName === 'SELECT' ? 'change' : 'input'; el.addEventListener(ev, runRateCalc); }
  });
  runRateCalc();

}

// ════════════════════════════════════════════════════════════
//  HALL PROFILE TABS + CRUD + EXPORT/IMPORT — same pattern as SLAs
// ════════════════════════════════════════════════════════════
// Sentinel value for the Building select's "＋ Add a building…" option — a
// control character no typed building name can contain, so it can't collide.
const BLD_ADD = String.fromCharCode(1) + 'add';

// The hall list is a hierarchy: Location → Building → Hall. Location is the
// master site picker — the FULL Stream catalog (plus custom sites), not just
// places that already have halls — and choosing one sets the site + elevation
// feeding the psychrometric chart. Building lists the campus codes at that
// city plus any building names already on halls there. '' means "All". Each
// hall profile keeps its own plant capability, so switching halls recalls
// that hall's equipment and capacity.
function hallVisible(h) {
  const v = state.hallView;
  if (v.loc && (h.siteName || '').trim() !== v.loc) return false;
  if (v.bld && (h.building || '').trim() !== v.bld) return false;
  return true;
}

// Guarantee at least one hall exists at the given location/building; create
// "Hall 1" there (preset catalog elevation) and activate it if none does.
// This is what makes picking a fresh Location drive the chart immediately.
function ensureHallAt(loc, bld) {
  if (!loc) return;
  if (state.hallProfiles.some(h =>
    (h.siteName || '').trim() === loc && (!bld || (h.building || '').trim() === bld))) return;
  const sites = allSites();
  const site = (bld && sites.find(s => s.siteName === loc && String(s.code) === bld))
    || sites.find(s => s.siteName === loc);
  state.hallProfiles.push(normalizeHall({
    name: 'Hall 1', siteName: loc, building: bld || '',
    elevFt: site ? site.elevFt : 0,
  }));
  state.activeHall = state.hallProfiles.length - 1;
  applyElevation();
  if (typeof renderHallEditor === 'function') renderHallEditor();
  if (typeof syncAllControls === 'function') syncAllControls();
}

function renderHallTabs() {
  const tabs = document.getElementById('hall-tabs');
  if (!tabs) return;
  const v = state.hallView || (state.hallView = { loc: '', bld: '' });
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const nHalls = pred => state.hallProfiles.filter(pred).length;
  const cnt = n => n ? ` · ${n} hall${n === 1 ? '' : 's'}` : '';

  // ── Location: full site catalog grouped by state, one option per city.
  const sites = allSites();
  const locSel = document.getElementById('hall-loc-filter');
  if (locSel) {
    const seen = new Set();
    let html = `<option value="">All locations (${state.hallProfiles.length} hall${state.hallProfiles.length === 1 ? '' : 's'})</option>`;
    let curState = null;
    sites.forEach(s => {
      if (seen.has(s.siteName)) return;
      seen.add(s.siteName);
      if (s.state !== curState) {
        if (curState !== null) html += '</optgroup>';
        html += `<optgroup label="${esc(s.state)}">`;
        curState = s.state;
      }
      const n = nHalls(h => (h.siteName || '').trim() === s.siteName);
      html += `<option value="${esc(s.siteName)}"${s.siteName === v.loc ? ' selected' : ''}>${esc(s.siteName)} · ${s.elevFt.toLocaleString()} ft${cnt(n)}</option>`;
    });
    if (curState !== null) html += '</optgroup>';
    // Locations hand-typed on hall profiles that aren't in the catalog.
    const extra = [...new Set(state.hallProfiles.map(h => (h.siteName || '').trim()).filter(Boolean))]
      .filter(l => !seen.has(l)).sort();
    if (extra.length) html += '<optgroup label="Other">' + extra.map(l =>
      `<option value="${esc(l)}"${l === v.loc ? ' selected' : ''}>${esc(l)}${cnt(nHalls(h => (h.siteName || '').trim() === l))}</option>`).join('') + '</optgroup>';
    locSel.innerHTML = html;
    if (v.loc && locSel.value !== v.loc) v.loc = '';   // stale filter
  }

  // ── Building: campus codes from the catalog for this city (even with no
  //    halls yet — the fleet is browsable) plus building names on halls here.
  const inLoc = state.hallProfiles.filter(h => !v.loc || (h.siteName || '').trim() === v.loc);
  const bldSel = document.getElementById('hall-bld-filter');
  if (bldSel) {
    const names = new Set();
    if (v.loc) sites.filter(s => s.siteName === v.loc).forEach(s => names.add(String(s.code)));
    inLoc.forEach(h => { const b = (h.building || '').trim(); if (b) names.add(b); });
    if (v.bld && !names.has(v.bld)) v.bld = '';
    bldSel.innerHTML = `<option value="">All buildings (${inLoc.length} hall${inLoc.length === 1 ? '' : 's'})</option>`
      + [...names].sort().map(b =>
        `<option value="${esc(b)}"${b === v.bld ? ' selected' : ''}>${esc(b)}${cnt(inLoc.filter(h => (h.building || '').trim() === b).length)}</option>`).join('')
      + `<option value="${BLD_ADD}">＋ Add a building…</option>`;
  }

  let shown = state.hallProfiles.map((h, i) => ({ h, i })).filter(x => hallVisible(x.h));
  if (!shown.length) { v.loc = ''; v.bld = ''; shown = state.hallProfiles.map((h, i) => ({ h, i })); }
  if (!shown.some(x => x.i === state.activeHall)) {
    state.activeHall = shown[0].i;
    applyElevation();
    if (typeof renderHallEditor === 'function') renderHallEditor();
    if (typeof syncAllControls === 'function') syncAllControls();
  }

  tabs.innerHTML = '';
  shown.forEach(({ h, i }) => {
    const btn = document.createElement('button');
    btn.className = 'sla-tab' + (i === state.activeHall ? ' active' : '');
    // Prefix whatever the selectors haven't already pinned down, so
    // same-named halls in different places stay distinguishable.
    const bld = (h.building || '').trim(), loc = (h.siteName || '').trim();
    btn.textContent = (!v.loc && loc ? loc + ' · ' : '')
      + (!v.bld && bld ? bld + ' · ' : '') + (h.name || `Hall ${i + 1}`);
    btn.onclick = () => {
      state.activeHall = i;
      applyElevation();            // pressure follows the newly active hall
      renderHallTabs(); renderHallEditor(); syncAllControls(); update();
    };
    tabs.appendChild(btn);
  });
  const del = document.getElementById('hall-del');
  if (del) del.disabled = state.hallProfiles.length <= 1;
}

document.getElementById('hall-loc-filter').addEventListener('change', function() {
  state.hallView.loc = this.value;
  state.hallView.bld = '';
  ensureHallAt(this.value, '');    // fresh site → create Hall 1 there, chart follows
  renderHallTabs(); update();
});
document.getElementById('hall-bld-filter').addEventListener('change', function() {
  if (this.value === BLD_ADD) {
    // Name a new building yourself — it doesn't have to be a campus code.
    // It lives at the chosen location (or the active hall's, if on "All").
    const loc = state.hallView.loc || (state.hall.siteName || '').trim();
    if (!loc) {
      toast('Pick a location first, then add a building there.', { kind: 'warn' });
      renderHallTabs();                       // reset the select display
      return;
    }
    const name = (prompt('Name the new building (e.g. Building B, DFW VIII):') || '').trim();
    if (!name) { renderHallTabs(); return; }
    state.hallView.loc = loc;
    state.hallView.bld = name;
    ensureHallAt(loc, name);                  // creates the building's Hall 1
    renderHallTabs(); update();
    return;
  }
  state.hallView.bld = this.value;
  ensureHallAt(state.hallView.loc, this.value);
  renderHallTabs(); update();
});

// Add-city form (next to the Location picker): saves a custom site to this
// device, then navigates to it — same flow as picking a catalog location.
document.getElementById('addcity-toggle').addEventListener('click', () => {
  const f = document.getElementById('addcity-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('ac-cancel').addEventListener('click', () => {
  document.getElementById('addcity-form').style.display = 'none';
});
document.getElementById('ac-save').addEventListener('click', () => {
  const code  = document.getElementById('ac-code').value.trim();
  const city  = document.getElementById('ac-city').value.trim();
  const stRaw = document.getElementById('ac-state').value.trim();
  const elev  = parseFloat(document.getElementById('ac-elev').value);
  if (!code || !city || !stRaw) { toast('Site code, city, and state are required.', { kind: 'warn' }); return; }
  if (isNaN(elev)) { toast('Enter a numeric elevation in feet.', { kind: 'warn' }); return; }
  // Title-case the state so it sorts/labels consistently.
  const stName = stRaw.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  customSites.push({ state: stName, city, code, elevFt: Math.round(elev), custom: true });
  persistCustomSites();
  state.hallView.loc = `${city}, ${stAbbr(stName)}`;
  state.hallView.bld = '';
  ensureHallAt(state.hallView.loc, '');
  document.getElementById('addcity-form').style.display = 'none';
  ['ac-code', 'ac-city', 'ac-state', 'ac-elev'].forEach(id => { document.getElementById(id).value = ''; });
  applyElevation(); renderHallTabs(); renderHallEditor(); update();
});

document.getElementById('hall-add').addEventListener('click', () => {
  // Seed the new hall from the active view: same location/building as the
  // current selection and that site's elevation, so it appears in the tab
  // list you're looking at instead of vanishing behind the filter. Numbering
  // counts within the view, so each building gets its own Hall 1, 2, 3…
  const v = state.hallView;
  const sib = state.hallProfiles.find(h => v.loc && (h.siteName || '').trim() === v.loc);
  const site = v.loc ? allSites().find(s => s.siteName === v.loc) : null;
  state.hallProfiles.push(normalizeHall({
    name: `Hall ${state.hallProfiles.filter(hallVisible).length + 1}`,
    siteName: v.loc || '', building: v.bld || '',
    elevFt: sib ? sib.elevFt : (site ? site.elevFt : 0),
  }));
  state.activeHall = state.hallProfiles.length - 1;
  applyElevation(); renderHallTabs(); renderHallEditor(); update();
});

document.getElementById('hall-dup').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(state.hall));
  copy.name = `${copy.name || 'Hall'} (copy)`;
  copy.results = [];   // logged results belong to the physical hall they came from
  state.hallProfiles.push(normalizeHall(copy));
  state.activeHall = state.hallProfiles.length - 1;
  applyElevation(); renderHallTabs(); renderHallEditor(); update();
});

document.getElementById('hall-del').addEventListener('click', async () => {
  if (state.hallProfiles.length <= 1) return;
  const ok = await confirmDialog({
    title: 'Delete hall profile?',
    message: `"${state.hall.name || 'This hall'}" and its equipment settings and logged results will be removed. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  state.hallProfiles.splice(state.activeHall, 1);
  state.activeHall = Math.max(0, state.activeHall - 1);
  applyElevation(); renderHallTabs(); renderHallEditor(); update();
});

document.getElementById('hall-export').addEventListener('click', () => {
  const payload = { app:'SDC Hall Environment Planner', kind:'hallProfiles', version:4,
                    exported:new Date().toISOString(), hallProfiles: state.hallProfiles };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'sdc_hall_profiles.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('hall-import').addEventListener('click', () => document.getElementById('hall-file').click());
document.getElementById('hall-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      // Accept: v4 halls file, a full-config export (hallProfiles), a bare
      // array of halls, or a legacy v3 file carrying a single `hall` object.
      const incoming = Array.isArray(data) ? data
        : Array.isArray(data.hallProfiles) ? data.hallProfiles
        : data.hall ? [data.hall] : null;
      if (!incoming || !incoming.length) throw new Error('No hall profiles in this file');
      let firstIdx = -1;
      incoming.forEach(h => {
        if (!h || typeof h !== 'object') return;
        normalizeHall(h);
        // Merge by location + building + hall name: same triple replaces,
        // anything else appends — so a colleague's file adds to your list
        // instead of wiping it, and "Hall 1" in two buildings never collide.
        const i = state.hallProfiles.findIndex(x => x.name === h.name
          && (x.siteName || '') === (h.siteName || '')
          && (x.building || '') === (h.building || ''));
        if (i >= 0) { state.hallProfiles[i] = h; if (firstIdx < 0) firstIdx = i; }
        else { state.hallProfiles.push(h); if (firstIdx < 0) firstIdx = state.hallProfiles.length - 1; }
      });
      if (firstIdx >= 0) state.activeHall = firstIdx;
      applyElevation(); renderHallTabs(); renderHallEditor(); update();
    } catch (err) {
      logError('import-halls', err);
      toast('Could not import halls: ' + err.message, { kind: 'error' });
    }
  };
  reader.readAsText(file);
  this.value = ''; // allow re-importing same file
});

function renderSlaEditor() {
  const sla = state.slaProfiles[state.activeSla];
  const ed = document.getElementById('sla-editor');
  const lock = sla.locked ? 'disabled' : '';
  // The contract is STORED in °F but EDITED in the active display unit — this
  // is the one card where the customer's numbers get typed in, and it used to
  // be the one card that ignored the °C toggle. Absolute temps convert via
  // tU(); the per-hour ramp limit is a DELTA (°C deltas scale, they don't
  // offset), so it goes through the delta converters instead.
  const showT = (f) => (f == null ? '' : svFmtT(f));
  const showDT = (dF) => (dF == null ? '' : (Math.round(dispDeltaT(dF) * 10) / 10).toString());
  ed.innerHTML = `
    <div class="sla-field name-field">
      <label>Profile name</label>
      <input type="text" id="sla-name" value="${sla.name.replace(/"/g,'&quot;')}" ${lock}>
    </div>
    <div class="sla-field"><label>Temp min <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-tmin" value="${showT(sla.tMinF)}" step="0.5" ${lock}></div>
    <div class="sla-field"><label>Temp max <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-tmax" value="${showT(sla.tMaxF)}" step="0.5" ${lock}></div>
    <div class="sla-field"><label>RH min %</label><input type="number" id="sla-rhmin" value="${sla.rhMin}" step="1" ${lock}></div>
    <div class="sla-field"><label>RH max %</label><input type="number" id="sla-rhmax" value="${sla.rhMax}" step="1" ${lock}></div>
    <div class="sla-field"><label>Dew pt cap <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-dpmax" value="${showT(sla.dpMaxF != null && sla.dpMaxF !== '' ? Number(sla.dpMaxF) : null)}" step="0.5" placeholder="none" ${lock}></div>
    <div class="sla-field"><label>Max ΔT /hr ${deltaLabel()}</label><input type="number" id="sla-dthr" value="${showDT(sla.maxDtHr)}" step="0.5" placeholder="none" ${lock}></div>
    <div class="sla-field"><label>Max ΔRH /hr %</label><input type="number" id="sla-drhhr" value="${sla.maxDrhHr ?? ''}" step="1" placeholder="none" ${lock}></div>
  `;
  if (!sla.locked) {
    // conv: display value → canonical °F (absolute or delta); identity for RH.
    const dtToF = (v) => v / deltaFromF(1, state.tempUnit || 'F');
    const bind = (id, key, conv) => {
      document.getElementById(id).addEventListener('input', function() {
        if (conv) {
          const v = this.value === '' ? null : parseFloat(this.value);
          sla[key] = (v === null || isNaN(v)) ? null : conv(v);
        } else {
          sla[key] = this.value;
          renderSlaTabs();
        }
        update();
      });
    };
    const idF = (v) => v;
    bind('sla-name','name',null);
    bind('sla-tmin','tMinF',(v) => tU().toF(v)); bind('sla-tmax','tMaxF',(v) => tU().toF(v));
    bind('sla-rhmin','rhMin',idF); bind('sla-rhmax','rhMax',idF);
    bind('sla-dpmax','dpMaxF',(v) => tU().toF(v));
    bind('sla-dthr','maxDtHr',dtToF); bind('sla-drhhr','maxDrhHr',idF);
  }
  document.getElementById('sla-del').disabled = sla.locked || state.slaProfiles.length <= 1;
}

document.getElementById('sla-add').addEventListener('click', () => {
  const base = state.slaProfiles[state.activeSla];
  state.slaProfiles.push({
    name: 'Customer ' + (state.slaProfiles.length),
    tMinF: base.tMinF, tMaxF: base.tMaxF, rhMin: base.rhMin, rhMax: base.rhMax,
    dpMaxF: base.dpMaxF ?? null,
    maxDtHr: base.maxDtHr ?? 18, maxDrhHr: base.maxDrhHr ?? 20,
  });
  state.activeSla = state.slaProfiles.length - 1;
  applyElevation(); renderSlaTabs(); renderSlaEditor(); update();
});

document.getElementById('sla-del').addEventListener('click', () => {
  const sla = state.slaProfiles[state.activeSla];
  if (sla.locked || state.slaProfiles.length <= 1) return;
  state.slaProfiles.splice(state.activeSla, 1);
  state.activeSla = Math.max(0, state.activeSla - 1);
  applyElevation(); renderSlaTabs(); renderSlaEditor(); update();
});

// "All" / "None" quick controls for the legend (show/hide every boundary).
function setAllVisible(on) {
  ['Rec','A1','A2','A3','A4','SLA','plan','timepts','specvol','enthalpy'].forEach(k => state.visible[k] = on);
  state.showEnvelopes = on;
  syncLegend(); update();
}
document.getElementById('leg-all').addEventListener('click', () => setAllVisible(true));
document.getElementById('leg-none').addEventListener('click', () => setAllVisible(false));

// Per-item legend toggles — tap to show/hide that boundary on the chart.
function syncLegend() {
  document.querySelectorAll('#legend .leg-item').forEach(btn => {
    btn.classList.toggle('leg-off', !state.visible[btn.dataset.vis]);
  });
}
document.querySelectorAll('#legend .leg-item').forEach(btn => {
  btn.addEventListener('click', function() {
    const k = this.dataset.vis;
    state.visible[k] = !state.visible[k];
    if (['A1','A2','A3','A4'].includes(k)) {
      state.showEnvelopes = ['A1','A2','A3','A4'].some(z => state.visible[z]);
    }
    syncLegend(); update();
  });
});

// ════════════════════════════════════════════════════════════
//  PERSISTENCE — platform storage + JSON export/import
//  Quota failures surface as a toast (see persistJSON); the export/
//  import path is always available as the reliable fallback.
// ════════════════════════════════════════════════════════════
function saveProfiles() {
  persistJSON(LS_KEY_V4, buildStoredState(state));
}

/**
 * Restore persisted profiles. Parsing and cross-version migration live in
 * src/state/persistence.js (pure, fixture-tested); this only reads storage and
 * applies the returned patch, so a corrupt payload can never half-apply.
 */
function loadProfiles() {
  try {
    const { found, patch } = parseStoredState(
      {
        v4: storage.get(LS_KEY_V4),
        v3: storage.get(LS_KEY_V3),
        v1: storage.get(LS_KEY_V1),
      },
      state.hall,
    );
    if (!found) return false;

    if (patch.hallProfiles) {
      state.hallProfiles = patch.hallProfiles;
      state.activeHall = patch.activeHall ?? 0;
    }
    if (patch.hall) state.hall = patch.hall; // v3: single hall onto the active slot
    if (patch.hallView) state.hallView = patch.hallView;
    if (patch.slaProfiles) {
      state.slaProfiles = patch.slaProfiles;
      normalizeCaps(state.slaProfiles);
    }
    if (patch.activeSla != null) {
      state.activeSla = Math.min(patch.activeSla, state.slaProfiles.length - 1);
    }
    if (patch.tempUnit) state.tempUnit = patch.tempUnit;
    return true;
  } catch (e) {
    logError('loadProfiles', e);
  }
  return false;
}

// (persistence is now called directly inside update())

document.getElementById('sla-export').addEventListener('click', () => {
  const payload = { app:'SDC Hall Environment Planner', version:4, exported:new Date().toISOString(),
                    tempUnit: state.tempUnit, hallProfiles: state.hallProfiles, activeHall: state.activeHall,
                    slaProfiles: state.slaProfiles };
  platformSaveFile('sdc_sla_profiles.json', JSON.stringify(payload, null, 2));
});

document.getElementById('sla-import').addEventListener('click', () => document.getElementById('sla-file').click());
document.getElementById('sla-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data.slaProfiles)) throw new Error('No slaProfiles array');
      // v4 files carry the full hall list; v3 files carry a single hall.
      if (Array.isArray(data.hallProfiles) && data.hallProfiles.length) {
        state.hallProfiles = data.hallProfiles.map(h => normalizeHall(h));
        state.activeHall = Math.min(data.activeHall || 0, state.hallProfiles.length - 1);
      } else if (data.hall) {
        const merged = Object.assign({}, state.hall, data.hall);
        if (!data.hall.name) merged.name = '';   // let normalizeHall name it from its site
        state.hall = normalizeHall(merged);
      }
      const hasLocked = data.slaProfiles.some(s => s.locked);
      state.slaProfiles = hasLocked ? data.slaProfiles
        : [{ name:'Base SLA', tMinF:50, tMaxF:95, rhMin:5, rhMax:80, dpMaxF:null, maxDtHr:18, maxDrhHr:20, locked:true }, ...data.slaProfiles];
      state.slaProfiles.forEach(s => {
        if (s.maxDtHr === undefined) s.maxDtHr = 18;
        if (s.maxDrhHr === undefined) s.maxDrhHr = 20;
      });
      normalizeCaps(state.slaProfiles);
      state.activeSla = 0;
      if (data.tempUnit) state.tempUnit = data.tempUnit;
      applyElevation();
      renderSlaTabs(); renderSlaEditor(); renderHallTabs(); renderHallEditor(); update();
    } catch (err) {
      logError('import-slas', err);
      toast('Could not import: ' + err.message, { kind: 'error' });
    }
  };
  reader.readAsText(file);
  this.value = ''; // allow re-importing same file
});

// ════════════════════════════════════════════════════════════
//  CHART ZOOM & PAN  (independent of page scroll)
//  The plot is anchored at freezing (0°C) and W=0 on the lower-left,
//  but extends without a hard wall up (humidity ratio) and right
//  (temperature) — curves are drawn across whatever the view shows.
// ════════════════════════════════════════════════════════════
const MIN_T_SPAN = 0.4, MIN_HR_SPAN = 0.2;  // tightest zoom in — fine enough for sub-degree/sub-g work
const MAX_T = 200, MAX_HR = 200;           // effective "infinity" ceiling for drawing
function clampView() {
  // tightest zoom
  if (view.tMax - view.tMin < MIN_T_SPAN) { const c=(view.tMin+view.tMax)/2; view.tMin=c-MIN_T_SPAN/2; view.tMax=c+MIN_T_SPAN/2; }
  if (view.hrMax - view.hrMin < MIN_HR_SPAN) { const c=(view.hrMin+view.hrMax)/2; view.hrMin=c-MIN_HR_SPAN/2; view.hrMax=c+MIN_HR_SPAN/2; }
  // anchor the lower-left at the physical floor (freezing-ish / dry air),
  // but allow the top and right to run far out toward "infinity"
  if (view.tMin < PC.tMin) { const span=view.tMax-view.tMin; view.tMin=PC.tMin; view.tMax=PC.tMin+span; }
  if (view.hrMin < PC.hrMin) { const span=view.hrMax-view.hrMin; view.hrMin=PC.hrMin; view.hrMax=PC.hrMin+span; }
  if (view.tMax > MAX_T) view.tMax = MAX_T;
  if (view.hrMax > MAX_HR) view.hrMax = MAX_HR;
}

function zoomAt(px, py, factor) {
  if (!lastGeom) return;
  const { W, H, pad } = lastGeom;
  // anchor zoom on the data point under the cursor
  const [atc, ahr] = fromXY(px, py, W, H, pad);
  view.tMin = atc - (atc - view.tMin) * factor;
  view.tMax = atc + (view.tMax - atc) * factor;
  view.hrMin = ahr - (ahr - view.hrMin) * factor;
  view.hrMax = ahr + (view.hrMax - ahr) * factor;
  clampView();
  drawChart();
}

function zoomCenter(factor) {
  if (!lastGeom) return;
  const { W, H, pad } = lastGeom;
  zoomAt((pad.l + W - pad.r)/2, (pad.t + H - pad.b)/2, factor);
}

function zoomToSLA() {
  const sla = state.slaProfiles[state.activeSla];
  const pts = slaPolygon(sla, state.pressure);
  let tmin=Infinity,tmax=-Infinity,hmin=Infinity,hmax=-Infinity;
  pts.forEach(([t,h])=>{ tmin=Math.min(tmin,t);tmax=Math.max(tmax,t);hmin=Math.min(hmin,h);hmax=Math.max(hmax,h); });
  const tpad=(tmax-tmin)*0.25+1, hpad=(hmax-hmin)*0.25+0.5;
  view.tMin=tmin-tpad; view.tMax=tmax+tpad; view.hrMin=Math.max(0,hmin-hpad); view.hrMax=hmax+hpad;
  clampView(); drawChart();
}

// Frame the A→B change plan: fit both points with margin so the move fills the view.
function zoomToPlan() {
  const p = state.pressure;
  const tA=fToC(state.aTemp), wA=humidityRatioG(tA,state.aRH,p);
  const tB=fToC(state.bTemp), wB=humidityRatioG(tB,state.bRH,p);
  const tmin=Math.min(tA,tB), tmax=Math.max(tA,tB);
  const hmin=Math.min(wA,wB), hmax=Math.max(wA,wB);
  const tspan=Math.max(tmax-tmin,4), hspan=Math.max(hmax-hmin,3);
  const tpad=tspan*0.4+1, hpad=hspan*0.5+1;
  view.tMin=tmin-tpad; view.tMax=tmax+tpad;
  view.hrMin=Math.max(0,hmin-hpad); view.hrMax=hmax+hpad;
  clampView(); drawChart();
}

// Center the current view on the midpoint of A and B without changing zoom level.
function centerView() {
  const p = state.pressure;
  const tA=fToC(state.aTemp), wA=humidityRatioG(tA,state.aRH,p);
  const tB=fToC(state.bTemp), wB=humidityRatioG(tB,state.bRH,p);
  const cT=(tA+tB)/2, cW=(wA+wB)/2;
  const tHalf=(view.tMax-view.tMin)/2, hHalf=(view.hrMax-view.hrMin)/2;
  view.tMin=cT-tHalf; view.tMax=cT+tHalf;
  view.hrMin=cW-hHalf; view.hrMax=cW+hHalf;
  clampView(); drawChart();
}

(function attachChartInteractions(){
  const canvas = document.getElementById('psychCanvas');
  function localXY(e){
    const r = canvas.getBoundingClientRect();
    const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    return [cx, cy];
  }
  // Wheel zoom — preventDefault stops the PAGE from scrolling
  canvas.addEventListener('wheel', (e)=>{
    e.preventDefault();
    const [px,py] = localXY(e);
    zoomAt(px, py, e.deltaY < 0 ? 0.88 : 1/0.88);
    updateHover(px, py);   // keep the inspector in sync with the new view
  }, { passive:false });

  // ── Hover inspector: crosshair + live psychrometric readout ──
  // Mouse-only (pointer:fine); hidden while dragging or outside the plot rect.
  const vline = document.getElementById('ch-vline');
  const hline = document.getElementById('ch-hline');
  const tip   = document.getElementById('chart-tip');
  const finePointer = window.matchMedia && matchMedia('(pointer:fine)').matches;
  function hideHover() {
    if (vline) vline.style.display = 'none';
    if (hline) hline.style.display = 'none';
    if (tip)   tip.style.display = 'none';
  }
  function updateHover(px, py) {
    if (!finePointer || dragging || !lastGeom || !tip) { hideHover(); return; }
    const { W, H, pad } = lastGeom;
    if (px < pad.l || px > W - pad.r || py < pad.t || py > H - pad.b) { hideHover(); return; }
    const [tc, hr] = fromXY(px, py, W, H, pad);
    const { rh } = rhAtPoint(tc, hr);
    const p = state.pressure;
    const tF = cToF(tc);
    let body;
    if (rh > 100.001) {
      body = `<div class="tt-head">${dispTs(tF)}${tLabel()} · fog</div>
        <div class="tt-row"><span class="tt-k">W</span><span>${hr.toFixed(2)} g/kg</span></div>
        <div class="tt-sla" style="color:var(--warn)">above saturation — supersaturated</div>`;
    } else {
      const d = deriveState(tc, rh, p);
      const dpC = d.tdpC, wbC = d.twbC, h = d.h, zone = d.zone;
      const chk = checkSLA(tF, rh);
      body = `<div class="tt-head">${dispTs(tF)}${tLabel()} · ${rh.toFixed(0)}% RH</div>
        <div class="tt-row"><span class="tt-k">W</span><span>${hr.toFixed(2)} g/kg</span></div>
        <div class="tt-row"><span class="tt-k">Dew pt</span><span>${dpC != null ? dispTs(cToF(dpC)) + ' ' + tLabel() : '—'}</span></div>
        <div class="tt-row"><span class="tt-k">Wet bulb</span><span>${dispTs(cToF(wbC))} ${tLabel()}</span></div>
        <div class="tt-row"><span class="tt-k">Enthalpy</span><span>${h.toFixed(1)} kJ/kg</span></div>
        <div class="tt-row"><span class="tt-k">ASHRAE</span><span class="zpill z${zone}">${zone}</span></div>
        <div class="tt-sla" style="color:${chk.ok ? 'var(--ok)' : 'var(--danger)'}">${chk.ok ? '✓ within SLA' : '✗ ' + fmtSlaReason(chk)}</div>`;
    }
    tip.innerHTML = body;
    vline.style.cssText = `display:block; left:${px}px; top:${pad.t}px; height:${H - pad.t - pad.b}px;`;
    hline.style.cssText = `display:block; top:${py}px; left:${pad.l}px; width:${W - pad.l - pad.r}px;`;
    tip.style.display = 'block';
    // flip the tooltip to whichever side of the cursor has room
    const tw = tip.offsetWidth || 170, th = tip.offsetHeight || 120;
    tip.style.left = (px + 16 + tw > W ? px - tw - 14 : px + 16) + 'px';
    tip.style.top  = Math.max(2, Math.min(py - th / 2, H - th - 2)) + 'px';
  }
  canvas.addEventListener('mousemove', (e)=>{ const [px,py]=localXY(e); updateHover(px,py); });
  canvas.addEventListener('mouseleave', hideHover);

  // Drag to pan · a still click (<5px travel) with a modifier SETS a point:
  // Shift-click places Target, Alt-click places Current — plan by pointing.
  let dragging=false, lastPx=0, lastPy=0, dragDist=0;
  canvas.addEventListener('mousedown', (e)=>{ dragging=true; dragDist=0; [lastPx,lastPy]=localXY(e); canvas.classList.add('grabbing'); hideHover(); });
  window.addEventListener('mousemove', (e)=>{
    if(!dragging||!lastGeom) return;
    const r=canvas.getBoundingClientRect();
    const px=e.clientX-r.left, py=e.clientY-r.top;
    const { W,H,pad }=lastGeom;
    const dT=(px-lastPx)/(W-pad.l-pad.r)*(view.tMax-view.tMin);
    const dH=(py-lastPy)/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
    view.tMin-=dT; view.tMax-=dT; view.hrMin+=dH; view.hrMax+=dH; // y inverted
    dragDist += Math.abs(px-lastPx)+Math.abs(py-lastPy);
    lastPx=px; lastPy=py; drawChart();
  });
  window.addEventListener('mouseup', (e)=>{
    if (dragging && dragDist < 5 && (e.shiftKey || e.altKey) && lastGeom) {
      const { W, H, pad } = lastGeom;
      if (lastPx >= pad.l && lastPx <= W - pad.r && lastPy >= pad.t && lastPy <= H - pad.b) {
        const [tc, hr] = fromXY(lastPx, lastPy, W, H, pad);
        const { rh } = rhAtPoint(tc, hr);
        const tF = cToF(tc);
        if (e.shiftKey) { state.bTemp = clampTargetF(tF); state.bRH = clampRH(rh); }
        else            { state.aTemp = clampF(tF);       state.aRH = clampRH(rh); }
        syncAllControls(); update();
      }
    }
    dragging=false; canvas.classList.remove('grabbing');
  });

  // Double-click reset
  canvas.addEventListener('dblclick', (e)=>{ e.preventDefault(); resetView(); drawChart(); });

  // Touch: pinch zoom + one-finger pan
  let pinchDist=0, pinchMid=null, touchPan=null;
  canvas.addEventListener('touchstart',(e)=>{
    if(e.touches.length===2){
      e.preventDefault();
      pinchDist=touchDistance(e); pinchMid=touchMidpoint(e, canvas);
    } else if(e.touches.length===1){
      const [px,py]=localXY(e); touchPan=[px,py];
    }
  },{passive:false});
  canvas.addEventListener('touchmove',(e)=>{
    if(e.touches.length===2){
      e.preventDefault();
      const d=touchDistance(e);
      if(pinchDist>0 && pinchMid){ zoomAt(pinchMid[0],pinchMid[1], pinchDist/d); }
      pinchDist=d; pinchMid=touchMidpoint(e,canvas);
    } else if(e.touches.length===1 && touchPan && lastGeom){
      e.preventDefault();
      const r=canvas.getBoundingClientRect();
      const px=e.touches[0].clientX-r.left, py=e.touches[0].clientY-r.top;
      const {W,H,pad}=lastGeom;
      const dT=(px-touchPan[0])/(W-pad.l-pad.r)*(view.tMax-view.tMin);
      const dH=(py-touchPan[1])/(H-pad.t-pad.b)*(view.hrMax-view.hrMin);
      view.tMin-=dT; view.tMax-=dT; view.hrMin+=dH; view.hrMax+=dH;
      touchPan=[px,py]; drawChart();
    }
  },{passive:false});
  canvas.addEventListener('touchend',(e)=>{ if(e.touches.length===0){pinchDist=0;touchPan=null;} });

  function touchDistance(e){ const a=e.touches[0],b=e.touches[1]; return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); }
  function touchMidpoint(e,canvas){ const r=canvas.getBoundingClientRect(); const a=e.touches[0],b=e.touches[1]; return [((a.clientX+b.clientX)/2)-r.left, ((a.clientY+b.clientY)/2)-r.top]; }

  document.getElementById('zoom-in').onclick = ()=>zoomCenter(0.8);
  document.getElementById('zoom-out').onclick = ()=>zoomCenter(1/0.8);
  document.getElementById('zoom-sla').onclick = zoomToSLA;
  document.getElementById('zoom-plan').onclick = zoomToPlan;
  document.getElementById('zoom-center').onclick = centerView;
  document.getElementById('zoom-reset').onclick = ()=>{ resetView(); drawChart(); };
})();

// ════════════════════════════════════════════════════════════
//  SCENARIOS — save / load / share named operating states
//  A scenario captures Current+Target (temp & RH), the active SLA
//  index, and the temp unit. Persisted via platform storage; also
//  exportable/importable as a JSON file for sharing with colleagues.
// ════════════════════════════════════════════════════════════
const SCN_KEY = 'sdc_psychro_scenarios_v1';
let scenarios = [];

function loadScenarios() {
  try {
    const raw = storage.get(SCN_KEY);
    scenarios = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(scenarios)) scenarios = [];
  } catch (e) { logError('loadScenarios', e); scenarios = []; }
}
function persistScenarios() {
  persistJSON(SCN_KEY, scenarios);
}
function captureScenario(name) {
  return {
    name: name || `Scenario ${scenarios.length + 1}`,
    saved: new Date().toISOString(),
    aTemp: state.aTemp, aRH: state.aRH,
    bTemp: state.bTemp, bRH: state.bRH,
    activeSla: state.activeSla,
    slaName: state.slaProfiles[state.activeSla]?.name || '',
    hallName: state.hall?.name || '',
    tempUnit: state.tempUnit,
  };
}
function applyScenario(s) {
  // Restore the hall it was planned in (matched by name), if we still have it.
  if (s.hallName) {
    const hi = state.hallProfiles.findIndex(h => h.name === s.hallName);
    if (hi >= 0 && hi !== state.activeHall) {
      state.activeHall = hi;
      renderHallTabs(); renderHallEditor();
    }
  }
  // Prefer matching the SLA by NAME (robust when scenario files are shared
  // between people whose profile lists differ); index is the fallback.
  let idx = s.slaName ? state.slaProfiles.findIndex(pr => pr.name === s.slaName) : -1;
  if (idx < 0 && s.activeSla != null && s.activeSla < state.slaProfiles.length) idx = s.activeSla;
  if (idx >= 0) {
    state.activeSla = idx;
    applyElevation();
  }
  if (s.tempUnit) state.tempUnit = s.tempUnit;
  state.aTemp = s.aTemp; state.aRH = s.aRH;
  state.bTemp = clampTargetF(s.bTemp);
  state.bRH   = clampRH(s.bRH);
  syncAllControls(); renderSlaTabs(); renderSlaEditor(); syncLegend(); update();
}
function renderScenarios() {
  const list = document.getElementById('scn-list');
  if (!list) return;
  if (!scenarios.length) {
    list.innerHTML = `<div class="scn-empty">No saved scenarios yet. Set up a Current → Target case and tap Save.</div>`;
    return;
  }
  list.innerHTML = scenarios.map((s, i) => {
    const u = s.tempUnit === 'C' ? '°C' : '°F';
    const cv = t => s.tempUnit === 'C' ? Math.round((t - 32) * 5 / 9) : Math.round(t);
    return `<div class="scn-item">
      <div class="scn-item-main" data-idx="${i}">
        <div class="scn-item-name">${(s.name || '').replace(/</g,'&lt;')}</div>
        <div class="scn-item-detail">${cv(s.aTemp)}${u}/${Math.round(s.aRH)}% → ${cv(s.bTemp)}${u}/${Math.round(s.bRH)}% · ${(s.slaName||'').replace(/</g,'&lt;')}</div>
      </div>
      <button class="scn-load" data-load="${i}">Load</button>
      <button class="scn-del" data-del="${i}" title="Delete">✕</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => applyScenario(scenarios[+b.dataset.load])));
  list.querySelectorAll('.scn-item-main').forEach(b => b.addEventListener('click', () => applyScenario(scenarios[+b.dataset.idx])));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    scenarios.splice(+b.dataset.del, 1); persistScenarios(); renderScenarios();
  }));
}

document.getElementById('scn-save').addEventListener('click', () => {
  const inp = document.getElementById('scn-name');
  scenarios.push(captureScenario(inp.value.trim()));
  inp.value = '';
  persistScenarios(); renderScenarios();
});
document.getElementById('scn-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('scn-save').click(); });

// Export / import scenarios as a shareable file
document.getElementById('scn-export-file').addEventListener('click', () => {
  const payload = { app:'SDC Psychrometric Scenarios', version:1, exported:new Date().toISOString(), scenarios };
  platformSaveFile('sdc_scenarios.json', JSON.stringify(payload, null, 2));
});
document.getElementById('scn-import-file').addEventListener('click', () => document.getElementById('scn-file').click());
document.getElementById('scn-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      const incoming = Array.isArray(data) ? data : data.scenarios;
      if (!Array.isArray(incoming)) throw new Error('No scenarios array');
      // Merge (append) imported scenarios so a colleague's file adds to yours.
      scenarios = scenarios.concat(incoming.filter(isValidScenario));
      persistScenarios(); renderScenarios();
    } catch (err) { logError('import-scenarios', err); toast('Could not import scenarios: ' + err.message, { kind: 'error' }); }
  };
  reader.readAsText(file); this.value = '';
});

// ════════════════════════════════════════════════════════════
//  SAVE FILE — the whole workspace in one shareable JSON:
//  halls (with their equipment), SLAs, custom sites, scenarios.
//  Loading MERGES: same keys update, new entries append — a
//  colleague's file adds to yours, it never wipes your data.
// ════════════════════════════════════════════════════════════
function buildSaveFile() {
  return {
    app: 'SDC Hall Environment Planner', kind: 'saveFile', version: 1,
    exported: new Date().toISOString(),
    hallProfiles: state.hallProfiles,
    slaProfiles: state.slaProfiles,
    customSites,
    scenarios,
    sensorLog,
    tempUnit: state.tempUnit,
  };
}
function saveFileName() {
  return `sdc_planner_save_${new Date().toISOString().slice(0, 10)}.json`;
}
function downloadSaveFile() {
  platformSaveFile(saveFileName(), JSON.stringify(buildSaveFile(), null, 2));
}
function mergeSaveFile(data) {
  // Validate the WHOLE payload before touching state — an import either applies
  // cleanly or not at all (v1 could half-apply then throw).
  const v = validateSaveFile(data);
  if (!v.ok) throw new Error(v.error);
  let halls = 0, slas = 0, sites = 0, scns = 0, logs = 0;
  v.sensorLog.forEach((e) => {
    if (!sensorLog.some((x) => x.sensor === e.sensor && x.date === e.date && x.method === e.method)) {
      sensorLog.push(e);
      logs++;
    }
  });
  if (logs) {
    persistSensorLog();
    renderSensorLogbook();
  }
  v.halls.forEach(h => {
    const i = state.hallProfiles.findIndex(x => x.name === h.name
      && (x.siteName || '') === (h.siteName || '')
      && (x.building || '') === (h.building || ''));
    if (i >= 0) state.hallProfiles[i] = h; else state.hallProfiles.push(h);
    halls++;
  });
  v.slas.forEach(s => {
    const i = state.slaProfiles.findIndex(x => x.name === s.name);
    if (i >= 0) { if (!state.slaProfiles[i].locked) { state.slaProfiles[i] = s; slas++; } }
    else { state.slaProfiles.push(s); slas++; }
  });
  v.sites.forEach(c => {
    if (customSites.some(x => x.code === c.code && x.city === c.city && x.state === c.state)) return;
    customSites.push(c); sites++;
  });
  v.scenarios.forEach(s => {
    // Skip exact duplicates (same name + save time) so re-loading a file is a no-op.
    if (scenarios.some(x => x.name === s.name && x.saved === s.saved)) return;
    scenarios.push(s); scns++;
  });
  persistCustomSites(); persistScenarios();
  normalizeCaps(state.slaProfiles);
  applyElevation();
  renderSlaTabs(); renderSlaEditor(); renderHallTabs(); renderHallEditor(); renderScenarios(); update();
  return `Loaded: ${halls} hall${halls === 1 ? '' : 's'}, ${slas} SLA${slas === 1 ? '' : 's'}, ${sites} custom site${sites === 1 ? '' : 's'}, ${scns} scenario${scns === 1 ? '' : 's'}${logs ? `, ${logs} sensor check${logs === 1 ? '' : 's'}` : ''}.`;
}

document.getElementById('save-export').addEventListener('click', downloadSaveFile);
document.getElementById('save-share').addEventListener('click', async () => {
  // Native share sheet where available (phones/tablets: AirDrop, Teams,
  // email…); anywhere else the adapter falls back to a plain file download.
  await shareFile(saveFileName(), JSON.stringify(buildSaveFile(), null, 2),
    'Hall Environment Planner save file');
});
document.getElementById('save-import').addEventListener('click', () => document.getElementById('save-file').click());
document.getElementById('save-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      toast(mergeSaveFile(data), { kind: 'ok', duration: 6000 });
    } catch (err) { logError('load-savefile', err); toast('Could not load save file: ' + err.message, { kind: 'error' }); }
  };
  reader.readAsText(file); this.value = '';
});

// ════════════════════════════════════════════════════════════
//  IMAGE / PDF EXPORT — render chart + summary to a shareable file
// ════════════════════════════════════════════════════════════
function buildExportCanvas() {
  const src = document.getElementById('psychCanvas');
  const scale = 2;                       // crisp on retina / when embedded
  const W = 1000, headH = 150, chartH = 560, footH = 70;
  const H = headH + chartH + footH;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const x = c.getContext('2d'); x.scale(scale, scale);

  // Background
  x.fillStyle = '#0d1b2a'; x.fillRect(0, 0, W, H);

  // Header band (Stream navy → teal underline)
  const grad = x.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#1a3a5c'); grad.addColorStop(1, '#13263a');
  x.fillStyle = grad; x.fillRect(0, 0, W, headH);
  x.fillStyle = '#00a9ce'; x.fillRect(0, headH - 4, W, 4);

  x.fillStyle = '#fff'; x.font = '800 26px -apple-system,Segoe UI,sans-serif';
  x.textBaseline = 'top';
  x.fillText('STREAM', 28, 22);
  x.fillStyle = '#00a9ce'; x.font = '600 12px -apple-system,Segoe UI,sans-serif';
  x.fillText('DATA CENTERS', 130, 30);
  x.fillStyle = '#fff'; x.font = '700 20px -apple-system,Segoe UI,sans-serif';
  x.fillText('Hall Environment Planner', 28, 60);

  // Operating summary line
  const sla = state.slaProfiles[state.activeSla];
  const U = tLabel();
  x.fillStyle = '#9db8d0'; x.font = '13px -apple-system,Segoe UI,sans-serif';
  x.fillText(`${state.hall.name || 'Hall'}  ·  ${sla.name}  ·  ${state.hall.siteName || '—'}  ·  ${(state.hall.elevFt ?? 0).toLocaleString()} ft  ·  ${state.pressure.toFixed(2)} kPa  ·  eff ${Math.round(state.hall.effPct ?? 100)}%`, 28, 92);
  x.fillStyle = '#e6edf3'; x.font = '600 15px -apple-system,Segoe UI,sans-serif';
  const cur = `${dispTs(state.aTemp)}${U} / ${Math.round(state.aRH)}%`;
  const tgt = `${dispTs(state.bTemp)}${U} / ${Math.round(state.bRH)}%`;
  const plan = planMove();
  const planTxt = plan.hours > 0 ? `      ·      est. ≥ ${fmtHrs(plan.hours)} (${plan.binding})` : '';
  x.fillText(`CURRENT  ${cur}      →      TARGET  ${tgt}${planTxt}`, 28, 112);

  // Derived properties, from the same deriveState() the table and readout use —
  // an exported sheet has to stand on its own, and dew point in particular is
  // what SLA caps are written against.
  const dA = deriveStateF(state.aTemp, state.aRH, state.pressure);
  const dB = deriveStateF(state.bTemp, state.bRH, state.pressure);
  const dpTxt = (d) => (d.tdpF != null ? `${dispTs(d.tdpF)}${U}` : '—');
  x.fillStyle = '#9db8d0'; x.font = '12px -apple-system,Segoe UI,sans-serif';
  x.fillText(
    `dew pt ${dpTxt(dA)} → ${dpTxt(dB)}   ·   W ${dA.Wg.toFixed(2)} → ${dB.Wg.toFixed(2)} g/kg   ·   ` +
      `wet bulb ${dispTs(dA.twbF)} → ${dispTs(dB.twbF)}${U}   ·   ASHRAE ${dA.zone} → ${dB.zone}`,
    28,
    132,
  );

  // Chart image
  if (src) {
    try { x.drawImage(src, 20, headH + 10, W - 40, chartH - 20); } catch (e) { logError('export-chart-draw', e); }
  }

  // Footer
  x.fillStyle = '#13263a'; x.fillRect(0, H - footH, W, footH);
  x.fillStyle = '#00a9ce'; x.fillRect(0, H - footH, W, 3);
  x.fillStyle = '#9db8d0'; x.font = '11px -apple-system,Segoe UI,sans-serif';
  x.fillText('ASHRAE TC 9.9 psychrometrics · barometric pressure corrected for site elevation · generated ' + new Date().toLocaleString(), 28, H - footH + 22);
  x.fillStyle = '#6f8aa3'; x.font = '10px -apple-system,Segoe UI,sans-serif';
  x.fillText('Stream Data Centers — Critical Engineering Tool', 28, H - footH + 42);

  return c;
}
/**
 * The door placard: one printable page per hall — envelope snapshot, the
 * do-not-cross numbers, site pressure basis, and a QR deep-link to the live
 * planner. Meant to be laminated and taped to the hall door.
 */
function buildPlacardCanvas() {
  const scale = 2;
  const W = 620, H = 850;
  const c = document.createElement('canvas');
  c.width = W * scale; c.height = H * scale;
  const x = c.getContext('2d');
  x.scale(scale, scale);

  x.fillStyle = '#0d1b2a'; x.fillRect(0, 0, W, H);
  // Header band
  x.fillStyle = '#1a3a5c'; x.fillRect(0, 0, W, 64);
  x.fillStyle = '#00a9ce'; x.fillRect(0, 64, W, 3);
  x.fillStyle = '#ffffff'; x.font = 'bold 20px sans-serif'; x.textAlign = 'left';
  x.fillText('HALL ENVIRONMENT LIMITS', 24, 30);
  x.fillStyle = '#9db8d0'; x.font = '12px sans-serif';
  x.fillText('Post at the hall door · verify against site instrumentation before acting', 24, 50);

  // Hall identity
  const hall = state.hall || {};
  x.fillStyle = '#e6edf3'; x.font = 'bold 22px sans-serif';
  x.fillText([hall.name, hall.siteName].filter(Boolean).join(' — ') || 'Hall', 24, 100);
  x.fillStyle = '#7d96ad'; x.font = '13px monospace';
  x.fillText(
    `${Math.round(hall.elevFt ?? 0).toLocaleString()} ft · ${state.pressure.toFixed(2)} kPa site pressure — all numbers below are pressure-aware`,
    24, 122,
  );

  // Do-not-cross table from the active SLA
  const sla = state.slaProfiles[state.activeSla] || {};
  const U = tLabel();
  const rows = [
    ['Temperature', `${dispTs(sla.tMinF)} ${U}`, `${dispTs(sla.tMaxF)} ${U}`],
    ['Relative humidity', `${sla.rhMin}%`, `${sla.rhMax}%`],
    ...(sla.dpMaxF != null ? [['Dew point (cap)', '—', `${dispTs(sla.dpMaxF)} ${U}`]] : []),
    ...(sla.maxDtHr != null ? [['Ramp: temperature', '—', `${Math.round(dispDeltaT(sla.maxDtHr) * 10) / 10}${deltaLabel()}/hr`]] : []),
    ...(sla.maxDrhHr != null ? [['Ramp: RH', '—', `${sla.maxDrhHr}%/hr`]] : []),
  ];
  let ty = 156;
  x.fillStyle = '#00a9ce'; x.font = 'bold 13px sans-serif';
  x.fillText(`DO NOT CROSS — ${sla.name || 'SLA'}`, 24, ty);
  ty += 10;
  x.font = '13px monospace';
  const cols = [24, 280, 440];
  x.fillStyle = '#7d96ad';
  ['limit', 'min', 'max'].forEach((h, i) => x.fillText(h, cols[i], ty + 20));
  ty += 28;
  x.strokeStyle = '#1f3a52'; x.beginPath(); x.moveTo(24, ty); x.lineTo(W - 24, ty); x.stroke();
  for (const [name, lo, hi] of rows) {
    ty += 24;
    x.fillStyle = '#e6edf3'; x.fillText(name, cols[0], ty);
    x.fillStyle = '#f0a500'; x.fillText(String(lo), cols[1], ty);
    x.fillStyle = '#f85149'; x.fillText(String(hi), cols[2], ty);
  }
  ty += 16;

  // Envelope snapshot — blit the live chart
  const src = document.getElementById('psychCanvas');
  const chartH = 330;
  try {
    x.drawImage(src, 24, ty, W - 48, chartH);
  } catch { /* chart not ready — placard still useful */ }
  ty += chartH + 12;

  // QR deep-link + footer
  const qrCanvas = document.createElement('canvas');
  try {
    drawQr(qrCanvas, currentShareUrl(), 4);
    x.drawImage(qrCanvas, 24, ty, 120, 120);
  } catch { /* URL too long for v10 would throw — placard survives */ }
  x.fillStyle = '#e6edf3'; x.font = 'bold 14px sans-serif';
  x.fillText('Scan for the live planner', 160, ty + 40);
  x.fillStyle = '#7d96ad'; x.font = '12px sans-serif';
  x.fillText('Opens this hall’s current setup — chart, limits and', 160, ty + 62);
  x.fillText('move timing at this site’s pressure. Works offline.', 160, ty + 78);
  x.fillStyle = '#f0a500'; x.font = 'bold 12px sans-serif';
  x.fillText('PLANNING AID, NOT A CONTROL SYSTEM', 160, ty + 106);
  x.fillStyle = '#6f8aa3'; x.font = '11px monospace';
  x.fillText(`generated ${new Date().toISOString().slice(0, 10)} · ${VERSION_LABEL}`, 24, H - 18);
  return c;
}

document.getElementById('export-placard')?.addEventListener('click', () => {
  try {
    exportPdfJpeg(buildPlacardCanvas(), { portrait: true });
  } catch (e) {
    logError('export-placard', e);
    toast('Placard export failed: ' + e.message, { kind: 'error' });
  }
});

document.getElementById('export-png').addEventListener('click', () => {
  try {
    const c = buildExportCanvas();
    c.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'sdc_psychrometric.png';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    }, 'image/png');
  } catch (e) { logError('export-png', e); toast('PNG export failed: ' + e.message, { kind: 'error' }); }
});
document.getElementById('export-pdf').addEventListener('click', () => {
  try {
    const c = buildExportCanvas();
    exportPdfJpeg(c);   // dependency-free single-page PDF (DCTDecode/JPEG)
  } catch (e) { logError('export-pdf', e); toast('PDF export failed: ' + e.message, { kind: 'error' }); }
});
function exportPdfJpeg(canvas, opts = {}) {
  const jpeg = canvas.toDataURL('image/jpeg', 0.92);
  const b64 = jpeg.split(',')[1];
  const raw = atob(b64);
  const imgBytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) imgBytes[i] = raw.charCodeAt(i);
  const imgW = canvas.width, imgH = canvas.height;
  // Letter, landscape by default; the door placard asks for portrait.
  const pageW = opts.portrait ? 612 : 792, pageH = opts.portrait ? 792 : 612, margin = 24;
  const scale = Math.min((pageW - margin*2)/imgW, (pageH - margin*2)/imgH);
  const dW = imgW*scale, dH = imgH*scale, ox = (pageW-dW)/2, oy = (pageH-dH)/2;

  const enc = s => new TextEncoder().encode(s);
  const objOffsets = [];
  const buf = [];
  const add = u8 => buf.push(u8);
  const lenOf = arr => arr.reduce((a,u)=>a+u.length,0);

  add(enc('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n'));
  const recordOffset = () => objOffsets.push(lenOf(buf));

  recordOffset(); add(enc('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  recordOffset(); add(enc('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));
  recordOffset(); add(enc(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`));
  recordOffset();
  add(enc(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imgBytes.length} >>\nstream\n`));
  add(imgBytes);
  add(enc('\nendstream\nendobj\n'));
  const content = `q\n${dW.toFixed(2)} 0 0 ${dH.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm\n/Im0 Do\nQ\n`;
  recordOffset(); add(enc(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`));

  const xrefPos = lenOf(buf);
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  objOffsets.forEach(o => { xref += String(o).padStart(10,'0') + ' 00000 n \n'; });
  add(enc(xref));
  add(enc(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`));

  const blob = new Blob(buf, { type:'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'sdc_psychrometric.pdf';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════════════
// Init
//
// Wrapped in an async bootstrap for ONE reason: on a native shell, durable
// storage (Capacitor Preferences) has to be restored into localStorage before
// anything reads it, and that restore is async. On web `hydrateFromNative()`
// resolves immediately without touching anything, so the boot path is unchanged
// — which is what the E2E boot test on the web build verifies.
// ════════════════════════════════════════════════════════════
//  SHARE: deep links, QR codes, one-tap briefing
// ════════════════════════════════════════════════════════════

/** The current A→B setup as a shareable absolute URL. */
function currentShareUrl() {
  const hash = encodeStateHash({
    aTemp: state.aTemp, aRH: state.aRH, bTemp: state.bTemp, bRH: state.bRH,
    tempUnit: state.tempUnit,
    hallName: state.hall?.name || '',
    slaName: state.slaProfiles[state.activeSla]?.name || '',
    elevFt: state.hall?.elevFt,
  });
  // file:// (the shared single file) has no meaningful base URL to send —
  // point recipients at the hosted app instead; the hash is what matters.
  const base = location.protocol.startsWith('http')
    ? location.href.split('#')[0]
    : 'https://thorhale.github.io/Psychro/';
  return base + hash;
}

/** Apply a deep link's state at boot. Returns true when one was applied. */
function applyStateFromUrl() {
  const s = parseStateHash(location.hash);
  if (!s) return false;
  applyScenario({
    aTemp: s.aTemp, aRH: s.aRH, bTemp: s.bTemp, bRH: s.bRH,
    hallName: s.hallName || '', slaName: s.slaName || '',
    tempUnit: s.tempUnit || state.tempUnit,
  });
  // Pressure honesty: if the named hall isn't on this device, the link's
  // elevation tells us what pressure the SENDER planned at. Never silently
  // edit the local hall — say what happened instead.
  if (s.hallName && state.hall?.name !== s.hallName) {
    const drift =
      s.elevFt != null && Math.abs((state.hall?.elevFt ?? 0) - s.elevFt) > 100
        ? ` They planned at ${Math.round(s.elevFt).toLocaleString()} ft; your active hall is at ${Math.round(state.hall?.elevFt ?? 0).toLocaleString()} ft — pressure-dependent numbers will differ.`
        : '';
    toast(`Opened a shared scenario. Hall "${s.hallName}" isn't on this device — using your active hall.${drift}`, {
      kind: drift ? 'warn' : 'info',
      duration: 9000,
    });
  } else {
    toast('Opened a shared scenario from the link.', { kind: 'ok' });
  }
  return true;
}

document.getElementById('share-link')?.addEventListener('click', () => {
  copyText(currentShareUrl(), 'Link');
});
document.getElementById('share-qr')?.addEventListener('click', () => {
  const url = currentShareUrl();
  imageDialog({
    title: 'Scan to open this exact setup',
    note: 'Print it on the door placard or tape it to the CRAC — any phone camera opens the plan.',
    render: (canvas) => drawQr(canvas, url, 6),
  });
});
document.getElementById('copy-briefing')?.addEventListener('click', () => {
  const p = state.pressure;
  const a = deriveStateF(state.aTemp, state.aRH, p);
  const b = deriveStateF(state.bTemp, state.bRH, p);
  const chkA = checkSLA(state.aTemp, state.aRH);
  const chkB = checkSLA(state.bTemp, state.bRH);
  const text = buildBriefing({
    a, b,
    plan: planMove(),
    hall: state.hall,
    sla: state.slaProfiles[state.activeSla] || null,
    verdicts: { aOk: chkA.ok, bOk: chkB.ok, aDetail: fmtSlaReason(chkA), bDetail: fmtSlaReason(chkB) },
    fmtT: (f) => `${dispTs(f)} ${tLabel()}`,
    fmtDT: (fd) => `${Math.round(dispDeltaT(fd) * 10) / 10}${deltaLabel()}`,
    fmtHrs,
  });
  copyText(text, 'Briefing');
});

// NFC hall tags — Web NFC exists on Chrome-for-Android only, so the button
// stays hidden everywhere else and QR remains the universal fallback. Writing
// happens on tap-and-hold against the tag; the tag then opens the same deep
// link the QR carries.
if ('NDEFReader' in window) {
  const nfcBtn = document.getElementById('share-nfc');
  if (nfcBtn) {
    nfcBtn.style.display = '';
    nfcBtn.addEventListener('click', async () => {
      toast('Hold the phone against the tag…', { kind: 'info', duration: 6000 });
      try {
        await new window.NDEFReader().write({
          records: [{ recordType: 'url', data: currentShareUrl() }],
        });
        haptic();
        toast('Tag written — tapping it now opens this exact setup.', { kind: 'ok' });
      } catch (e) {
        toast(`NFC write failed: ${e?.message || 'tag not reached'}`, { kind: 'warn', duration: 6000 });
      }
    });
  }
}

// ════════════════════════════════════════════════════════════
//  RAMP PLAYBACK — animate/scrub the hall's state along the plan
// ════════════════════════════════════════════════════════════
const playback = { f: 0, playing: false, raf: 0 };

/** Imported BMS trend, drawn on the chart when state.visible.actual is on.
 *  Session-scoped on purpose: a trail belongs to the move it recorded, not to
 *  every future session — the durable record is the calibration entry. */
let actualTrail = null;

function playbackReadout() {
  const info = document.getElementById('playback-info');
  if (!info) return;
  const totalH = planMove().hours;
  if (playback.f <= 0 || totalH <= 0) {
    info.textContent = totalH > 0 ? `plan: ${fmtHrs(totalH)}` : '—';
    return;
  }
  // The plan line is straight in (T, W): interpolate those, then express the
  // point as RH so the readout matches what the hover inspector would say.
  const p = state.pressure;
  const tcA = fToC(state.aTemp), tcB = fToC(state.bTemp);
  const wA = humidityRatioG(tcA, state.aRH, p) / 1000;
  const wB = humidityRatioG(tcB, state.bRH, p) / 1000;
  const tc = tcA + (tcB - tcA) * playback.f;
  const w = wA + (wB - wA) * playback.f;
  const rh = Math.min(100, Math.max(0, rhFromW(tc, w, p)));
  info.textContent = `t+${fmtHrs(totalH * playback.f)} · ${dispTs(cToF(tc))}${tLabel()} · ${rh.toFixed(0)}%`;
}

function playbackSet(f, fromScrub = false) {
  playback.f = Math.min(1, Math.max(0, f));
  if (!fromScrub) {
    const scrub = document.getElementById('playback-scrub');
    if (scrub) scrub.value = String(Math.round(playback.f * 1000));
  }
  playbackReadout();
  drawChart(); // chart only — update() would persist state every frame
}

function playbackStop() {
  playback.playing = false;
  cancelAnimationFrame(playback.raf);
  const btn = document.getElementById('playback-toggle');
  if (btn) btn.textContent = '▶';
}

document.getElementById('playback-scrub')?.addEventListener('input', function () {
  playbackStop();
  playbackSet(Number(this.value) / 1000, true);
});
document.getElementById('playback-toggle')?.addEventListener('click', function () {
  if (playback.playing) {
    playbackStop();
    return;
  }
  if (planMove().hours <= 0) {
    toast('Nothing to play — Current and Target are the same point.', { kind: 'info' });
    return;
  }
  playback.playing = true;
  this.textContent = '⏸';
  const DURATION_MS = 6000;
  const startF = playback.f >= 1 ? 0 : playback.f;
  const t0 = performance.now();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = (now) => {
    if (!playback.playing) return;
    let f = startF + (now - t0) / DURATION_MS;
    // Reduced motion: same timeline, but the marker steps hour by hour
    // instead of gliding — no continuous animation.
    if (reduced) {
      const totalH = planMove().hours;
      f = totalH > 0 ? Math.floor(f * totalH) / totalH : f;
    }
    playbackSet(f);
    if (playback.f >= 1) playbackStop();
    else playback.raf = requestAnimationFrame(tick);
  };
  playback.raf = requestAnimationFrame(tick);
});

// ════════════════════════════════════════════════════════════
//  TRAINING — Envelope Escape Room
// ════════════════════════════════════════════════════════════
// The training hall is FIXED — same volume, same plant rates, same SLA, same
// standard sea-level pressure for everyone — so a challenge code reproduces
// the identical run on any device, anywhere. These constants are mirrored in
// test/trainer.test.js, which proves every scenario is winnable with them.
const TRAINING_HALL = { hallVolFt3: 200000, rateCoolF: 6, rateWarmF: 4, rateDehumLb: 100, rateHumLb: 80 };
const TRAINING_SLA = { name: 'Training SLA', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 };
const TRAINING_P = 101.325; // kPa — standard atmosphere, deliberately not the site's

const trState = { scenarioId: SCENARIOS[0].id, seed: 42 };

const trCheckSla = (tempF, rh) => {
  const v = checkSLACore(TRAINING_SLA, tempF, rh);
  return { ok: v.ok, detail: v.detail };
};

const trScenario = () =>
  SCENARIOS.find((s) => s.id === trState.scenarioId) || SCENARIOS[0];

function renderTrainingBrief() {
  const el = document.getElementById('tr-brief');
  if (!el) return;
  const s = trScenario();
  el.innerHTML =
    `<strong>${s.title}.</strong> ${s.brief}<br>` +
    `<span class="cap-hint">Hall starts at ${svFmtT(s.start.tempF)} ${tLabel()} / ${s.start.rh}% RH · ` +
    `fault seed ${trState.seed} · the referee runs ${s.simHours} hours.</span>`;
  const share = document.getElementById('tr-share');
  if (share) share.style.display = '';
  const sum = document.getElementById('tr-summary');
  if (sum) sum.textContent = `${s.title} · seed ${trState.seed}`;
}

/** A new scenario or seed is a new challenge — clear the old run's verdict. */
function trNewChallenge() {
  renderTrainingBrief();
  const res = document.getElementById('tr-result');
  if (res) res.style.display = 'none';
  const spark = document.getElementById('tr-spark');
  if (spark) spark.style.display = 'none';
}

/** Draw the run's temp + RH traces, with the breach minute marked in red. */
function drawTrainingSpark(r) {
  const canvas = document.getElementById('tr-spark');
  if (!canvas) return;
  canvas.style.display = 'block';
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(200, canvas.clientWidth || 600);
  const H = 70;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const n = r.trail.length;
  const x = (i) => (i / (n - 1)) * W;
  const line = (get, lo, hi, color) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = H - 4 - ((get(r.trail[i]) - lo) / (hi - lo || 1)) * (H - 8);
      if (i === 0) ctx.moveTo(x(i), y);
      else ctx.lineTo(x(i), y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  const temps = r.trail.map((s) => s.tempF);
  const tLo = Math.min(...temps) - 1;
  const tHi = Math.max(...temps) + 1;
  // Everything in-SLA before the breach reads green context; after, red tint.
  if (r.breachedAtMin != null) {
    ctx.fillStyle = 'rgba(220, 60, 60, 0.12)';
    ctx.fillRect(x(r.breachedAtMin), 0, W - x(r.breachedAtMin), H);
    ctx.strokeStyle = 'rgba(220, 60, 60, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(r.breachedAtMin), 0);
    ctx.lineTo(x(r.breachedAtMin), H);
    ctx.stroke();
  }
  line((s) => s.tempF, tLo, tHi, '#e08a3c'); //  temperature, warm orange
  line((s) => s.rh, 0, 100, '#3ca7a0'); //       RH on its natural 0–100 scale
}

function runTraining(target) {
  const s = trScenario();
  const r = refereeRun({
    scenario: s,
    seed: trState.seed,
    target,
    hall: TRAINING_HALL,
    checkSla: trCheckSla,
    pressure: TRAINING_P,
  });
  const res = document.getElementById('tr-result');
  if (!res) return;
  const maxScore = r.totalMinutes + 30;
  let verdict;
  if (r.breachedAtMin == null) {
    verdict =
      `<span class="sv-pass">SURVIVED</span> — the hall stayed inside the SLA for all ` +
      `${r.totalMinutes} minutes${r.stabilized ? ' and finished stable' : ', but was still moving at the end'}.`;
  } else {
    const hh = Math.floor(r.breachedAtMin / 60);
    const mm = r.breachedAtMin % 60;
    verdict =
      `<span class="sv-fail">BREACHED</span> at minute ${r.breachedAtMin}` +
      ` (${hh ? `${hh} h ` : ''}${mm} min in) — ${r.breachDetail}. ` +
      `In SLA ${r.minutesInSla} of ${r.totalMinutes} minutes.`;
  }
  const what = target
    ? `Committed target: ${svFmtT(target.tempF)} ${tLabel()} / ${target.rh}% RH.`
    : 'No target committed — the plant never fought back. That is what hesitation costs.';
  res.innerHTML =
    `${verdict}<br>${what}<br>` +
    `<strong>Score ${r.score} / ${maxScore}</strong> ` +
    `<span class="cap-hint">(one point per SLA-minute${r.stabilized && r.breachedAtMin == null ? ' + 30 stability bonus' : ''}; ` +
    `orange = temperature, teal = RH)</span>`;
  res.style.display = '';
  drawTrainingSpark(r);
}

/** Challenge code: the training hall is fixed, so scenario + seed is the whole game. */
function trainingShareUrl() {
  const base = location.protocol.startsWith('http')
    ? location.href.split('#')[0]
    : 'https://thorhale.github.io/Psychro/';
  return `${base}#train=${trState.scenarioId}.${trState.seed}`;
}

/** Open a challenge code at boot. Returns true when one was applied. */
function applyTrainingFromUrl() {
  const m = /[#&]train=([a-z][a-z-]*)\.(\d{1,9})\b/.exec(location.hash || '');
  if (!m) return false;
  const s = SCENARIOS.find((x) => x.id === m[1]);
  if (!s) return false;
  trState.scenarioId = s.id;
  trState.seed = parseInt(m[2], 10);
  const sel = document.getElementById('tr-scenario');
  if (sel) sel.value = s.id;
  const seedEl = document.getElementById('tr-seed');
  if (seedEl) seedEl.value = String(trState.seed);
  renderTrainingBrief();
  const details = sel?.closest('details');
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: 'start' });
  }
  toast(`Challenge accepted: "${s.title}", seed ${trState.seed}. Commit your recovery.`, {
    kind: 'info',
    duration: 8000,
  });
  return true;
}

(function initTraining() {
  const sel = document.getElementById('tr-scenario');
  if (!sel) return;
  sel.innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.title}</option>`).join('');
  sel.value = trState.scenarioId;
  sel.addEventListener('change', () => {
    trState.scenarioId = sel.value;
    trNewChallenge();
  });
  document.getElementById('tr-seed')?.addEventListener('input', function () {
    const v = parseInt(this.value, 10);
    trState.seed = isNaN(v) || v < 0 ? 0 : Math.min(999999999, v);
    trNewChallenge();
  });
  document.getElementById('tr-reroll')?.addEventListener('click', () => {
    trState.seed = Math.floor(Math.random() * 100000);
    const seedEl = document.getElementById('tr-seed');
    if (seedEl) seedEl.value = String(trState.seed);
    trNewChallenge();
  });
  document.getElementById('tr-commit')?.addEventListener('click', () => {
    const tv = parseFloat(document.getElementById('tr-temp')?.value);
    const rv = parseFloat(document.getElementById('tr-rh')?.value);
    if (isNaN(tv) || isNaN(rv)) {
      toast('Enter both a target temperature and a target RH first.', { kind: 'warn' });
      return;
    }
    runTraining({ tempF: tU().toF(tv), rh: Math.min(99, Math.max(1, rv)) });
  });
  document.getElementById('tr-idle')?.addEventListener('click', () => runTraining(null));
  document.getElementById('tr-share')?.addEventListener('click', () => {
    copyText(trainingShareUrl(), 'Challenge code');
  });
  renderTrainingBrief();
})();

async function boot() {
  const { restored, platform } = await hydrateFromNative();
  if (restored.length) {
    // Worth saying out loud: this means the WebView storage had been evicted and
    // we just recovered the operator's work from the durable copy.
    logError('storage-recovered', new Error(`restored ${restored.length} key(s) from ${platform} durable storage`));
  }

normalizeCaps(state.slaProfiles);  // default capability flags OFF on preloaded profiles
loadCustomSites();                 // restore user-added cities
loadProfiles();                  // restore persisted profiles if available (re-normalizes)
applyElevation();
// Ensure TARGET starts physically on CURRENT's moisture line, then sync controls.
state.bRH = clampRH(rhFromW_F(state.bTemp, currentW()));
syncAllControls();
// On desktop there's room to work with the profile panels open — start the
// Data Hall and Customer SLA sections expanded (mobile keeps them collapsed).
if (window.matchMedia && matchMedia('(min-width:1120px)').matches) {
  document.querySelectorAll('.col-left > details.sect').forEach((d, i) => { if (i < 2) d.open = true; });
}
renderSlaTabs();
renderSlaEditor();
renderHallTabs();
renderHallEditor();
syncLegend();
update();
loadScenarios();
renderScenarios();
loadSensorLog();
renderSensorLogbook();
// A deep link wins over stored state — the person clicked it on purpose.
if (applyStateFromUrl()) update();
// A challenge code opens the training card preloaded with its scenario + seed.
applyTrainingFromUrl();

// Run validation on load; render results into a collapsible in-page panel
(function(){
  const r = runSelfTest();
  const badge = document.getElementById('selftest-badge');
  const panel = document.getElementById('selftest-panel');
  if (!badge) return;

  badge.textContent = (r.failed
    ? `⚠ Self-test ${r.passed}/${r.total} — ${r.failed} failed`
    : `✓ ASHRAE self-test ${r.passed}/${r.total} passed`) + '  ▾';
  badge.className = 'selftest-badge ' + (r.failed ? 'st-fail' : 'st-ok');

  if (panel) {
    panel.innerHTML = `
      <table class="st-table">
        <thead><tr><th>Check</th><th>Computed</th><th>ASHRAE ref</th><th>±Tol</th><th></th></tr></thead>
        <tbody>
          ${r.cases.map(c=>`
            <tr class="${c.pass?'st-row-ok':'st-row-fail'}">
              <td>${c.name}</td>
              <td>${c.got.toFixed(4)}</td>
              <td>${c.ref.toFixed(4)}</td>
              <td>${c.tol}</td>
              <td>${c.pass?'✓':'✗'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="st-foot">Every value computed live from the ASHRAE formulas and compared to Fundamentals Ch.1 Table 1 &amp; 2 reference data. Units: kPa, g/kg, °C, kJ/kg, m³/kg as labeled.</div>`;
  }

  badge.addEventListener('click', ()=>{
    const open = panel.classList.toggle('open');
    badge.textContent = badge.textContent.replace(/[▾▴]$/, open ? '▴' : '▾');
  });
})();

  // Native shell: status bar, splash dismissal, Android hardware back. The back
  // handler closes open UI before it closes the app — a dialog or an expanded
  // panel should absorb the press.
  await initNativeShell({
    onBack: () => {
      const scrim = document.querySelector('.ntf-scrim');
      if (scrim) { scrim.remove(); return true; }
      const chip = document.getElementById('chip-panel');
      if (chip && chip.classList.contains('open')) { chip.classList.remove('open'); return true; }
      const openPanel = document.querySelector('#selftest-panel.open');
      if (openPanel) { openPanel.classList.remove('open'); return true; }
      return false;
    },
  });
}

boot().catch((err) => {
  logError('boot', err);
  // A failed bootstrap must not leave a blank screen with no explanation.
  const badge = document.getElementById('selftest-badge');
  if (badge) {
    badge.textContent = '⚠ Startup failed — see the error log';
    badge.className = 'selftest-badge st-fail';
  }
});

// ── Version stamp + error log access in the footer ──────────────────────────
(function initFooterDiagnostics() {
  const vEl = document.getElementById('app-version');
  if (vEl) vEl.textContent = VERSION_LABEL;

  // Google Play requires the privacy policy to be reachable INSIDE the app,
  // not only at the store-console URL. A dialog satisfies that offline, over
  // file://, and in the native shells alike.
  document.getElementById('privacy-link')?.addEventListener('click', () => {
    confirmDialog({ title: PRIVACY_TITLE, message: PRIVACY_TEXT, confirmLabel: 'Close' });
  });

  const badge = document.getElementById('errorlog-badge');
  if (!badge) return;
  const render = (count) => {
    badge.style.display = count ? 'inline-flex' : 'none';
    badge.textContent = `⚠ ${count} error${count === 1 ? '' : 's'} logged ▾`;
  };
  onErrorLogChange(render);
  render(getErrorLog().length);
  badge.addEventListener('click', async () => {
    const text = formatErrorLog();
    const copy = await confirmDialog({
      title: 'Session error log',
      message:
        text.length > 600 ? text.slice(0, 600) + '…' : text,
      confirmLabel: 'Copy log',
    });
    if (copy) {
      await copyText(text, 'Error log');
      clearErrorLog();
    }
  });
})();
