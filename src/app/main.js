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
} from '../core/psychro.js';
import { applyBrand } from '../config/brand.js';
import { state, hallVisible } from './state.js';
import { thermalC, currentW } from './hallphysics.js';
import {
  renderEquipment, renderAllHalls, syncDerivedRates, ratesAreLive, wireEquipmentUi,
} from './equipment-ui.js';
import { renderTrainingBrief, applyTrainingFromUrl } from './training-ui.js';
// Side-effect import: this module binds the export buttons itself.
import { wireExport } from './export-ui.js';
import { drawChart, wireChart } from './chart.js';
import {
  renderSensorValidation, renderSensorLogbook, loadSensorLog, loadSensorRegistry,
  sensorSnapshot, mergeSensorData, wireSensorUi,
} from './sensor-ui.js';
import { tU, dispTs, dispT1, tLabel, dispDeltaT, deltaLabel, fmtSlaReason } from '../ui/format.js';
import { escHtml } from '../ui/escape.js';
import {
  fToC, cToF, deltaFromF,
  ft3ToM3, cfmToM3s, toKW, toLbHr, LATENT_BTU_PER_LB,
} from '../core/units.js';
import {
  checkSLA as checkSLACore,
  checkRamp,
} from '../core/envelopes.js';
import { rampPlanFor as rampPlanCore, fmtHrs } from '../core/planner.js';
import { checkDomain } from '../core/domain.js';
import { deriveStateF } from '../core/derive.js';
import { stAbbr, allSites as allSitesFor } from '../config/sites.js';
import {
  normalizeHall,
  migrateLegacyProfiles,
  validateSaveFile,
  isValidScenario,
  SAVE_FILE_VERSION,
} from '../state/schema.js';
import { evapMediaOutput, effectivenessFromOutput } from '../core/evapmedia.js';
import { parseTrendCsv, maxWindowedRate } from '../lib/trendcsv.js';
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
import { inp } from '../ui/dom.js';

installGlobalHandlers();
registerServiceWorker();
initInstallBanner();

// ── Temperature display helpers ─────────────────────────────────────────────
// Internal storage & all ASHRAE math use °F (canonical input) / °C (math). The
// UI displays ONE unit at a time; state.tempUnit ∈ 'F' | 'C' | 'K'.
// They live in src/ui/format.js so every panel can reach them.

// ── v1-compat helpers over the new core signatures ──────────────────────────
// The core's humidityRatio now takes (tc, rh, p) — the dry bulb is needed for
// the enhancement factor. These wrappers keep the extracted UI code readable
// where it already holds a vapour pressure.
const humidityRatioGPw = (pw, p, tc) => humidityRatioFromPw(pw, p, tc) * 1000;

/** Storage quota warning — shown once per session, not per keystroke. */
let quotaWarned = false;
function persistJSON(key, value) {
  const r = storage.setJSON(key, value);
  if (r.ok === false && r.quota && !quotaWarned) {
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


/** Snapshot the working point onto the hall it belongs to. */
function stashHallConditions(hallIndex = state.activeHall) {
  const h = state.hallProfiles[hallIndex];
  if (!h) return;
  h.cond = { aTemp: state.aTemp, aRH: state.aRH, bTemp: state.bTemp, bRH: state.bRH };
}

/**
 * Change the active hall, carrying each hall's own working point with it.
 * Every switch goes through here — tabs, the overview, add, duplicate,
 * delete — because a caller that forgets the stash silently loses a hall's
 * set-points to whichever hall was open before it.
 */
function switchHall(i) {
  stashHallConditions(); //  the point belongs to the hall you are leaving
  state.activeHall = Math.max(0, Math.min(i, state.hallProfiles.length - 1));
  restoreHallConditions(); // …and a hall never worked on seeds itself
  clearActualTrail(); //     a measured trail belongs to one hall
  applyElevation();
}

/** Load a hall's own working point, seeding it the first time it is opened. */
function restoreHallConditions() {
  const c = state.hall?.cond;
  if (c) {
    state.aTemp = c.aTemp; state.aRH = c.aRH;
    state.bTemp = c.bTemp; state.bRH = c.bRH;
  } else {
    stashHallConditions(); // first visit: adopt what is on screen
  }
}

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
  // A measured barometer reading beats the elevation model when the hall has
  // one — the standard atmosphere is a ±2 kPa estimate, a barometer is data.
  const measured = state.hall.baroKpa != null;
  state.pressure = measured ? state.hall.baroKpa : pressureFromAltitude(ft);
  // One decimal, not three: even a measured value drifts with the weather.
  const inHg = state.pressure * 0.2953;
  const pr = inp('pressure-readout');
  if (pr) pr.innerHTML = `${state.pressure.toFixed(1)} kPa <span class="sub">(${inHg.toFixed(2)} inHg · ${measured ? 'measured on site — clear the barometer field to fall back to elevation' : 'standard atmosphere at elevation — weather swings ±2 kPa'})</span>`;
  const fp = inp('fn-pressure');
  if (fp) fp.textContent = `${state.pressure.toFixed(1)} kPa`;
  const chipLabel = inp('chip-label');
  if (chipLabel) {
    const site = state.hall.siteName ? `${state.hall.siteName} · ` : '';
    chipLabel.textContent = `${site}${ft.toLocaleString()} ft`;
  }
  // keep the chip's editable field in sync (unless it's the one being typed in)
  const ei = inp('chip-elev-input');
  if (ei && document.activeElement !== ei) ei.value = ft;
}

// Elevation/site chip open/close
inp('chip-toggle').addEventListener('click', (e) => {
  e.stopPropagation();
  inp('chip-panel').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  const chip = inp('chip-panel');
  if (chip && chip.classList.contains('open') && !(/** @type {Element} */ (e.target)).closest('.site-chip')) {
    chip.classList.remove('open');
  }
});
// Editable elevation directly in the chip — updates the active SLA profile
// and recomputes barometric pressure (and every humidity value) live.
inp('chip-elev-input').addEventListener('input', function() {
  // Accept a leading minus and digits; tolerate partial entry like "-" while typing.
  const raw = this.value.trim();
  if (raw === '' || raw === '-') return;          // wait for a real number
  let v = parseFloat(raw.replace(/[^0-9.-]/g, ''));
  if (isNaN(v)) return;
  v = Math.max(-15000, Math.min(20000, Math.round(v)));  // clamp to valid range
  state.hall.elevFt = v;
  applyElevation();
  const se = inp('hall-elev'); if (se && document.activeElement !== se) se.value = String(v);
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
  const bt = inp('slider-b-temp');
  if (bt) { bt.min = String(bLo); bt.max = String(Math.max(bLo, bHi)); }

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
  const slider = inp(sliderId);
  const input  = inp(inputId);
  const val    = inp(valId);
  // sliders are bounded; input boxes are free
  const sliderClampF = kind === 'dp' ? clampDpF
    : (sliderId.includes('-b-')) ? clampTargetF : clampF;
  if (kind === 'temp' || kind === 'dp') {
    if (slider) slider.value = String(Math.round(sliderClampF(valF))); // slider clamped
    if (input && inputId !== skipInput)  input.value  = dispTs(valF);  // box: true value
    if (val)    val.textContent = dispTs(valF) + ' ' + tLabel();
  } else {
    if (slider) slider.value = String(Math.round(clampRH(valF)));
    if (input && inputId !== skipInput)  input.value  = String(Math.round(valF));
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
inp('slider-a-temp').addEventListener('input', function() {
  setTempHoldingDp('a', clampF(parseFloat(this.value))); afterCurrentChange();
});
inp('slider-a-rh').addEventListener('input', function() {
  state.aRH = clampRH(parseFloat(this.value)); afterCurrentChange();
});

// ── TARGET sliders — fully independent. Each sets only its own value;
// dragging one never moves another. (DP is inherently derived from T & RH —
// setting DP directly adjusts RH at the CURRENT target temp, same as typing
// an RH value would; it does not touch temperature.)
inp('slider-b-temp').addEventListener('input', function() {
  setTempHoldingDp('b', clampTargetF(parseFloat(this.value)));
  syncAllControls(); update();
});
inp('slider-b-rh').addEventListener('input', function() {
  state.bRH = clampRH(parseFloat(this.value));
  syncAllControls(); update();
});

// ── Typed input boxes — independent, same as sliders. ──
inp('a-temp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  setTempHoldingDp('a', tU().toF(v));
  syncControlsExcept('a-temp'); update();
});
inp('a-rh').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.aRH = clampRH(v);
  syncControlsExcept('a-rh'); update();
});
inp('b-temp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  setTempHoldingDp('b', clampTargetF(tU().toF(v)));
  syncControlsExcept('b-temp'); update();
});
inp('b-rh').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.bRH = clampRH(v);
  syncControlsExcept('b-rh'); update();
});

// ── Dew point controls: DP sets RH at the fixed dry-bulb (temp untouched). ──
inp('slider-a-dp').addEventListener('input', function() {
  state.aRH = rh_from_dpF(state.aTemp, parseFloat(this.value));
  afterCurrentChange();
});
inp('a-dp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.aRH = rh_from_dpF(state.aTemp, tU().toF(v));
  syncControlsExcept('a-dp'); update();
});
inp('slider-b-dp').addEventListener('input', function() {
  state.bRH = clampRH(rh_from_dpF(state.bTemp, parseFloat(this.value)));
  syncAllControls(); update();
});
inp('b-dp').addEventListener('input', function() {
  const v = parseFloat(this.value); if (isNaN(v)) return;
  state.bRH = clampRH(rh_from_dpF(state.bTemp, tU().toF(v)));
  syncControlsExcept('b-dp'); update();
});

// ── Leaving a typed box snaps it back to what the app actually used. ──
// Values are clamped live (Target temp to the SLA range, RH to 0–100, dew
// point to saturation) but the box being typed in is deliberately never
// rewritten mid-keystroke — so a clamped entry used to keep showing the raw
// number indefinitely: type 95 under an 80 °F SLA and the box said 95 while
// every calculation used 80. Blur (or Enter) reconciles, and says why.
['a-temp', 'a-rh', 'b-temp', 'b-rh', 'a-dp', 'b-dp'].forEach((id) => {
  const el = inp(id);
  if (!el) return;
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); });
  el.addEventListener('blur', () => {
    const before = parseFloat(el.value);
    syncAllControls();
    const after = parseFloat(el.value);
    // > 1 display unit: beyond what integer display rounding can explain.
    if (isFinite(before) && isFinite(after) && Math.abs(before - after) > 1) {
      toast(`Using ${el.value} — the number you typed was outside the allowed range (RH stays 0–100%, dew point stays below air temp, Target stays near the SLA).`, {
        kind: 'info', duration: 6000,
      });
    }
  });
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
  const tbody=inp('tableBody'); tbody.innerHTML='';
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


// Merged readout: big RH→RH headline + collapsible computed details for both points.
let resultsExpanded = false;  // persists across re-renders

function updateControlReadout() {
  const p = state.pressure;
  const el = inp('control-readout');
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
  const wf = inp('wflag');
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
            : `<div class="ramp-foot ramp-bad">⏱ Plan ≥ ${fmtHrs(minHrs)} — ${plan.binding} is the constraint${plan.binding.startsWith('SLA')?` (${escHtml(sla.name)})`:''}</div>`}
        ${volHint}
        ${rateHint}
      </div>`;
  }

  // ── Capability annotation: informational — describes the hall's moisture
  // plant. Sliders are always independent; this just tells you what it would
  // take (equipment-wise) to actually execute the Target you've set.
  const deh = !!state.hall.canDehumidify, hum = !!state.hall.canHumidify;
  const cs = inp('couple-sub');
  if (cs) cs.textContent = (deh && hum) ? 'full moisture control'
    : (!deh && !hum) ? 'no moisture control — plan by cooling/warming only'
    : deh ? 'can dehumidify (remove moisture)'
          : 'can humidify (add moisture)';
  let capNote;
  if (deh && hum) {
    capNote = `<div class="cap-note"><strong>${escHtml(state.hall.siteName || 'This hall')}: full moisture control.</strong> Cooling, warming, dehumidification, and humidification are all available — any Target in the envelope is achievable with equipment, not just by riding the temperature move.</div>`;
  } else if (!deh && !hum) {
    capNote = `<div class="cap-note"><strong>${escHtml(state.hall.siteName || 'This hall')}: no moisture control.</strong> There's no dehumidifier or humidifier — if your Target's absolute moisture differs from Current's, it isn't reachable by cooling/warming alone (see the water flag above). Add plant capability in the Data Hall panel to close that gap.</div>`;
  } else if (deh && !hum) {
    capNote = `<div class="cap-note"><strong>${escHtml(state.hall.siteName || 'This hall')}: dehumidify only.</strong> Removing moisture is achievable; a Target that needs moisture <strong>added</strong> isn't reachable with the current plant.</div>`;
  } else {
    capNote = `<div class="cap-note"><strong>${escHtml(state.hall.siteName || 'This hall')}: humidify only.</strong> Adding moisture is achievable; a Target that needs moisture <strong>removed</strong> isn't reachable with the current plant.</div>`;
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
    const mda = cfmToM3s(cfm) / vA;                // kg dry air/s
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

  const tog = inp('results-toggle');
  if (tog) tog.addEventListener('click', ()=>{ resultsExpanded = !resultsExpanded; updateControlReadout(); });
}

function refreshSlaSummary() {
  const el = inp('sla-summary'); if (!el) return;
  const s = state.slaProfiles[state.activeSla];
  const dp = (s.dpMaxF != null) ? ` · DP≤${dispTs(s.dpMaxF)}${tLabel()}` : '';
  el.textContent = `${s.name} · ${dispTs(s.tMinF)}–${dispTs(s.tMaxF)}${tLabel()} · ${s.rhMin}–${s.rhMax}%${dp}`;
}
function refreshHallSummary() {
  const el = inp('hall-summary'); if (!el) return;
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
  // FIRST, before anything reads the rates: when the inventory is driving, the
  // plan has to reflect the plant as it stands right now. Evaporative output
  // moves with the room, so this is not only an equipment-edit concern — the
  // humidify rate changes when the hall does.
  syncDerivedRates();
  drawChart();
  buildTable();
  updateControlReadout();
  refreshSlaSummary();
  refreshHallSummary();
  renderSensorValidation();  // re-grade at the new unit / site pressure
  renderTrainingBrief(); //      keep the brief's start temp in the active unit
  renderAllHalls(); //           every hall's status follows the live point
  // Evaporative units are computed from the hall's live condition, so their
  // outputs move with it — but this rebuilds the rows' markup, so never do it
  // while someone is typing into one.
  if (!inp('equip-panel')?.contains(document.activeElement)) renderEquipment();
  renderDomainWarnings();
  if (typeof saveProfiles === 'function') saveProfiles();
}
window.addEventListener('resize', update);

// ════════════════════════════════════════════════════════════
//  SLA PROFILE UI
// ════════════════════════════════════════════════════════════
function renderSlaTabs() {
  const tabs = inp('sla-tabs');
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
  const hed = inp('hall-editor');
  if (!hed) return;
  syncActualTrailToHall(); // A's measured trajectory is not B's

  hed.innerHTML = `
    <div class="sla-field">
      <label for="hall-name">Hall name</label>
      <input type="text" id="hall-name" value="${(state.hall.name||'').replace(/"/g,'&quot;')}" placeholder="e.g. Hall 2">
    </div>
    <div class="sla-field">
      <label for="hall-building">Building</label>
      <input type="text" id="hall-building" value="${(state.hall.building||'').replace(/"/g,'&quot;')}" placeholder="e.g. DFW VII or Building A">
    </div>
    <div class="sla-field"><label for="hall-site">Site / location <span class="cap-hint">set by the Location picker above</span></label><input type="text" id="hall-site" value="${(state.hall.siteName||'').replace(/"/g,'&quot;')}" placeholder="e.g. Goodyear, AZ" ></div>
    <div class="sla-field"><label for="hall-elev">Elevation ft <span class="cap-hint">preset from location; fine-tune here</span></label><input type="number" id="hall-elev" value="${state.hall.elevFt ?? 0}" step="10" min="-15000" max="20000" ></div>
    <div class="sla-field"><label for="hall-baro">Measured pressure <span class="u">kPa</span> <span class="cap-hint">optional — a barometer beats the elevation estimate</span></label><input type="number" inputmode="decimal" id="hall-baro" value="${state.hall.baroKpa ?? ''}" step="0.1" min="55" max="110" placeholder="blank = from elevation"></div>
    <div class="sla-caps">
      <div class="sla-caps-label">Plant capability &amp; rates — what this hall can actually do</div>
      <div class="cap-explain">Temperature rates: use commissioning-observed °F/hr, or derive a physics estimate below (IT load, excess sensible capacity, thermal mass). Moisture is first-principles: hall air mass × ΔW ÷ equipment lb/hr. Enter NET capacity (nameplate minus steady makeup-air latent load). Blank = not plant-limited; the SLA ramp limit still governs.</div>
      <div id="equip-panel"></div>
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
          <div class="calc-grid2" style="margin-bottom:8px">
            <select id="hc-type" class="sla-select calc-sel">
              <option value="rated"${((state.hall.calc||{}).hType??'rated')==='rated'?' selected':''}>Rated output (steam, ultrasonic, fog)</option>
              <option value="evap"${(state.hall.calc||{}).hType==='evap'?' selected':''}>Wetted media — compute from airflow</option>
            </select>
          </div>
          <div id="hc-evap" style="display:none">
            <div class="calc-grid2">
              <input type="number" inputmode="decimal" id="hc-cfm" class="cap-rate" value="${(state.hall.calc||{}).hCfm ?? ''}" placeholder="airflow across media CFM" min="0" step="500">
              <input type="number" inputmode="decimal" id="hc-eff" class="cap-rate" value="${(state.hall.calc||{}).hEff ?? ''}" placeholder="saturation eff. %" min="1" max="100" step="1">
            </div>
            <div class="calc-hint2">Saturation effectiveness comes from your media's own data — the fraction of the theoretical maximum it actually achieves. <strong>This is the number mineral scale destroys:</strong> as deposits block wetted surface and channel air past it, effectiveness falls and so does capacity. Re-enter it as the media fouls, or measure it below.</div>
            <div class="calc-grid2" style="margin-top:8px">
              <input type="number" inputmode="decimal" id="hc-meas" class="cap-rate" value="${(state.hall.calc||{}).hMeas ?? ''}" placeholder="measured output lb/hr (optional)" min="0" step="1">
              <span class="calc-inline-note">↳ back-calculates the effectiveness you are really getting</span>
            </div>
          </div>
          <div class="calc-grid" id="hc-rated">
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
    const el = inp(id);
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
    const el = inp(id);
    if (el) el.addEventListener('input', function() {
      const v = parseFloat(this.value);
      state.hall[key] = (isNaN(v) || v <= 0) ? null : v;
      update();
    });
  };
  // While the inventory is driving, these four are outputs, not inputs. Marked
  // readonly rather than disabled so the numbers stay legible and copyable,
  // and clicking one explains itself instead of doing nothing.
  if (ratesAreLive()) {
    for (const id of ['rate-cool', 'rate-warm', 'rate-dehum', 'rate-hum', 'hall-cfm']) {
      const el = inp(id);
      if (!el) continue;
      el.readOnly = true;
      el.classList.add('cap-derived');
      el.title = 'Derived from the equipment inventory above';
      el.addEventListener('focus', () => {
        toast('This rate comes from the inventory above. Edit a unit there, or switch back to typing rates by hand.',
          { kind: 'info', duration: 6000 });
      }, { once: true });
    }
  }
  rateWire('rate-cool',  'rateCoolF');
  rateWire('rate-warm',  'rateWarmF');
  rateWire('rate-dehum', 'rateDehumLb');
  rateWire('rate-hum',   'rateHumLb');
  rateWire('hall-vol',   'hallVolFt3');
  rateWire('hall-cfm',   'airflowCfm');

  // Hall identity fields — name renames the tab; building/site feed the
  // Location/Building filters above the tabs; site/elevation drive pressure.
  const nameEl = inp('hall-name');
  if (nameEl) nameEl.addEventListener('input', function() {
    state.hall.name = this.value;
    renderHallTabs(); update();
  });
  const bldEl = inp('hall-building');
  if (bldEl) bldEl.addEventListener('input', function() {
    state.hall.building = this.value;
    // Editing must never filter the hall you're typing in out of view.
    if (state.hallView.bld && this.value.trim() !== state.hallView.bld) state.hallView.bld = '';
    renderHallTabs(); update();
  });
  const siteEl = inp('hall-site');
  if (siteEl) siteEl.addEventListener('input', function() {
    state.hall.siteName = this.value;
    if (state.hallView.loc && this.value.trim() !== state.hallView.loc) state.hallView.loc = '';
    applyElevation(); renderHallTabs(); update();
  });
  const elevEl = inp('hall-elev');
  if (elevEl) elevEl.addEventListener('input', function() {
    const v = parseFloat(this.value); if (isNaN(v)) return;
    state.hall.elevFt = Math.max(-15000, Math.min(20000, Math.round(v)));
    applyElevation(); update();
  });
  const baroEl = inp('hall-baro');
  if (baroEl) baroEl.addEventListener('input', function() {
    const v = parseFloat(this.value);
    // Blank or out-of-window clears the override — back to the elevation model.
    state.hall.baroKpa = isNaN(v) || v < 55 || v > 110 ? null : v;
    applyElevation(); update();
  });

  // Real-world factor fields (%): efficiency + per-system capacity derates.
  const pctWire = (id, key, lo, hi, dflt) => {
    const el = inp(id);
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
    const predEl = inp('pva-pred');
    if (predEl) {
      if (planNom.hours > 0) {
        predEl.innerHTML = `Current move ${dispTs(state.aTemp)}${tLabel()}/${Math.round(state.aRH)}% → ${dispTs(state.bTemp)}${tLabel()}/${Math.round(state.bRH)}%: predicted <strong>${fmtHrs(planEff.hours)}</strong> at ${Math.round(state.hall.effPct ?? 100)}% eff · ${fmtHrs(planNom.hours)} at nameplate · binding: ${planNom.binding}`;
      } else {
        predEl.textContent = 'Set plant rates (and hall volume for moisture) above to get a prediction worth logging against.';
      }
    }
    const list = inp('pva-list');
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
      state.hall.results.splice(+(/** @type {HTMLElement} */ (b)).dataset.pvadel, 1); renderPva(); update();
    }));
    const applyBtn = inp('pva-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      state.hall.effPct = Math.max(1, Math.min(150, Math.round(avgEff * 100)));
      renderHallEditor(); update();
    });
  }
  const pvaLog = inp('pva-log');
  if (pvaLog) pvaLog.addEventListener('click', () => {
    const v = parseFloat(inp('pva-actual').value);
    if (!(v > 0)) { toast('Enter the actual duration the move took.', { kind: 'warn' }); return; }
    const hrs = inp('pva-unit').value === 'hr' ? v : v / 60;
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
    inp('pva-actual').value = '';
    renderPva(); update();
  });
  renderPva();

  // ── Trend-CSV import: overlay reality on the chart, feed calibration ──
  const trendBtn = inp('trend-import');
  const trendFile = inp('trend-file');
  if (trendBtn && trendFile) {
    trendBtn.addEventListener('click', () => trendFile.click());
    trendFile.addEventListener('change', () => {
      const f = trendFile.files?.[0];
      trendFile.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => applyTrendText(String(reader.result), f.name);
      reader.readAsText(f);
    });

    /** Leading/trailing minutes where the trend barely moves — dead time that
     *  dilutes any wall-clock-based rate or efficiency figure. */
    const idleSpans = (rows) => {
      const still = (a, b) => Math.abs(b.tempF - a.tempF) < 0.5 && Math.abs(b.rh - a.rh) < 2;
      let head = 0;
      while (head < rows.length - 1 && still(rows[0], rows[head + 1])) head++;
      let tail = 0;
      const n = rows.length - 1;
      while (tail < n && still(rows[n], rows[n - tail - 1])) tail++;
      return {
        headMin: (rows[head].time - rows[0].time) / 60000,
        tailMin: (rows[n].time - rows[n - tail].time) / 60000,
      };
    };

    // Parse + render, re-callable with a forced unit — the range heuristic
    // used to warn "if that's wrong the overlay will look wrong" and then
    // offer no way to fix it.
    function applyTrendText(text, name, forceUnit) {
      const res = parseTrendCsv(text, forceUnit ? { tempUnit: forceUnit } : {});
      const out = inp('trend-res');
      if (!res.ok) {
        // textContent, not innerHTML: this message describes a file we did
        // not write and cannot vouch for.
        if (out) {
          out.style.display = '';
          out.textContent = '';
          const warn = document.createElement('span');
          warn.className = 'calc-warn';
          warn.textContent = res.ok ? '' : /** @type {any} */ (res).error;
          out.appendChild(warn);
        }
        toast('Could not read the trend file.', { kind: 'error' });
        return;
      }
      actualTrail = { rows: res.rows, name, medianStepMs: res.medianStepMs, text, forcedUnit: forceUnit || null, hall: state.activeHall };
      state.visible.actual = true;
      syncLegend();

      const first = res.rows[0], last = res.rows[res.rows.length - 1];
      const hrs = (last.time.getTime() - first.time.getTime()) / 3600000;
      const ratePerHr = hrs > 0 ? (last.tempF - first.tempF) / hrs : 0;
      const unitNote =
        res.tempUnitSource === 'header'
          ? `°${res.tempUnit} from the header`
          : res.tempUnitSource === 'forced'
            ? `°${res.tempUnit} (your override)`
            : `°${res.tempUnit} guessed from the value range`;
      const dateNote = res.dateFormatSource === 'assumed'
        ? ' Dates read as month/day (nothing in the file proved the order — check the time span below).'
        : res.dateFormat === 'dmy' ? ' Dates read as day/month (from the column).' : '';

      // The number an SLA ramp limit is actually about: the fastest SUSTAINED
      // rate, not the endpoint average that idle hours dilute.
      const win = maxWindowedRate(res.rows, 15 * 60000, res.medianStepMs);
      const sla = state.slaProfiles[state.activeSla];
      let rampLine = '';
      if (win && hrs > 0.25) {
        const ramp = checkRamp(sla, win.tempFPerHr, win.rhPerHr);
        const verdict = ramp.ok
          ? (sla.maxDtHr != null || sla.maxDrhHr != null
              ? ` <span class="sv-pass">within the SLA ramp limits</span>`
              : '')
          : ` <span class="sv-fail">FASTER than the SLA's ${ramp.kind === 'dtHr' ? `${(Math.round(dispDeltaT(ramp.bound) * 10) / 10)}${deltaLabel()}/hr` : `${ramp.bound}%RH/hr`} limit</span>`;
        rampLine =
          `<br>Fastest sustained ramp (${Math.round(win.windowMs / 60000)}-min window): <strong>${dispDeltaT(win.tempFPerHr).toFixed(1)}${deltaLabel()}/hr</strong> · <strong>${win.rhPerHr.toFixed(1)}%RH/hr</strong>${verdict}.`;
      }
      const idle = idleSpans(res.rows);
      const idleLine = idle.headMin >= 30 || idle.tailMin >= 30
        ? `<br><span class="calc-warn">⚠ The trend sits nearly still for ${idle.headMin >= 30 ? `${Math.round(idle.headMin)} min at the start` : ''}${idle.headMin >= 30 && idle.tailMin >= 30 ? ' and ' : ''}${idle.tailMin >= 30 ? `${Math.round(idle.tailMin)} min at the end` : ''} — the average rate and any efficiency logged from it count that dead time.</span>`
        : '';

      if (out) {
        out.style.display = '';
        out.innerHTML =
          `${res.rows.length} points over ${fmtHrs(hrs)} (${unitNote}${res.skipped ? `, ${res.skipped} bad row${res.skipped === 1 ? '' : 's'} skipped` : ''}).${dateNote} ` +
          `Achieved <strong>${Math.abs(dispDeltaT(ratePerHr)).toFixed(1)}${deltaLabel()}/hr</strong> average ` +
          `${dispTs(first.tempF)}→${dispTs(last.tempF)} ${tLabel()}, ${first.rh.toFixed(0)}→${last.rh.toFixed(0)}%RH.` +
          rampLine + idleLine +
          (hrs > 0
            ? ` <button type="button" class="scn-btn" id="trend-to-pva" style="margin-left:6px">Log to calibration</button>`
            : '') +
          ` <span class="cap-hint" style="display:block;margin-top:4px">Temp unit: <button type="button" class="scn-btn" id="trend-unit-f">°F</button> <button type="button" class="scn-btn" id="trend-unit-c">°C</button> — tap to re-read the file if the guess is wrong.</span>`;
      }
      inp('trend-unit-f')?.addEventListener('click', () => applyTrendText(text, name, 'F'));
      inp('trend-unit-c')?.addEventListener('click', () => applyTrendText(text, name, 'C'));
      inp('trend-to-pva')?.addEventListener('click', () => {
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
    }

    if (typeof renderEquipment === 'function') renderEquipment();

  // This panel lives inside renderHallEditor's innerHTML, so any unrelated
    // edit to the card (a capability checkbox, applying a calibrated
    // efficiency, switching halls) used to wipe the import result — leaving
    // the trail drawn on the chart with no unit toggle and no way to log it.
    // Redraw from the retained file text instead of making the operator
    // re-import.
    if (actualTrail?.text) applyTrendText(actualTrail.text, actualTrail.name, actualTrail.forcedUnit);
  }

  // ── Rate calculator: derive all four plant rates from equipment specs ──
  // Temperature: Q[kW] / (C_air + C_equipment), where C_air = m_da·cp_moist
  // and C_eq = mass·0.5 kJ/kg·K (steel-class). Air-only = fastest ceiling.
  // Dehum: latent → lb/hr via h_fg ≈ 2454 kJ/kg (1060 BTU/lb), or airflow +
  // supply DP with the exact exponential dry-down. Humidify: steam kW →
  // lb/hr via ≈ 2675 kJ/kg water→steam (≈ 2.97 lb/hr per kW).
  const calcState = () => (state.hall.calc = state.hall.calc || {});
  // Capacity conversions come from core/units.js — the same tables the
  // equipment inventory uses. They were duplicated here, which is a
  // correction waiting to be applied to one copy and not the other.
  function runRateCalc() {
    const cs = calcState();
    const g = id => inp(id);
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
    cs.hType = g('hc-type')?.value || 'rated';
    cs.hCfm = num('hc-cfm'); cs.hEff = num('hc-eff'); cs.hMeas = num('hc-meas');

    // Show the humidifier pane that matches the chosen type.
    const evapPane = g('hc-evap'), ratedPane = g('hc-rated');
    if (evapPane) evapPane.style.display = cs.hType === 'evap' ? '' : 'none';
    if (ratedPane) ratedPane.style.display = cs.hType === 'evap' ? 'none' : '';

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
          const lbhr = toLbHr(cs.dhQty * cs.dhEach, cs.dhUnit);
          dr.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateDehumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
        } else dr.textContent = '—';
      } else if (cs.dhType === 'latent') {
        if (cs.dhLQty > 0 && cs.dhLat > 0) {
          const lbhr = (toKW(cs.dhLQty * cs.dhLat, cs.dhLatUnit) * 3412.14) / LATENT_BTU_PER_LB;
          dr.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateDehumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
        } else dr.textContent = '—';
      } else { // coil — exact exponential dry-down
        if (cs.cfm > 0 && cs.dp != null) {
          const p = state.pressure, W0 = currentW();
          const Ws = saturationHumidityRatio(fToC(cs.dp), p);
          const v = specificVolume(fToC(state.aTemp), W0, p);
          const mCoil = (cfmToM3s(cs.cfm) / v) * 3600;
          if (Ws >= W0) dr.innerHTML = '<span class="calc-warn">Supply DP ≥ hall dew point — no removal at current conditions.</span>';
          else {
            const initLb = mCoil * (W0 - Ws) / 0.45359237;
            let extra = '', applyRate = initLb;
            const Wb = humidityRatio(fToC(state.bTemp), state.bRH, p);
            if (state.hall.hallVolFt3 > 0 && Wb < W0 - 0.00005) {
              const mHall = ft3ToM3(state.hall.hallVolFt3) / v;
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
      if (cs.hType === 'evap') {
        // Wetted media: output is not a nameplate, it is a function of the air
        // entering the media RIGHT NOW. Evaluated at the Current point and the
        // site's pressure, so the answer moves with the hall.
        const measEff = cs.hMeas > 0
          ? effectivenessFromOutput({
              cfm: cs.hCfm, tempF: state.aTemp, rh: state.aRH,
              lbPerHr: cs.hMeas, pressure: state.pressure,
            })
          : null;
        const effUsed = measEff ?? cs.hEff;
        const r = evapMediaOutput({
          cfm: cs.hCfm, tempF: state.aTemp, rh: state.aRH,
          effPct: effUsed, pressure: state.pressure,
        });
        if (!(cs.hCfm > 0)) {
          hc.innerHTML = '<span class="calc-warn">Enter the airflow across the media.</span>';
        } else if (!r) {
          hc.innerHTML = measEff === null && cs.hMeas > 0
            ? '<span class="calc-warn">At the Current condition this air cannot absorb water, so no effectiveness can be inferred from a measurement.</span>'
            : '<span class="calc-warn">Enter the media\'s saturation effectiveness (or a measured output).</span>';
        } else {
          const measNote = measEff != null
            ? ` <span class="cap-hint">— measured output implies <strong>${measEff.toFixed(0)}%</strong> effectiveness${cs.hEff > 0 ? `, against ${cs.hEff.toFixed(0)}% entered${measEff < cs.hEff * 0.95 ? ' — media is losing capacity' : ''}` : ''}</span>`
            : '';
          hc.innerHTML =
            `At the Current point (${dispTs(state.aTemp)}${tLabel()} / ${Math.round(state.aRH)}% RH, wet bulb ${dispTs(r.twbF)}${tLabel()}): ` +
            `<strong>${r.lbPerHr.toFixed(1)} lb/hr</strong>${measNote}` +
            ` <button class="calc-apply" data-rk="rateHumLb" data-rv="${r.lbPerHr.toFixed(1)}">Apply</button>` +
            `<div class="cap-hint">Air leaves at ${dispTs(r.leavingTempF)}${tLabel()} — evaporative humidification also cools, by ${(Math.round(dispDeltaT(state.aTemp - r.leavingTempF) * 10) / 10)}${deltaLabel()} here. Output falls as the hall gets damper: this figure is for the condition above, not a fixed rating.</div>`;
        }
      } else if (cs.hQty > 0 && cs.hEach > 0) {
        const lbhr = toLbHr(cs.hQty * cs.hEach, cs.hUnit);
        hc.innerHTML = `= <strong>${lbhr.toFixed(1)} lb/hr</strong> <button class="calc-apply" data-rk="rateHumLb" data-rv="${lbhr.toFixed(1)}">Apply</button>`;
      } else hc.textContent = '—';
    }
    // Apply buttons
    hed.querySelectorAll('.calc-apply').forEach((/** @type {HTMLElement} */ b) => b.onclick = () => {
      const k = b.dataset.rk;
      state.hall[k] = parseFloat(b.dataset.rv);
      if (k === 'rateDehumLb') state.hall.canDehumidify = true;
      if (k === 'rateHumLb')   state.hall.canHumidify = true;
      syncAllControls(); update(); renderHallEditor();
    });
  }
  ['rc-it','rc-mass','cc-units','cc-cap','cc-capunit','wc-reheat',
   'dh-type','dh-qty','dh-each','dh-unit','dh-lqty','dh-lat','dh-latunit',
   'dc-cfm','dc-dp','hc-qty','hc-each','hc-unit',
   'hc-type','hc-cfm','hc-eff','hc-meas'].forEach(id => {
    const el = inp(id);
    if (el) {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      // These feed more than their own readout: the IT load sets how much
      // cooling is left for pulldown, which decides the derived cooling rate,
      // the redundancy verdict, and this hall's line in the overview. Letting
      // them update only their own panel is how the numbers drift apart.
      el.addEventListener(ev, () => { runRateCalc(); update(); });
    }
  });
  runRateCalc(); // once at render time; update() is already in flight above us

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

// Guarantee at least one hall exists at the given location/building; create
// "Hall 1" there (preset catalog elevation) and activate it if none does.
// This is what makes picking a fresh Location drive the chart immediately.
/**
 * Point the app at the first hall the current filter admits.
 *
 * What filtering should do instead of conjuring a hall: if the narrowed set
 * has halls, open one; if it does not, say so and leave the data alone.
 */
function focusFirstVisibleHall() {
  const i = state.hallProfiles.findIndex(hallVisible);
  if (i >= 0 && i !== state.activeHall) {
    switchHall(i);
    renderHallEditor(); syncAllControls();
  }
}

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
  const tabs = inp('hall-tabs');
  if (!tabs) return;
  const v = state.hallView || (state.hallView = { loc: '', bld: '' });
  const esc = escHtml; // one escaper for the whole app
  const nHalls = pred => state.hallProfiles.filter(pred).length;
  const cnt = n => n ? ` · ${n} hall${n === 1 ? '' : 's'}` : '';

  // ── Location: full site catalog grouped by state, one option per city.
  const sites = allSites();
  const locSel = inp('hall-loc-filter');
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
  const bldSel = inp('hall-bld-filter');
  if (bldSel) {
    // Two kinds of entry, and they must not look alike. "PHX" is a CAMPUS CODE
    // out of the site catalog, not a building anybody named; showing it bare
    // next to "A2" reads as a mystery building. Group and label them.
    const mine = new Set();
    inLoc.forEach(h => { const b = (h.building || '').trim(); if (b) mine.add(b); });
    const codes = v.loc
      ? [...new Set(sites.filter(s => s.siteName === v.loc).map(s => String(s.code)))]
        .filter(c => !mine.has(c)).sort()
      : [];
    if (v.bld && !mine.has(v.bld) && !codes.includes(v.bld)) v.bld = '';
    const opt = b =>
      `<option value="${esc(b)}"${b === v.bld ? ' selected' : ''}>${esc(b)}${cnt(inLoc.filter(h => (h.building || '').trim() === b).length)}</option>`;
    const group = (label, list) =>
      list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '';
    bldSel.innerHTML = `<option value="">All buildings (${inLoc.length} hall${inLoc.length === 1 ? '' : 's'})</option>`
      + group('Buildings you have named', [...mine].sort())
      + group('Campus codes from the site list', codes)
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
      if (i === state.activeHall) return;
      switchHall(i);
      renderHallTabs(); renderHallEditor(); syncAllControls(); update();
    };
    tabs.appendChild(btn);
  });
  const del = inp('hall-del');
  if (del) del.disabled = state.hallProfiles.length <= 1;
}

inp('hall-loc-filter').addEventListener('change', function() {
  state.hallView.loc = this.value;
  state.hallView.bld = '';
  // Filtering is a VIEW action and must not create anything. This used to
  // call ensureHallAt(), so simply browsing the Location list left a new hall
  // behind each time — which is where a campus of unwanted halls came from.
  focusFirstVisibleHall();
  renderHallTabs(); update();
});
inp('hall-bld-filter').addEventListener('change', function() {
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
  focusFirstVisibleHall(); //  view only — see the Location handler above
  renderHallTabs(); update();
});

// Add-city form (next to the Location picker): saves a custom site to this
// device, then navigates to it — same flow as picking a catalog location.
inp('addcity-toggle').addEventListener('click', () => {
  const f = inp('addcity-form');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
});
inp('ac-cancel').addEventListener('click', () => {
  inp('addcity-form').style.display = 'none';
});
inp('ac-save').addEventListener('click', () => {
  const code  = inp('ac-code').value.trim();
  const city  = inp('ac-city').value.trim();
  const stRaw = inp('ac-state').value.trim();
  const elev  = parseFloat(inp('ac-elev').value);
  if (!code || !city || !stRaw) { toast('Site code, city, and state are required.', { kind: 'warn' }); return; }
  if (isNaN(elev)) { toast('Enter a numeric elevation in feet.', { kind: 'warn' }); return; }
  // Title-case the state so it sorts/labels consistently.
  const stName = stRaw.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  customSites.push({ state: stName, city, code, elevFt: Math.round(elev), custom: true });
  persistCustomSites();
  state.hallView.loc = `${city}, ${stAbbr(stName)}`;
  state.hallView.bld = '';
  ensureHallAt(state.hallView.loc, '');
  inp('addcity-form').style.display = 'none';
  ['ac-code', 'ac-city', 'ac-state', 'ac-elev'].forEach(id => { inp(id).value = ''; });
  applyElevation(); renderHallTabs(); renderHallEditor(); update();
});

inp('hall-add').addEventListener('click', () => {
  // Seed the new hall from the active view: same location/building as the
  // current selection and that site's elevation, so it appears in the tab
  // list you're looking at instead of vanishing behind the filter. Numbering
  // counts within the view, so each building gets its own Hall 1, 2, 3…
  //
  // With no filter set (the default "All locations"), fall back to the hall
  // you are standing in rather than to nothing: a hall with no site sits at
  // 0 ft / 101.3 kPa, and every verdict it produces is then computed at the
  // wrong pressure. A new hall almost always belongs to the same site as the
  // one you added it from.
  const v = state.hallView;
  const cur = state.hall || {};
  const loc = v.loc || (cur.siteName || '').trim();
  const bld = v.bld || (cur.building || '').trim();
  const sib = loc && state.hallProfiles.find(h => (h.siteName || '').trim() === loc);
  const site = loc ? allSites().find(s => s.siteName === loc) : null;
  // Number within the building it is joining, so A2 gets Hall 1, 2, 3… of its
  // own instead of inheriting a campus-wide running total.
  const nHere = state.hallProfiles.filter(h =>
    (h.siteName || '').trim() === loc && (h.building || '').trim() === bld).length;
  state.hallProfiles.push(normalizeHall({
    name: `Hall ${nHere + 1}`,
    siteName: loc, building: bld,
    elevFt: sib ? sib.elevFt : (site ? site.elevFt : (cur.elevFt ?? 0)),
    baroKpa: sib ? sib.baroKpa : (cur.baroKpa ?? null),
  }));
  switchHall(state.hallProfiles.length - 1);
  renderHallTabs(); renderHallEditor(); update();
});

inp('hall-dup').addEventListener('click', () => {
  const copy = JSON.parse(JSON.stringify(state.hall));
  copy.name = `${copy.name || 'Hall'} (copy)`;
  copy.results = [];   // logged results belong to the physical hall they came from
  state.hallProfiles.push(normalizeHall(copy));
  switchHall(state.hallProfiles.length - 1);
  renderHallTabs(); renderHallEditor(); update();
});

/**
 * Ask before removing a hall. Shared so the overview's per-row delete and the
 * Data Hall card's button cannot drift into asking different questions.
 */
function confirmDeleteHall(name) {
  return confirmDialog({
    title: 'Delete hall profile?',
    message: `"${name}" and its equipment settings and logged results will be removed. This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
}

/** Remove a hall by index and leave the app pointed somewhere sensible. */
function deleteHallAt(i) {
  if (state.hallProfiles.length <= 1 || i < 0 || i >= state.hallProfiles.length) return;
  state.hallProfiles.splice(i, 1);
  if (state.activeHall >= state.hallProfiles.length) state.activeHall = state.hallProfiles.length - 1;
  else if (i < state.activeHall) state.activeHall--;
  restoreHallConditions(); // the deleted hall's point went with it
  applyElevation(); renderHallTabs(); renderHallEditor(); syncAllControls(); update();
}

inp('hall-del').addEventListener('click', async () => {
  if (state.hallProfiles.length <= 1) return;
  if (!(await confirmDeleteHall(state.hall.name || 'This hall'))) return;
  deleteHallAt(state.activeHall);
});

inp('hall-export').addEventListener('click', () => {
  const payload = { app:'SDC Hall Environment Planner', kind:'hallProfiles', version:4,
                    exported:new Date().toISOString(), hallProfiles: state.hallProfiles };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'sdc_hall_profiles.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

inp('hall-import').addEventListener('click', () => inp('hall-file').click());
inp('hall-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(String(e.target.result));
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
  const ed = inp('sla-editor');
  const lock = sla.locked ? 'disabled' : '';
  // The contract is STORED in °F but EDITED in the active display unit — this
  // is the one card where the customer's numbers get typed in, and it used to
  // be the one card that ignored the °C toggle. Absolute temps convert via
  // tU(); the per-hour ramp limit is a DELTA (°C deltas scale, they don't
  // offset), so it goes through the delta converters instead.
  const showT = (f) => (f == null ? '' : dispT1(f));
  const showDT = (dF) => (dF == null ? '' : (Math.round(dispDeltaT(dF) * 10) / 10).toString());
  ed.innerHTML = `
    <div class="sla-field name-field">
      <label for="sla-name">Profile name</label>
      <input type="text" id="sla-name" value="${sla.name.replace(/"/g,'&quot;')}" ${lock}>
    </div>
    <div class="sla-field"><label for="sla-tmin">Temp min <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-tmin" value="${showT(sla.tMinF)}" step="0.5" ${lock}></div>
    <div class="sla-field"><label for="sla-tmax">Temp max <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-tmax" value="${showT(sla.tMaxF)}" step="0.5" ${lock}></div>
    <div class="sla-field"><label for="sla-rhmin">RH min %</label><input type="number" id="sla-rhmin" value="${sla.rhMin}" step="1" ${lock}></div>
    <div class="sla-field"><label for="sla-rhmax">RH max %</label><input type="number" id="sla-rhmax" value="${sla.rhMax}" step="1" ${lock}></div>
    <div class="sla-field"><label for="sla-dpmax">Dew pt cap <span class="tunit">${tLabel()}</span></label><input type="number" id="sla-dpmax" value="${showT(sla.dpMaxF != null ? Number(sla.dpMaxF) : null)}" step="0.5" placeholder="none" ${lock}></div>
    <div class="sla-field"><label for="sla-dthr">Max ΔT /hr ${deltaLabel()}</label><input type="number" id="sla-dthr" value="${showDT(sla.maxDtHr)}" step="0.5" placeholder="none" ${lock}></div>
    <div class="sla-field"><label for="sla-drhhr">Max ΔRH /hr %</label><input type="number" id="sla-drhhr" value="${sla.maxDrhHr ?? ''}" step="1" placeholder="none" ${lock}></div>
  `;
  if (!sla.locked) {
    // conv: display value → canonical °F (absolute or delta); identity for RH.
    const dtToF = (v) => v / deltaFromF(1, state.tempUnit || 'F');
    const bind = (id, key, conv) => {
      inp(id).addEventListener('input', function() {
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
  inp('sla-del').disabled = sla.locked || state.slaProfiles.length <= 1;
}

inp('sla-add').addEventListener('click', () => {
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

inp('sla-del').addEventListener('click', async () => {
  const sla = state.slaProfiles[state.activeSla];
  if (sla.locked || state.slaProfiles.length <= 1) return;
  // A customer's contract numbers deserve the same one-breath pause the hall
  // delete has always had — this was a single un-undoable tap.
  const ok = await confirmDialog({
    title: 'Delete SLA profile',
    message: `Delete the SLA profile "${sla.name}" and its limits? This cannot be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
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
inp('leg-all').addEventListener('click', () => setAllVisible(true));
inp('leg-none').addEventListener('click', () => setAllVisible(false));

// Per-item legend toggles — tap to show/hide that boundary on the chart.
function syncLegend() {
  document.querySelectorAll('#legend .leg-item').forEach(btn => {
    btn.classList.toggle('leg-off', !state.visible[(/** @type {HTMLElement} */ (btn)).dataset.vis]);
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
// Persisting is debounced: update() runs on every `input` event, so a slider
// drag used to issue ~60 synchronous JSON.stringify + localStorage writes per
// second (every hall, every SLA, every logged result, each frame). The work
// is identical, it just stops happening between keystrokes. `pagehide` and
// `visibilitychange` flush, so nothing is lost to a closed tab or a
// backgrounded phone.
let saveTimer = 0;
function flushProfiles() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  persistJSON(LS_KEY_V4, buildStoredState(state));
}
function saveProfiles() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = /** @type {any} */ (setTimeout(() => {
    saveTimer = 0;
    persistJSON(LS_KEY_V4, buildStoredState(state));
  }, 400));
}
window.addEventListener('pagehide', flushProfiles);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushProfiles();
});

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
      state.hallProfiles = /** @type {any} */ (patch.hallProfiles);
      state.activeHall = patch.activeHall ?? 0;
    }
    if (patch.hall) state.hall = patch.hall; // v3: single hall onto the active slot
    if (patch.hallView) state.hallView = patch.hallView;
    if (patch.slaProfiles) {
      state.slaProfiles = /** @type {any} */ (patch.slaProfiles);
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

inp('sla-export').addEventListener('click', () => {
  const payload = { app:'SDC Hall Environment Planner', version:4, exported:new Date().toISOString(),
                    tempUnit: state.tempUnit, hallProfiles: state.hallProfiles, activeHall: state.activeHall,
                    slaProfiles: state.slaProfiles };
  platformSaveFile('sdc_sla_profiles.json', JSON.stringify(payload, null, 2));
});

inp('sla-import').addEventListener('click', () => inp('sla-file').click());
inp('sla-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(String(e.target.result));
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
  const list = inp('scn-list');
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
  list.querySelectorAll('[data-load]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => applyScenario(scenarios[+b.dataset.load])));
  list.querySelectorAll('.scn-item-main').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', () => applyScenario(scenarios[+b.dataset.idx])));
  list.querySelectorAll('[data-del]').forEach((/** @type {HTMLElement} */ b) => b.addEventListener('click', async () => {
    const i = +b.dataset.del;
    const ok = await confirmDialog({
      title: 'Delete scenario',
      message: `Delete the saved scenario "${scenarios[i]?.name || 'unnamed'}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    scenarios.splice(i, 1); persistScenarios(); renderScenarios();
  }));
}

inp('scn-save').addEventListener('click', () => {
  const nameField = inp('scn-name');
  scenarios.push(captureScenario(nameField.value.trim()));
  nameField.value = '';
  persistScenarios(); renderScenarios();
});
inp('scn-name').addEventListener('keydown', e => { if (e.key === 'Enter') inp('scn-save').click(); });

// Export / import scenarios as a shareable file
inp('scn-export-file').addEventListener('click', () => {
  const payload = { app:'SDC Psychrometric Scenarios', version:1, exported:new Date().toISOString(), scenarios };
  platformSaveFile('sdc_scenarios.json', JSON.stringify(payload, null, 2));
});
inp('scn-import-file').addEventListener('click', () => inp('scn-file').click());
inp('scn-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(String(e.target.result));
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
    app: 'SDC Hall Environment Planner', kind: 'saveFile', version: SAVE_FILE_VERSION,
    exported: new Date().toISOString(),
    hallProfiles: state.hallProfiles,
    slaProfiles: state.slaProfiles,
    customSites,
    scenarios,
    ...sensorSnapshot(),
    tempUnit: state.tempUnit,
  };
}
function saveFileName() {
  return `sdc_planner_save_${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * Deliverable filenames carry WHAT they are and WHERE they came from —
 * `placard_PHX-Hall-1_Base-SLA_2026-08-02.pdf` sorts, searches and audits;
 * four halls' placards used to all be `sdc_psychrometric.pdf` in a Downloads
 * folder, telling nobody apart.
 */
function exportName(kind, ext) {
  const slug = (s) => String(s || '').trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const hall = slug(state.hall?.name) || 'hall';
  const sla = slug(state.slaProfiles[state.activeSla]?.name) || 'sla';
  return `${kind}_${hall}_${sla}_${new Date().toISOString().slice(0, 10)}.${ext}`;
}
function downloadSaveFile() {
  platformSaveFile(saveFileName(), JSON.stringify(buildSaveFile(), null, 2));
}
function mergeSaveFile(data) {
  // Validate the WHOLE payload before touching state — an import either applies
  // cleanly or not at all (v1 could half-apply then throw).
  const v = validateSaveFile(data);
  if (!v.ok) throw new Error(/** @type {any} */ (v).error);
  let halls = 0, slas = 0, sites = 0, scns = 0;
  const { logs, regs } = mergeSensorData(v.sensorLog, v.sensorRegistry);
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
  return `Loaded: ${halls} hall${halls === 1 ? '' : 's'}, ${slas} SLA${slas === 1 ? '' : 's'}, ${sites} custom site${sites === 1 ? '' : 's'}, ${scns} scenario${scns === 1 ? '' : 's'}${logs ? `, ${logs} sensor check${logs === 1 ? '' : 's'}` : ''}${regs ? `, ${regs} sensor spec${regs === 1 ? '' : 's'}` : ''}.`;
}

inp('save-export').addEventListener('click', downloadSaveFile);
inp('save-share').addEventListener('click', async () => {
  // Native share sheet where available (phones/tablets: AirDrop, Teams,
  // email…); anywhere else the adapter falls back to a plain file download.
  await shareFile(saveFileName(), JSON.stringify(buildSaveFile(), null, 2),
    'Hall Environment Planner save file');
});
inp('save-import').addEventListener('click', () => inp('save-file').click());
inp('save-file').addEventListener('change', function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(String(e.target.result));
      toast(mergeSaveFile(data), { kind: 'ok', duration: 6000 });
    } catch (err) { logError('load-savefile', err); toast('Could not load save file: ' + err.message, { kind: 'error' }); }
  };
  reader.readAsText(file); this.value = '';
});

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

/**
 * How this site's pressure was arrived at, in words — for artifacts that
 * leave the app. A measured barometer reading and a standard-atmosphere
 * estimate are different claims, and a laminated door placard must not
 * print the second while the app is using the first.
 */
function pressureBasisText() {
  return state.hall?.baroKpa != null
    ? `${state.pressure.toFixed(1)} kPa (measured on site)`
    : `${state.pressure.toFixed(1)} kPa (standard atmosphere at elevation, ±2 kPa)`;
}

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

inp('share-link')?.addEventListener('click', () => {
  copyText(currentShareUrl(), 'Link');
});
inp('share-qr')?.addEventListener('click', () => {
  const url = currentShareUrl();
  imageDialog({
    title: 'Scan to open this exact setup',
    note: 'Print it on the door placard or tape it to the CRAC — any phone camera opens the plan.',
    render: (canvas) => drawQr(canvas, url, 6),
  });
});
/**
 * Hour-by-hour set-points for the current plan: linear in (T, W) — the exact
 * interpolation the chart's pacing ticks use — expressed back as RH so every
 * surface tells the same story. At most 12 rungs; the arrival is always last.
 */
function briefingHourly(plan) {
  if (!plan || !(plan.hours > 0.5)) return null;
  const p = state.pressure;
  const tcA = fToC(state.aTemp), tcB = fToC(state.bTemp);
  const wA = humidityRatioG(tcA, state.aRH, p) / 1000;
  const wB = humidityRatioG(tcB, state.bRH, p) / 1000;
  // At most 12 rungs, but each one carries its REAL clock hour: a 40-hour
  // move sampled every ~3.6 h used to print "Hour 12 (arrival)" — announcing
  // a two-day ramp as arriving before lunch.
  const rungs = Math.min(12, Math.ceil(plan.hours));
  const step = plan.hours / rungs;
  const out = [];
  for (let i = 1; i <= rungs; i++) {
    const atHr = i === rungs ? plan.hours : i * step;
    const f = Math.min(1, atHr / plan.hours);
    const tc = tcA + (tcB - tcA) * f;
    const w = wA + (wB - wA) * f;
    out.push({ atHr, tempF: cToF(tc), rh: Math.min(100, Math.max(0, rhFromW(tc, w, p))) });
  }
  return out;
}

inp('copy-briefing')?.addEventListener('click', () => {
  const p = state.pressure;
  const a = deriveStateF(state.aTemp, state.aRH, p);
  const b = deriveStateF(state.bTemp, state.bRH, p);
  const chkA = checkSLA(state.aTemp, state.aRH);
  const chkB = checkSLA(state.bTemp, state.bRH);
  const plan = planMove();
  const text = buildBriefing({
    a, b,
    plan,
    hall: state.hall,
    sla: state.slaProfiles[state.activeSla] || null,
    verdicts: { aOk: chkA.ok, bOk: chkB.ok, aDetail: fmtSlaReason(chkA), bDetail: fmtSlaReason(chkB) },
    fmtT: (f) => `${dispTs(f)} ${tLabel()}`,
    fmtDT: (fd) => `${Math.round(dispDeltaT(fd) * 10) / 10}${deltaLabel()}`,
    fmtHrs,
    hourly: briefingHourly(plan),
    pressureBasis: pressureBasisText(),
    generatedAt: new Date(),
  });
  copyText(text, 'Briefing');
});

// NFC hall tags — Web NFC exists on Chrome-for-Android only, so the button
// stays hidden everywhere else and QR remains the universal fallback. Writing
// happens on tap-and-hold against the tag; the tag then opens the same deep
// link the QR carries.
if ('NDEFReader' in window) {
  const nfcBtn = inp('share-nfc');
  if (nfcBtn) {
    nfcBtn.style.display = '';
    nfcBtn.addEventListener('click', async () => {
      toast('Hold the phone against the tag…', { kind: 'info', duration: 6000 });
      try {
        await new (/** @type {any} */ (window).NDEFReader)().write({
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

/** Drop the imported trail and its legend layer.
 *  A trail records ONE move in ONE hall: left on screen across a hall switch
 *  it was re-projected onto the new hall's pressure axis, still labelled
 *  "Actual", with the panel that named its source file gone. */
function clearActualTrail() {
  if (!actualTrail) return;
  actualTrail = null;
  state.visible.actual = false;
  const out = inp('trend-res');
  if (out) { out.style.display = 'none'; out.textContent = ''; }
  syncLegend();
}

/** Clear the trail if the active hall is no longer the one it was imported
 *  for. Checked centrally rather than at each switch site, because halls also
 *  change via "add hall", delete, and the location/building filters. */
function syncActualTrailToHall() {
  if (actualTrail && actualTrail.hall !== state.activeHall) clearActualTrail();
}

function playbackReadout() {
  const info = inp('playback-info');
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
    const scrub = inp('playback-scrub');
    if (scrub) scrub.value = String(Math.round(playback.f * 1000));
  }
  playbackReadout();
  drawChart(); // chart only — update() would persist state every frame
}

function playbackStop() {
  playback.playing = false;
  cancelAnimationFrame(playback.raf);
  const btn = inp('playback-toggle');
  if (btn) btn.textContent = '▶';
}

inp('playback-scrub')?.addEventListener('input', function () {
  playbackStop();
  playbackSet(Number(this.value) / 1000, true);
});
inp('playback-toggle')?.addEventListener('click', function () {
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
//  ONBOARDING — first-run guidance that does not tax returning users
// ════════════════════════════════════════════════════════════
// The Start-here card sits above the tool, which is right for a first visit
// and wrong for the hundredth. Dismissing it leaves a one-line link so the
// guidance is never actually lost — just out of the way.
const ONBOARD_KEY = 'sdc_psychro_onboard_dismissed_v1';

(function initOnboarding() {
  const card = inp('start-here');
  if (!card) return;

  const restore = document.createElement('button');
  restore.id = 'onboard-restore';
  restore.type = 'button';
  restore.textContent = 'Show the Start-here guide and glossary';
  restore.style.display = 'none';
  card.parentNode.insertBefore(restore, card.nextSibling);

  const setDismissed = (hidden) => {
    card.style.display = hidden ? 'none' : '';
    restore.style.display = hidden ? '' : 'none';
  };
  setDismissed(storage.get(ONBOARD_KEY) === '1');

  inp('onboard-dismiss')?.addEventListener('click', () => {
    storage.set(ONBOARD_KEY, '1');
    setDismissed(true);
  });
  restore.addEventListener('click', () => {
    storage.set(ONBOARD_KEY, '0');
    setDismissed(false);
    /** @type {any} */ (card).open = true;
    card.scrollIntoView({ block: 'start' });
  });
})();


// The equipment panel and the all-halls overview drive the rest of the app
// when someone edits a unit or taps a hall. Handing them these callbacks —
// rather than letting them import main.js — is what keeps the import graph
// pointing one way, so those panels stay extractable.
wireSensorUi({
  clampF: (f) => clampF(f),
  clampRH: (r) => clampRH(r),
  humidityRatioGPw: (pw, p, tc) => humidityRatioGPw(pw, p, tc),
  exportName: (kind, ext) => exportName(kind, ext),
  persistJSON: (key, value) => persistJSON(key, value),
  syncAllControls: () => syncAllControls(),
  update: () => update(),
});

wireChart({
  planMove: (opts) => planMove(opts),
  rhAtPoint: (tc, hrG) => rhAtPoint(tc, hrG),
  humidityRatioG: (tc, rh, p) => humidityRatioG(tc, rh, p),
  checkSLA: (tempF, rh) => checkSLA(tempF, rh),
  clampF: (f) => clampF(f),
  clampRH: (r) => clampRH(r),
  clampTargetF: (f) => clampTargetF(f),
  syncAllControls: () => syncAllControls(),
  update: () => update(),
  // Read live rather than captured: both are reassigned as the user works.
  actualTrail: () => actualTrail,
  playback: () => playback,
});

wireExport({
  currentShareUrl: () => currentShareUrl(),
  exportName: (kind, ext) => exportName(kind, ext),
  pressureBasisText: () => pressureBasisText(),
  planMove: (opts) => planMove(opts),
});

wireEquipmentUi({
  confirmDelete: (name) => confirmDeleteHall(name),
  deleteHall: (i) => deleteHallAt(i),
  update: () => update(),
  renderHallEditor: () => renderHallEditor(),
  renderHallTabs: () => renderHallTabs(),
  syncAllControls: () => syncAllControls(),
  switchHall: (i) => switchHall(i),
});

// Branding first: every surface below reads the palette it installs.
applyBrand();

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
// The working point is stored ON the active hall, so it comes back with it.
// (Only the hall profiles persist; the top-level A/B state does not, which is
// why this restore has to happen explicitly and before the first render.)
restoreHallConditions();
applyElevation();
// Ensure TARGET starts physically on CURRENT's moisture line, then sync controls.
state.bRH = clampRH(rhFromW_F(state.bTemp, currentW()));
syncAllControls();
// On desktop there's room to work with the profile panels open — start the
// Data Hall and Customer SLA sections expanded (mobile keeps them collapsed).
if (window.matchMedia && matchMedia('(min-width:1120px)').matches) {
  // Open the first two WORKING cards. `.onboard` is excluded deliberately: it
  // now sits at the top of the column so the mobile stack can order it below
  // the tool, and counting it here would spend the whole left column on help.
  document.querySelectorAll('.col-left > details.sect:not(.onboard)')
    .forEach((/** @type {HTMLDetailsElement} */ d, i) => { if (i < 2) d.open = true; });
}

// Opening or closing a section changes the height of the page above and below
// it, and on the phone stack the cards are re-ordered by CSS, so the browser's
// own scroll anchoring can land you somewhere you didn't ask to be: the page
// appears to lurch down when you open a card and back up when you close it.
// Pin the header you actually tapped — it stays exactly where your finger left
// it, and the content grows underneath it.
document.querySelectorAll('details.sect > summary').forEach((sum) => {
  sum.addEventListener('click', () => {
    const before = sum.getBoundingClientRect().top;
    // After the toggle has been applied and laid out, not before.
    requestAnimationFrame(() => {
      const shift = sum.getBoundingClientRect().top - before;
      if (Math.abs(shift) > 1) window.scrollBy(0, shift);
    });
  });
});
renderSlaTabs();
renderSlaEditor();
renderHallTabs();
renderHallEditor();
syncLegend();
// Before the first update(): its renderSensorValidation() computes the
// overdue tally, which read an empty registry and hid the warning until the
// operator happened to touch an unrelated control.
loadSensorLog();
loadSensorRegistry();
update();
loadScenarios();
renderScenarios();
renderSensorLogbook();
// A deep link wins over stored state — the person clicked it on purpose.
if (applyStateFromUrl()) update();
// A challenge code opens the training card preloaded with its scenario + seed.
applyTrainingFromUrl();

// Run validation on load; render results into a collapsible in-page panel
(function(){
  const r = runSelfTest();
  const badge = inp('selftest-badge');
  const panel = inp('selftest-panel');
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
      const chip = inp('chip-panel');
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
  const badge = inp('selftest-badge');
  if (badge) {
    badge.textContent = '⚠ Startup failed — see the error log';
    badge.className = 'selftest-badge st-fail';
  }
});

// ── Version stamp + error log access in the footer ──────────────────────────
(function initFooterDiagnostics() {
  const vEl = inp('app-version');
  if (vEl) vEl.textContent = VERSION_LABEL;

  // Google Play requires the privacy policy to be reachable INSIDE the app,
  // not only at the store-console URL. A dialog satisfies that offline, over
  // file://, and in the native shells alike.
  inp('privacy-link')?.addEventListener('click', () => {
    confirmDialog({ title: PRIVACY_TITLE, message: PRIVACY_TEXT, confirmLabel: 'Close' });
  });

  const badge = inp('errorlog-badge');
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
