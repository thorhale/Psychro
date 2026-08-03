/**
 * Sensor validation — grading a hall sensor against an external reference.
 *
 * Six methods, each producing "true value ± reference uncertainty" rather
 * than a bare number, because a verdict is only as good as what it was
 * measured against. The guard-banding that turns that pair into PASS /
 * MARGINAL / FAIL is in src/core/svverdict.js, and the reference physics
 * (saturated salts, boiling point, psychrometry) is in core too. What lives
 * here is the surface: the forms, the logbook and the drift forecast.
 *
 * Readings are stored in °F (canonical), so the unit toggle re-displays a
 * logged reading rather than re-measuring it.
 */

import { state } from './state.js';
import { escHtml } from '../ui/escape.js';
import { toast, confirmDialog } from '../ui/notify.js';
import { tU, tLabel, dispT1, dispDeltaT, deltaLabel } from '../ui/format.js';
import { fToC, cToF, deltaFromF } from '../core/units.js';
import { vaporPressure, rhFromDewPoint, rhFromWetBulb, rhFromPsychrometer, dewPoint } from '../core/psychro.js';
import { SALTS, SALT_T_MIN_C, SALT_T_MAX_C, saltRh, saltRhSlope } from '../core/saltref.js';
import { boilingPointC, U_PRACTICAL_C } from '../core/boilref.js';
import { SV_TOL, svVerdict } from '../core/svverdict.js';
import { driftFit } from '../core/driftfit.js';
import { normalizeSensorLog, normalizeSensorRegistry } from '../state/schema.js';
import { saveFile as platformSaveFile, storage } from '../platform/index.js';

/** What only the entry point can do: clamp inputs and refresh the app. */
/**
 * @type {{
 *   clampF: (v: number) => number,
 *   clampRH: (v: number) => number,
 *   humidityRatioGPw: (pw: number, p: number, tc: number) => number,
 *   exportName: (kind: string, ext: string) => string,
 *   persistJSON: (key: string, value: unknown) => void,
 *   syncAllControls: () => void,
 *   update: () => void,
 * }}
 */
let shell = {
  clampF: (v) => v, clampRH: (v) => v,
  humidityRatioGPw: () => 0,
  exportName: () => 'export', persistJSON: () => {},
  syncAllControls: () => {}, update: () => {},
};

/** Hand this module the few things only the entry point can do. */
export function wireSensorUi(callbacks) {
  shell = { ...shell, ...callbacks };
}

// SENSOR VALIDATION SUITE — six external reference methods.
//  Readings are stored in °F (canonical) so the unit toggle re-displays
//  them without drift; pressure-dependent methods run at the active site
//  pressure, so an elevation change re-grades the sensor automatically.
//
//  Every method produces "true value ± reference uncertainty" and verdicts
//  are GUARD-BANDED (ISO 14253-1): claiming PASS requires the error to be
//  inside tolerance by at least the reference's uncertainty; when the
//  reference's ±u straddles the limit, the honest verdict is "too close to
//  call". Grading lives in src/core/svverdict.js, where it is unit-tested.
// ════════════════════════════════════════════════════════════

/** One line of verdict HTML for an RH check. */
function svRhVerdictHtml(sensorRh, trueRh, uRef) {
  if (sensorRh == null) return '';
  const tol = svActiveTol();
  const err = sensorRh - trueRh;
  const v = svVerdict(err, tol.rhPass, tol.rhMarginal, uRef);
  const spec = tol.rhFromSpec ? ` against this sensor's own ±${tol.rhPass}% spec` : '';
  const hint = v.indet
    ? `(reference ±${uRef.toFixed(1)}% straddles the ±${tol.rhPass} limit${spec} — use a tighter reference to decide)`
    : `(decision band ±${v.band.toFixed(1)} after reference ±${uRef.toFixed(1)}${spec})`;
  return `<br>Sensor reads ${sensorRh.toFixed(1)}% → error <span class="${v.cls}">${err >= 0 ? '+' : ''}${err.toFixed(1)}% RH · ${v.word}</span> <span class="cap-hint">${hint}</span>`;
}

/** One line of verdict HTML for a temperature check (all math in °F). */
function svTempVerdictHtml(sensorF, trueF, uRefF) {
  if (sensorF == null) return '';
  const tol = svActiveTol();
  const errF = sensorF - trueF;
  const v = svVerdict(errF, tol.tPassF, tol.tMarginalF, uRefF);
  const disp = Math.round(dispDeltaT(errF) * 100) / 100;
  const dU = (f) => `${Math.round(dispDeltaT(f) * 100) / 100}${deltaLabel()}`;
  const spec = tol.tFromSpec ? ` against this sensor's own ±${dU(tol.tPassF)} spec` : '';
  const hint = v.indet
    ? `(reference ±${dU(uRefF)} straddles the ±${dU(tol.tPassF)} limit${spec} — use a tighter reference to decide)`
    : `(decision band ±${dU(v.band)} after reference ±${dU(uRefF)}${spec})`;
  return `<br>Sensor error <span class="${v.cls}">${errF >= 0 ? '+' : ''}${disp}${deltaLabel()} · ${v.word}</span> <span class="cap-hint">${hint}</span>`;
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
  const v = resEl.querySelector('.sv-pass, .sv-marginal, .sv-fail, .sv-indet');
  if (!v) return;
  const text = v.textContent.trim();
  if (!text || text === ladderLastSpoken) return;
  ladderLastSpoken = text;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Display a stored °F reading in the active unit, one decimal, no trailing .0

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
    const W = shell.humidityRatioGPw(pw, p, tc);
    const dpC = dewPoint(pw);
    const depF = svState.dbF - svState.wbF;
    // The instrument formulas are the reference here; their systematic spread
    // (~0.5 %RH between the two wet-bulb definitions) is the honest floor.
    const uRef = 0.5;
    return {
      html:
        `True RH <span class="sv-big">${rh.toFixed(1)}%</span>` +
        ` · dew point <strong>${dpC != null ? dispT1(cToF(dpC)) + ' ' + tLabel() : '—'}</strong>` +
        ` · W <strong>${W.toFixed(2)} g/kg</strong>` +
        ` · depression ${(Math.round(dispDeltaT(depF) * 10) / 10)}${deltaLabel()}` +
        svRhVerdictHtml(svState.sensorRh, rh, uRef),
      summary: `${dispT1(svState.dbF)}/${dispT1(svState.wbF)}${tLabel()} → ${rh.toFixed(1)}% RH`,
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
        ` <strong>${dispT1(svState.dpDpF)}${tLabel()}</strong> at T<sub>db</sub> <strong>${dispT1(svState.dpDbF)}${tLabel()}</strong>` +
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
        `Reference <span class="sv-big">${dispT1(32)}${tLabel()}</span> <span class="cap-hint">(ice point, ±0.1 °F for a proper slurry)</span>` +
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
      note.textContent = `Rolling boil, probe mid-water off the pot. At this site's ${state.pressure.toFixed(1)} kPa, pure water boils at ${dispT1(tBoilF)} ${tLabel()} — not ${dispT1(cToF(100))} ${tLabel()}. Impurities and superheat limit a field check to about ±${(Math.round(dispDeltaT(uF) * 10) / 10)}${deltaLabel()}.`;
    if (svState.boilTF == null)
      return {
        html: `Boiling point at this site: <span class="sv-big">${dispT1(tBoilF)}${tLabel()}</span> <span class="cap-hint">(${state.pressure.toFixed(1)} kPa · Hyland–Wexler, steam-table checked)</span>. Enter the sensor's reading.`,
        summary: `boils at ${dispT1(tBoilF)}${tLabel()} here`,
      };
    return {
      html:
        `Reference <span class="sv-big">${dispT1(tBoilF)}${tLabel()}</span> <span class="cap-hint">(boiling at ${state.pressure.toFixed(1)} kPa)</span>` +
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
        `Reference <span class="sv-big">${dispT1(refF)}${tLabel()}</span> <span class="cap-hint">± ${uRef.toFixed(1)}${deltaLabel()} (certificate)</span>` +
        svTempVerdictHtml(readF, refF, uRefF),
      summary: 'reference compare (temp)',
      loggable: { quantity: 'temp', ref: refF, u: uRefF, reading: readF, err: readF - refF },
    };
  },
};

export function renderSensorValidation() {
  const res = document.getElementById('sv-res');
  if (!res) return;
  const pEl = document.getElementById('sv-pressure');
  if (pEl) pEl.textContent = `${state.pressure.toFixed(1)} kPa`;

  // Re-display temp boxes only when the unit actually changed — never rewrite
  // a box mid-typing (values are exact in °F underneath regardless).
  if (state.tempUnit !== svLastUnit) {
    svLastUnit = state.tempUnit;
    [['sv-db', 'dbF'], ['sv-wb', 'wbF'], ['sv-dp-db', 'dpDbF'], ['sv-dp-dp', 'dpDpF'],
     ['sv-salt-t', 'saltTF'], ['sv-ice-t', 'iceTF'], ['sv-boil-t', 'boilTF']].forEach(([id, key]) => {
      const el = document.getElementById(id);
      if (el && el !== document.activeElement)
        el.value = svState[key] != null ? dispT1(svState[key]) : '';
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
  if (summary) {
    // Recall status stays visible even while the card is collapsed — a
    // logbook that only speaks when opened is not a recall system.
    const due = svDueCounts();
    const dueTxt = due.overdue
      ? ` · ⚠ ${due.overdue} sensor${due.overdue === 1 ? '' : 's'} overdue for a check`
      : due.dueSoon
        ? ` · ${due.dueSoon} check${due.dueSoon === 1 ? '' : 's'} due soon`
        : '';
    summary.textContent = out.summary + dueTxt;
  }
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

export function loadSensorLog() {
  try {
    sensorLog = normalizeSensorLog(JSON.parse(storage.get(SENSOR_LOG_KEY) || '[]'));
  } catch {
    sensorLog = [];
  }
}
function persistSensorLog() {
  sensorLog = normalizeSensorLog(sensorLog);
  // persistJSON, not storage.set: it surfaces a quota failure. Silently
  // dropping writes here would lose the most audit-critical data in the app
  // while the UI cheerfully confirmed each check was "Logged".
  shell.persistJSON(SENSOR_LOG_KEY, sensorLog);
}

// ── Sensor registry: each instrument's OWN spec and calibration cadence ────
// The generic ±2 %RH / ±0.9 °F tolerances are a reasonable default, but a
// ±3 %RH hall transmitter was being FAILED for meeting its spec while a
// ±1 %RH reference probe PASSED while out of its own. Register the sensor
// and its spec becomes the tolerance its verdicts are graded against.
const SENSOR_REG_KEY = 'sdc_psychro_sensors_v1';
let sensorRegistry = [];

const sensorMetaFor = (name) =>
  sensorRegistry.find((m) => m.name === String(name || '').trim()) || null;

export function loadSensorRegistry() {
  try {
    sensorRegistry = normalizeSensorRegistry(JSON.parse(storage.get(SENSOR_REG_KEY) || '[]'));
  } catch {
    sensorRegistry = [];
  }
}
function persistSensorRegistry() {
  sensorRegistry = normalizeSensorRegistry(sensorRegistry);
  shell.persistJSON(SENSOR_REG_KEY, sensorRegistry);
}
function upsertSensorMeta(name, patch) {
  const key = String(name || '').trim();
  if (!key) return;
  const cur = sensorMetaFor(key) || { name: key, specRh: null, specTF: null, calIntervalDays: null, lastCalDate: null };
  const next = { ...cur, ...patch, name: key };
  sensorRegistry = sensorRegistry.filter((m) => m.name !== key).concat([next]);
  persistSensorRegistry();
}

/**
 * Verdict tolerances for the sensor currently named in the label box: its
 * registered spec when present, the generic defaults otherwise. Marginal
 * keeps the defaults' ratios (RH 2→5 = 2.5×, temp 0.9→1.8 = 2×).
 */
function svActiveTol() {
  const meta = sensorMetaFor(document.getElementById('sv-sensor-label')?.value);
  return {
    rhPass: meta?.specRh ?? SV_TOL.rhPass,
    rhMarginal: meta?.specRh != null ? meta.specRh * 2.5 : SV_TOL.rhMarginal,
    tPassF: meta?.specTF ?? SV_TOL.tPassF,
    tMarginalF: meta?.specTF != null ? meta.specTF * 2 : SV_TOL.tMarginalF,
    rhFromSpec: meta?.specRh != null,
    tFromSpec: meta?.specTF != null,
  };
}

/**
 * Calibration recall: per registered sensor with an interval, days until the
 * next check is due — anchored at its newest logged check or its recorded
 * lastCalDate, whichever is later. Never checked at all counts as due now.
 * @returns {{overdue:number, dueSoon:number}} dueSoon = within 14 days
 */
function svDueCounts() {
  const now = Date.now();
  let overdue = 0, dueSoon = 0;
  for (const m of sensorRegistry) {
    if (!(m.calIntervalDays > 0)) continue;
    const dates = sensorLog.filter((e) => e.sensor === m.name).map((e) => new Date(e.date).getTime());
    if (m.lastCalDate) dates.push(new Date(m.lastCalDate).getTime());
    const last = dates.length ? Math.max(...dates) : null;
    const daysLeft = last == null ? -1 : m.calIntervalDays - (now - last) / 86400000;
    if (daysLeft < 0) overdue++;
    else if (daysLeft <= 14) dueSoon++;
  }
  return { overdue, dueSoon };
}

let svlogShowAll = false;

/** One quantity's history table + drift line for the selected sensor. */
function svlogSection(scoped, qty, meta) {
  const isRh = qty === 'rh';
  // Temperature history is stored canonically in °F but must READ in the
  // operator's unit — the spec editor directly above this table already does.
  const unit = isRh ? '%RH' : deltaLabel();
  const val = (f) => (isRh ? f : dispDeltaT(f));
  const pass = isRh ? (meta?.specRh ?? SV_TOL.rhPass) : (meta?.specTF ?? SV_TOL.tPassF);
  const band = isRh
    ? (meta?.specRh != null ? meta.specRh * 2.5 : SV_TOL.rhMarginal)
    : (meta?.specTF != null ? meta.specTF * 2 : SV_TOL.tMarginalF);

  const shown = svlogShowAll ? scoped : scoped.slice(-8);
  const rows = shown
    .map((e) => {
      // ONE grader for the whole app: the row and the live verdict line that
      // produced it must never disagree. Colour alone is not a signal — the
      // verdict word rides along for anyone who cannot see the difference.
      const v = svVerdict(e.err, pass, band, e.u) || { cls: '', word: '—' };
      return (
        `<tr><td>${new Date(e.date).toLocaleDateString()}</td><td>${escHtml(e.method)}</td>` +
        `<td>${val(e.ref).toFixed(1)} ± ${val(e.u).toFixed(1)}</td><td>${val(e.reading).toFixed(1)}</td>` +
        `<td class="${v.cls}">${e.err >= 0 ? '+' : ''}${val(e.err).toFixed(2)} ${v.word}</td>` +
        `<td class="cap-hint">${[e.hallName, e.tech].filter(Boolean).map(escHtml).join(' · ') || '—'}</td></tr>`
      );
    })
    .join('');

  const fit = driftFit(scoped, band);
  let driftLine = `<span class="cap-hint">${scoped.length} check${scoped.length === 1 ? '' : 's'} — two or more spread over time unlock the drift trend.</span>`;
  if (fit) {
    const drift = `${fit.perMonth >= 0 ? '+' : ''}${val(fit.perMonth).toFixed(2)} ${unit}/month`;
    // The ETA renders as a RANGE from the fit's own scatter (slope ± its
    // standard error). A single number out of a noisy fit reads like a
    // scheduling date; a range reads like what it is — a forecast.
    let eta;
    if (fit.daysToBand === 0) {
      eta = `<span class="sv-fail">outside the ±${val(band).toFixed(1)} ${unit} band NOW — recalibrate</span>`;
    } else if (fit.n < 3) {
      eta = `a third check unlocks the days-to-band forecast (two points fit any line exactly)`;
    } else if (fit.daysToBand == null) {
      eta = `not heading for the ±${val(band).toFixed(1)} ${unit} band on this trend`;
    } else if (fit.daysToBandLo != null && fit.daysToBandHi != null && Math.round(fit.daysToBandLo) !== Math.round(fit.daysToBandHi)) {
      eta = `roughly ${Math.round(fit.daysToBandLo)}–${Math.round(fit.daysToBandHi)} days to the ±${val(band).toFixed(1)} ${unit} band`;
    } else if (fit.daysToBandLo != null && fit.daysToBandHi == null) {
      eta = `${Math.round(fit.daysToBandLo)}+ days to the ±${val(band).toFixed(1)} ${unit} band (trend too noisy to bound the far end)`;
    } else {
      eta = `~${Math.round(fit.daysToBand)} days to the ±${val(band).toFixed(1)} ${unit} band`;
    }
    driftLine = `Drift <strong>${drift}</strong> · ${eta} <span class="cap-hint">(linear extrapolation over ${fit.n} checks / ${Math.round(fit.spanDays)} days — a forecast, not a promise)</span>`;
  }

  return (
    `<div class="sv-hint" style="margin-top:8px"><strong>${qty === 'rh' ? 'Humidity' : 'Temperature'} checks</strong></div>` +
    `<table class="svlog-table"><thead><tr><th>date</th><th>method</th><th>reference</th><th>read</th><th>err ${unit}</th><th>hall · by</th></tr></thead><tbody>${rows}</tbody></table>` +
    (scoped.length > 8 && !svlogShowAll ? `<div class="cap-hint">showing the last 8 of ${scoped.length}</div>` : '') +
    `<div class="sv-hint">${driftLine}</div>`
  );
}

export function renderSensorLogbook() {
  const host = document.getElementById('sv-logbook');
  if (!host) return;
  // Union of logged AND registered names: a sensor that arrived via a save
  // file (or whose history was deleted) was unreachable in this dropdown
  // while svDueCounts kept reporting it overdue forever.
  const sensors = [...new Set([
    ...sensorLog.map((e) => e.sensor),
    ...sensorRegistry.map((m) => m.name),
  ])].sort();
  if (!sensors.length) {
    host.innerHTML =
      '<div class="sv-hint">No checks logged yet. Run any method with a sensor reading, name the sensor, and press “＋ Log check” — history turns single verdicts into a drift trend.</div>';
    return;
  }
  const sel = document.getElementById('svlog-sel');
  // The sensor named in the label box wins: the spec editor below must edit
  // the SAME instrument the verdict above is grading. Otherwise typing a spec
  // silently retuned whichever sensor happened to sort first alphabetically.
  const typed = document.getElementById('sv-sensor-label')?.value.trim();
  const selected = sensors.includes(typed)
    ? typed
    : sensors.includes(sel?.value) ? sel.value : sensors[0];
  const entries = sensorLog.filter((e) => e.sensor === selected);
  const meta = sensorMetaFor(selected);

  // One temperature check used to hide a sensor's entire RH history (the
  // table showed only the LAST entry's quantity) — render every quantity
  // this sensor has ever been checked on, each with its own drift trend.
  const sections = ['rh', 'temp']
    .map((q) => ({ q, scoped: entries.filter((e) => e.quantity === q) }))
    .filter((s) => s.scoped.length)
    .map((s) => svlogSection(s.scoped, s.q, meta))
    .join('') ||
    '<div class="sv-hint">Registered, but never checked. Run a method above with this exact sensor name to start its history.</div>';

  // Calibration recall for this sensor.
  let dueLine = '';
  if (meta?.calIntervalDays > 0) {
    const dates = entries.map((e) => new Date(e.date).getTime());
    if (meta.lastCalDate) dates.push(new Date(meta.lastCalDate).getTime());
    const last = dates.length ? Math.max(...dates) : null;
    const daysLeft = last == null ? -1 : meta.calIntervalDays - (Date.now() - last) / 86400000;
    dueLine =
      daysLeft < 0
        ? `<div class="sv-hint"><span class="sv-fail">⚠ Check overdue</span> — the every-${meta.calIntervalDays}-days cadence has lapsed.</div>`
        : `<div class="sv-hint">Next check due in <strong>${Math.ceil(daysLeft)} day${Math.ceil(daysLeft) === 1 ? '' : 's'}</strong> (every ${meta.calIntervalDays} days).</div>`;
  }

  // The registry editor: this sensor's own spec + cadence, plain fields.
  const dLbl = deltaLabel();
  const showSpecT = meta?.specTF != null ? Math.round(dispDeltaT(meta.specTF) * 100) / 100 : '';
  const regHtml =
    `<div class="sv-grid" style="margin-top:8px">` +
    `<div class="sla-field"><label for="svreg-rh">Its RH spec ± % <span class="cap-hint">from its datasheet</span></label><input type="number" inputmode="decimal" id="svreg-rh" step="0.1" min="0.1" value="${meta?.specRh ?? ''}" placeholder="default ±${SV_TOL.rhPass}"></div>` +
    `<div class="sla-field"><label for="svreg-t">Its temp spec ± ${dLbl}</label><input type="number" inputmode="decimal" id="svreg-t" step="0.1" min="0.1" value="${showSpecT}" placeholder="default ±${Math.round(dispDeltaT(SV_TOL.tPassF) * 100) / 100}"></div>` +
    `<div class="sla-field"><label for="svreg-days">Check every (days)</label><input type="number" inputmode="numeric" id="svreg-days" step="1" min="1" value="${meta?.calIntervalDays ?? ''}" placeholder="e.g. 90"></div>` +
    `</div>` +
    `<div class="cap-hint">A registered spec replaces the generic tolerance in this sensor's verdicts; an interval turns the logbook into a recall list.</div>`;

  host.innerHTML =
    `<div class="sla-field" style="margin:10px 0 6px"><label>Logbook — sensor</label>` +
    `<select id="svlog-sel" class="sla-select">${sensors.map((n) => `<option${n === selected ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</select></div>` +
    regHtml + dueLine + sections +
    `<div class="sv-actions">` +
    (sensorLog.length > 8 ? `<button class="scn-btn" id="svlog-more">${svlogShowAll ? 'Show recent only' : 'Show all history'}</button>` : '') +
    `<button class="scn-btn" id="svlog-csv">⇩ Export logbook CSV</button>` +
    `<button class="scn-btn" id="svlog-del">🗑 Delete this sensor's history</button></div>`;

  document.getElementById('svlog-sel').addEventListener('change', renderSensorLogbook);
  const regWire = (id, key, conv) => {
    document.getElementById(id)?.addEventListener('input', function () {
      const v = parseFloat(this.value);
      upsertSensorMeta(selected, { [key]: isNaN(v) || v <= 0 ? null : conv(v) });
      renderSensorValidation(); // grades + due counts follow the registry live
      renderSensorLogbook(); //    bands in the table follow the new spec too
    });
  };
  regWire('svreg-rh', 'specRh', (v) => v);
  regWire('svreg-t', 'specTF', (v) => v / deltaFromF(1, state.tempUnit || 'F'));
  regWire('svreg-days', 'calIntervalDays', (v) => Math.round(v));
  document.getElementById('svlog-more')?.addEventListener('click', () => {
    svlogShowAll = !svlogShowAll;
    renderSensorLogbook();
  });
  document.getElementById('svlog-csv')?.addEventListener('click', () => {
    // Hand-rolled CSV (zero deps): quote everything, double internal quotes.
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const head = ['date', 'sensor', 'hall', 'site', 'method', 'quantity', 'reference', 'uncertainty', 'reading', 'error', 'by'];
    const lines = [head.join(',')].concat(
      sensorLog.map((e) =>
        [e.date, e.sensor, e.hallName ?? '', e.siteName ?? '', e.method, e.quantity, e.ref, e.u, e.reading, e.err, e.tech ?? '']
          .map(q).join(','),
      ),
    );
    platformSaveFile(shell.exportName('sensor-logbook', 'csv'), lines.join('\n'));
  });
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
    renderSensorValidation(); // the overdue tally just changed
  });
}

// Naming a registered sensor re-grades the live verdict against ITS spec.
document.getElementById('sv-sensor-label')?.addEventListener('input', () => {
  renderSensorValidation();
  renderSensorLogbook(); // follow the named sensor's history and spec editor
});

document.getElementById('sv-log')?.addEventListener('click', () => {
  if (!svLoggable) return;
  const label = document.getElementById('sv-sensor-label')?.value.trim();
  if (!label) {
    toast('Name the sensor first (e.g. "CRAH-3 supply") so its history has a home.', { kind: 'warn' });
    document.getElementById('sv-sensor-label')?.focus();
    return;
  }
  const tech = document.getElementById('sv-tech')?.value.trim();
  const entry = {
    sensor: label,
    method: svState.tab,
    quantity: svLoggable.quantity,
    ref: svLoggable.ref,
    u: svLoggable.u,
    reading: svLoggable.reading,
    err: svLoggable.err,
    date: new Date().toISOString(),
  };
  // Audit context: which hall, which site, who — the first questions a
  // customer QA review asks of any calibration record.
  if (state.hall?.name) entry.hallName = state.hall.name;
  if (state.hall?.siteName) entry.siteName = state.hall.siteName;
  if (tech) entry.tech = tech;
  sensorLog.push(entry);
  persistSensorLog();
  renderSensorLogbook();
  renderSensorValidation(); // due counts may have just cleared
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
  state.aTemp = shell.clampF(svSetCurrent.tempF);
  state.aRH = shell.clampRH(svSetCurrent.rh);
  shell.syncAllControls();
  shell.update();
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


// ── Save-file interchange ───────────────────────────────────────────────────
// The merge RULES belong with the data they govern, not with the file reader:
// a log entry is a duplicate when the same sensor was checked on the same day
// by the same method, and a registry entry is superseded by name.

/** Everything a save file should carry from here. */
export const sensorSnapshot = () => ({ sensorLog, sensorRegistry });

/**
 * Fold an imported save file's sensor data in.
 * @returns {{logs:number, regs:number}} how much was genuinely new
 */
export function mergeSensorData(incomingLog, incomingRegistry) {
  let logs = 0, regs = 0;
  (incomingLog || []).forEach((e) => {
    if (!sensorLog.some((x) => x.sensor === e.sensor && x.date === e.date && x.method === e.method)) {
      sensorLog.push(e);
      logs++;
    }
  });
  // Registry merges by name — the incoming spec/cadence wins, so a colleague's
  // fresher datasheet numbers replace stale ones instead of being ignored.
  (incomingRegistry || []).forEach((m) => {
    sensorRegistry = sensorRegistry.filter((x) => x.name !== m.name).concat([m]);
    regs++;
  });
  if (regs) persistSensorRegistry();
  if (logs || regs) {
    persistSensorLog();
    renderSensorLogbook();
  }
  return { logs, regs };
}
