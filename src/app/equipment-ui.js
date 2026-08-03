/**
 * The equipment inventory panel, and the all-halls overview it feeds.
 *
 * Both surfaces answer the same question from the same data — what plant does
 * this hall have, and what is it actually delivering right now — so they live
 * together and share one rollup of the inventory.
 *
 * WHAT THIS MODULE OWNS
 *   - the inventory editor: adding, rating, derating and tagging out units
 *   - deriving the hall's planning rates from that inventory, live
 *   - the "lose one machine" redundancy answer
 *   - the all-halls list, each hall graded in its OWN air and pressure
 *
 * DEPENDENCY DIRECTION
 * Everything this needs is imported downward — state, core physics, the
 * inventory arithmetic, formatting — with one exception. Re-rendering the
 * REST of the app (the chart, the hall editor, the tabs) belongs to the entry
 * point, not to a panel, so main.js injects those few callbacks through
 * `wireEquipmentUi()` at boot. That keeps the import graph acyclic: main.js
 * imports this, this imports nothing of main.js.
 */

import { state } from './state.js';
import { thermalC } from './hallphysics.js';
import { escHtml } from '../ui/escape.js';
import { toast } from '../ui/notify.js';
import { dispTs, tLabel, fmtSlaReason } from '../ui/format.js';
import { checkSLA as checkSLACore } from '../core/envelopes.js';
import { pressureFromAltitude } from '../core/psychro.js';
import { evapMediaOutput } from '../core/evapmedia.js';
import {
  normalizeInventory, inventoryTotals, inventoryRollup, ratesFromTotals,
  unitOutput, unitsForKind, isThermalKind, isAirKind, baseUnitOf,
  logCondition, conditionTrend,
} from '../core/equipment.js';

/**
 * Callbacks into the rest of the app, supplied once at boot.
 * @type {{update:Function, renderHallEditor:Function, renderHallTabs:Function,
 *         syncAllControls:Function, switchHall:Function}}
 */
let shell = {
  update() {}, renderHallEditor() {}, renderHallTabs() {},
  syncAllControls() {}, switchHall() {},
};

/** Hand this module the few things only the entry point can do. */
export function wireEquipmentUi(callbacks) {
  shell = { ...shell, ...callbacks };
}

// Four typed rates describe a capability without describing the plant that
// produces it, which leaves ordinary questions unanswerable: CRAH-3 is out,
// what can we still do? Two of four humidifiers have scaled media — how much
// have we lost? The inventory answers those by construction: capability is
// the SUM of what is installed and working, and every unit carries its own
// condition and its own in-service state.

const EQUIP_LABEL = {
  cool: 'Cooling', heat: 'Heating', dehum: 'Dehumidifier',
  humid: 'Humidifier', air: 'Fan / AHU',
};
const UNIT_LABEL = {
  kw: 'kW', ton: 'tons', btu: 'BTU/hr', mbh: 'MBH',
  lbhr: 'lb/hr', gph: 'GPH', gpd: 'gal/day', pintday: 'pints/day',
  cfm: 'CFM', m3h: 'm³/hr', cmm: 'm³/min', lps: 'L/s',
};

/**
 * Output per evaporative unit at a GIVEN condition and pressure.
 *
 * Wetted media makes less water into damper air and less again at altitude,
 * so "how much can this humidifier do" has no answer without saying where and
 * in what. Any surface that grades a hall other than the active one has to
 * bind this to THAT hall's air — grading Denver's media with Goodyear's would
 * be a quiet, plausible-looking lie.
 *
 * @returns {(evap:{cfm:number, effPct:number}) => number}
 */
export const evapLbHrAt = (tempF, rh, pressure) => (evap) => {
  const r = evapMediaOutput({ cfm: evap.cfm, tempF, rh, effPct: evap.effPct, pressure });
  return r ? r.lbPerHr : 0;
};

/** Output per evaporative unit at the ACTIVE hall's live condition. */
export const evapUnitLbHr = (evap) => evapLbHrAt(state.aTemp, state.aRH, state.pressure)(evap);

/**
 * A unit's condition history in one line, or nothing.
 *
 * Only ever shown once there are two readings to compare: one number is a
 * fact, not a trend. Only a FALL is called out — a machine recovering after
 * service is good news and does not need to shout.
 */
function trendHtml(u) {
  const t = conditionTrend(u);
  if (!t || t.delta >= 0) return '';
  return (
    `<span class="eq-trend" title="${t.readings} readings since ${t.since}">` +
    `↓ ${t.from}% → ${t.to}% since ${escHtml(t.since)}</span>`
  );
}

/**
 * Rebuild a panel only when its markup actually changed.
 *
 * These panels re-render on every update(), which fires on every slider
 * movement. Most of those movements change nothing they display — dragging a
 * TARGET slider does not move the equipment outputs, which are computed from
 * the CURRENT point — and reassigning innerHTML throws away the DOM, the
 * listeners and any selection for nothing.
 *
 * @returns {boolean} true if the DOM was replaced and listeners need binding
 */
const lastHtml = new WeakMap();
function paintIfChanged(el, html) {
  if (lastHtml.get(el) === html) return false;
  lastHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

/** Is this hall's plan being driven by its inventory right now? */
export const ratesAreLive = (h = state.hall) =>
  h && h.rateSource === 'inventory' && (h.equipment || []).length > 0;

/**
 * Keep the hall's planning rates in step with its plant.
 *
 * Without this the inventory was a display: tag a CRAH out, watch the totals
 * drop, and the plan underneath carries on using the rate that was applied
 * days ago. The twin and the planner disagreed silently, which is the one
 * failure mode a twin exists to prevent.
 *
 * Only ever writes while the hall is in 'inventory' mode, and only writes
 * values that actually changed — this runs on every update(), including while
 * the chart is being dragged.
 *
 * @returns {boolean} whether any rate moved (the caller may need to re-render)
 */
export function syncDerivedRates() {
  if (!ratesAreLive()) return false;
  const C = thermalC();
  const derived = ratesFromTotals(inventoryTotals(state.hall.equipment, evapUnitLbHr), {
    cKJperK: C ? C.c : null,
    itKW: (state.hall.calc || {}).it,
  });
  let changed = false;
  for (const [k, v] of Object.entries(derived)) {
    if (state.hall[k] !== v) { state.hall[k] = v; changed = true; }
  }
  // The capability flags follow the plant: a hall with no humidifiers listed
  // cannot humidify, and one that has them can.
  for (const [flag, rate] of [['canDehumidify', 'rateDehumLb'], ['canHumidify', 'rateHumLb']]) {
    const able = derived[rate] != null;
    if (state.hall[flag] !== able) { state.hall[flag] = able; changed = true; }
  }
  if (changed) paintDerivedRates();
  return changed;
}

/**
 * Push derived rates into the fields that display them.
 *
 * The rate inputs are written by renderHallEditor(), which is far too heavy to
 * re-run on every update() — it would rebuild the whole card and take focus
 * with it. These five values are the only thing that moves, so they get
 * painted directly.
 */
function paintDerivedRates() {
  const set = (id, v) => {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.value = v == null ? '' : String(v);
  };
  set('rate-cool', state.hall.rateCoolF);
  set('rate-warm', state.hall.rateWarmF);
  set('rate-dehum', state.hall.rateDehumLb);
  set('rate-hum', state.hall.rateHumLb);
  set('hall-cfm', state.hall.airflowCfm);
  // The two water rates are gated by their capability checkbox, and the plant
  // just decided whether this hall has that capability at all.
  for (const [box, rate, flag] of [
    ['cap-dehum', 'rate-dehum', 'canDehumidify'],
    ['cap-hum', 'rate-hum', 'canHumidify'],
  ]) {
    const cb = /** @type {HTMLInputElement|null} */ (document.getElementById(box));
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(rate));
    if (cb) cb.checked = !!state.hall[flag];
    if (el) el.disabled = !state.hall[flag];
  }
}

/**
 * Hand the rates over to the inventory, or take them back.
 *
 * Switching to 'inventory' puts the typed rates aside rather than overwriting
 * them, because a commissioning-observed °F/hr is a measurement someone made
 * on site and losing it to a mode toggle would be indefensible. Switching back
 * restores exactly what was set aside.
 */
export function setRateSource(mode) {
  const h = state.hall;
  const KEYS = ['rateCoolF', 'rateWarmF', 'rateDehumLb', 'rateHumLb', 'airflowCfm'];
  if (mode === 'inventory') {
    if (h.rateSource !== 'inventory') {
      h.manualRates = Object.fromEntries(KEYS.map((k) => [k, h[k] ?? null]));
    }
    h.rateSource = 'inventory';
    syncDerivedRates();
  } else {
    h.rateSource = 'manual';
    if (h.manualRates) {
      for (const k of KEYS) h[k] = h.manualRates[k] ?? null;
      h.canDehumidify = h.rateDehumLb != null;
      h.canHumidify = h.rateHumLb != null;
      h.manualRates = null;
    }
  }
  shell.renderHallEditor();
  shell.update();
}

/**
 * "Lose one machine" — the question the inventory exists to answer.
 *
 * Every hall is built to some N+1 story, and the story is only true while the
 * spare capacity is real: four CRAHs at 100 % is N+1, the same four with two
 * at 70 % may not be. The loss taken is always the LARGEST machine actually
 * in service, because planning around the average failure is planning around
 * a failure that does not happen. A kind with a single machine gets said out
 * loud too — that is a single point of failure, not a redundancy figure.
 */
function redundancyHtml(redundancy) {
  const KINDS = [
    { k: 'cool', label: 'Cooling', dec: 0 },
    { k: 'heat', label: 'Heating', dec: 0 },
    { k: 'dehum', label: 'Dehumidify', dec: 1 },
    { k: 'humid', label: 'Humidify', dec: 1 },
    { k: 'air', label: 'Airflow', dec: 0 },
  ];
  const itKW = (state.hall.calc || {}).it;
  const lines = [];
  for (const { k, label, dec } of KINDS) {
    const r = redundancy[k];
    if (!r || r.worst <= 0) continue;
    const unit = baseUnitOf(k);
    const who = r.worstName ? ` <span class="cap-hint">(${escHtml(r.worstName)})</span>` : '';
    if (r.machines < 2) {
      lines.push(
        `<div><span class="cap-hint">${label}</span> <span class="calc-warn">only one machine${who} — losing it leaves nothing.</span></div>`,
      );
      continue;
    }
    // Cooling is the one kind with a demand already on file to check against.
    let verdict = '';
    if (k === 'cool' && itKW > 0) {
      verdict = r.remaining >= itKW
        ? ` <span class="sv-pass">still covers the ${itKW.toFixed(0)} kW IT load</span>`
        : ` <span class="sv-fail">short of the ${itKW.toFixed(0)} kW IT load by ${(itKW - r.remaining).toFixed(0)} kW</span>`;
    }
    lines.push(
      `<div><span class="cap-hint">${label}</span> −${r.worst.toFixed(dec)} ${unit}${who} → ` +
      `<strong>${r.remaining.toFixed(dec)} ${unit}</strong> left${verdict}</div>`,
    );
  }
  if (!lines.length) return '';
  return (
    `<div class="eq-redundancy">` +
    `<div class="sla-caps-label">Lose one machine — the biggest one that is running</div>` +
    lines.join('') +
    `</div>`
  );
}

export function renderEquipment() {
  const host = document.getElementById('equip-panel');
  if (!host) return;
  const inv = state.hall.equipment || [];
  // One walk of the inventory answers every question this panel asks of it.
  const { now, nameplate: full, redundancy } = inventoryRollup(inv, evapUnitLbHr);

  const rows = inv.map((u, i) => {
    const isEvap = !!u.evap;
    const capCell = isEvap
      ? `<input type="number" inputmode="decimal" class="cap-rate eq-f" data-i="${i}" data-k="evapCfm" value="${u.evap.cfm || ''}" placeholder="CFM" min="0" step="500" title="Airflow across the media, CFM">`
      : `<input type="number" inputmode="decimal" class="cap-rate eq-f" data-i="${i}" data-k="cap" value="${u.cap || ''}" min="0" step="1" placeholder="each">`;
    const unitCell = isEvap
      ? `<span class="cap-u">CFM ea.</span>`
      : `<select class="sla-select calc-sel eq-f" data-i="${i}" data-k="unit">${unitsForKind(u.kind)
          .map((x) => `<option value="${x}"${x === u.unit ? ' selected' : ''}>${UNIT_LABEL[x]}</option>`)
          .join('')}</select>`;
    const condTitle = isEvap
      ? 'Media saturation effectiveness — what mineral scale destroys'
      : isAirKind(u.kind)
        ? 'Delivered airflow against nameplate — filter loading, belt slip, a dead fan in the array'
        : "This unit's condition against its own nameplate";
    const condKey = isEvap ? 'evapEff' : 'condPct';
    const condVal = isEvap ? u.evap.effPct : u.condPct;
    const out = unitOutput(u, evapUnitLbHr);
    const outTxt = isAirKind(u.kind)
      ? `${Math.round(out).toLocaleString()} CFM`
      : isThermalKind(u.kind)
        ? `${out.toFixed(0)} kW`
        : `${out.toFixed(1)} lb/hr`;

    return (
      `<div class="eq-row${u.online ? '' : ' eq-off'}">` +
      `<input type="text" class="scn-input eq-f" data-i="${i}" data-k="name" value="${escHtml(u.name)}" placeholder="${EQUIP_LABEL[u.kind]} tag" maxlength="60">` +
      `<input type="number" inputmode="numeric" class="cap-rate eq-f" data-i="${i}" data-k="count" value="${u.count}" min="1" max="999" step="1" title="How many identical units">` +
      `<span class="cap-u">×</span>${capCell}${unitCell}` +
      `<input type="number" inputmode="decimal" class="cap-rate eq-f" data-i="${i}" data-k="${condKey}" value="${condVal}" min="0" max="100" step="1" title="${condTitle}">` +
      `<span class="cap-u">%</span>` +
      `<label class="cap-ck" title="In service"><input type="checkbox" class="eq-f" data-i="${i}" data-k="online"${u.online ? ' checked' : ''}> on</label>` +
      `<span class="eq-out">${u.online ? outTxt : 'out of service'}</span>` +
      `<button type="button" class="scn-del eq-del" data-i="${i}" title="Remove">✕</button>` +
      trendHtml(u) +
      `</div>`
    );
  });

  // Totals, always against nameplate — "120 of 200 lb/hr" is actionable in a
  // way a bare "120 lb/hr" is not.
  const pair = (a, b, unit, dec = 0, group = false) => {
    const f = (x) => (group ? Math.round(x).toLocaleString() : x.toFixed(dec));
    return b > 0
      ? `<strong>${f(a)}</strong> of ${f(b)} ${unit}${a < b * 0.999 ? ` <span class="sv-marginal">(${Math.round((a / b) * 100)}%)</span>` : ''}`
      : '—';
  };
  // Air changes per hour is the sanity check on an airflow figure: data halls
  // generally run tens of ACH, so a number in the single digits usually means
  // a units mix-up rather than a very calm room.
  const ach = now.airCfm > 0 && state.hall.hallVolFt3 > 0
    ? (now.airCfm * 60) / state.hall.hallVolFt3
    : null;

  const totals = inv.length
    ? `<div class="eq-totals">` +
      `<div><span class="cap-hint">Cooling</span> ${pair(now.coolKW, full.coolKW, 'kW')} <span class="cap-hint">· ${now.counts.cool} unit${now.counts.cool === 1 ? '' : 's'}</span></div>` +
      `<div><span class="cap-hint">Heating</span> ${pair(now.heatKW, full.heatKW, 'kW')}</div>` +
      `<div><span class="cap-hint">Dehumidify</span> ${pair(now.dehumLbHr, full.dehumLbHr, 'lb/hr', 1)}</div>` +
      `<div><span class="cap-hint">Humidify</span> ${pair(now.humidLbHr, full.humidLbHr, 'lb/hr', 1)} <span class="cap-hint">· ${now.counts.humid} unit${now.counts.humid === 1 ? '' : 's'}</span></div>` +
      (now.counts.air || full.airCfm > 0
        ? `<div><span class="cap-hint">Airflow</span> ${pair(now.airCfm, full.airCfm, 'CFM', 0, true)} <span class="cap-hint">· ${now.counts.air} fan${now.counts.air === 1 ? '' : 's'}${ach ? ` · ${ach.toFixed(0)} air changes/hr` : ''}</span></div>`
        : '') +
      `</div>` + redundancyHtml(redundancy) +
      (now.offline || now.degraded
        ? `<div class="calc-warn" style="margin-top:6px">⚠ ${[
            now.offline ? `${now.offline} out of service` : '',
            now.degraded ? `${now.degraded} degraded` : '',
          ].filter(Boolean).join(' · ')} — the totals above already reflect this.</div>`
        : '')
    : '<div class="cap-hint">No equipment listed yet. Add the units this hall actually has and the rates below can be derived from them — including what is offline or fouled.</div>';

  const html =
    `<div class="sla-caps-label">Installed plant — each unit counted, rated and derated on its own</div>` +
    `<div class="cap-explain">List what is really in this hall. A unit's <strong>%</strong> is its condition against its own nameplate (scaled media, a tired compressor); unticking <strong>on</strong> takes it out of service entirely. Evaporative humidifiers are computed from airflow at the hall's live condition, so their capacity moves with the room.</div>` +
    `<div id="equip-rows">${rows.join('')}</div>` +
    `<div class="eq-add-row">` +
    Object.entries(EQUIP_LABEL)
      .map(([k, lbl]) => `<button type="button" class="scn-btn eq-add" data-kind="${k}">+ ${lbl}</button>`)
      .join('') +
    `<button type="button" class="scn-btn eq-add" data-kind="humid" data-evap="1">+ Humidifier (wetted media)</button>` +
    `</div>` + totals +
    (inv.length
      ? ratesAreLive()
        ? `<div class="eq-live"><span class="badge badge-ok">● live</span> The rates below are coming from this inventory and follow every change you make here.` +
          `<button type="button" class="scn-btn" id="equip-manual">Type the rates by hand instead</button></div>`
        : `<div class="eq-add-row"><button type="button" class="scn-btn scn-btn-primary" id="equip-apply">Drive the rates below from this inventory</button></div>`
      : '');
  // Nothing to rebind if the panel is already showing exactly this.
  if (!paintIfChanged(host, html)) return;

  host.querySelectorAll('.eq-f').forEach((/** @type {HTMLInputElement} */ el) =>
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', function () {
      const u = state.hall.equipment[+this.dataset.i];
      if (!u) return;
      const k = this.dataset.k;
      if (k === 'online') u.online = this.checked;
      else if (k === 'name') u.name = this.value;
      else if (k === 'unit') u.unit = this.value;
      else if (k === 'evapCfm') u.evap.cfm = parseFloat(this.value) || 0;
      else if (k === 'evapEff') u.evap.effPct = Math.min(100, Math.max(1, parseFloat(this.value) || 1));
      else u[k] = parseFloat(this.value) || (k === 'count' ? 1 : 0);
      // Condition is the one field worth remembering over time: a machine
      // fading over months is a maintenance signal, and it was being lost the
      // moment the number was overwritten.
      if (k === 'condPct' || k === 'evapEff') {
        logCondition(u, k === 'evapEff' ? u.evap.effPct : u.condPct, new Date().toISOString().slice(0, 10));
      }
      state.hall.equipment = normalizeInventory(state.hall.equipment);
      renderEquipment();
      shell.update();
    }),
  );
  host.querySelectorAll('.eq-del').forEach((/** @type {HTMLElement} */ b) =>
    b.addEventListener('click', () => {
      state.hall.equipment.splice(+b.dataset.i, 1);
      renderEquipment();
      shell.update();
    }),
  );
  host.querySelectorAll('.eq-add').forEach((/** @type {HTMLElement} */ b) =>
    b.addEventListener('click', () => {
      const kind = b.dataset.kind;
      const seed = { kind, name: '', count: 1, cap: 0 };
      if (b.dataset.evap) seed.evap = { cfm: state.hall.airflowCfm || 0, effPct: 85 };
      state.hall.equipment = normalizeInventory([...(state.hall.equipment || []), seed]);
      renderEquipment();
      shell.update();
    }),
  );
  document.getElementById('equip-apply')?.addEventListener('click', () => {
    // Nothing derivable yet: say which of the two things is missing rather
    // than switching into a live mode that would blank every rate.
    const C = thermalC();
    const anyCapacity = now.coolKW > 0 || now.heatKW > 0 || now.dehumLbHr > 0 ||
      now.humidLbHr > 0 || now.airCfm > 0;
    if (!anyCapacity) {
      toast('Nothing to derive from yet — give the units above their capacities.',
        { kind: 'warn', duration: 7000 });
      return;
    }
    if (!C && (now.coolKW > 0 || now.heatKW > 0)) {
      toast('Set the hall air volume first: turning kW into °F/hr needs the mass of air being conditioned.',
        { kind: 'warn', duration: 7000 });
      return;
    }
    setRateSource('inventory');
    toast('The rates now follow this inventory — change a unit and the plan changes with it.',
      { kind: 'ok', duration: 6000 });
  });
  document.getElementById('equip-manual')?.addEventListener('click', () => {
    setRateSource('manual');
    toast('Back to typed rates — your earlier numbers are restored.', { kind: 'ok' });
  });
}

// One row per hall, each judged at ITS OWN elevation against the active SLA.
// Halls differ in pressure, so the same temperature and humidity is not the
// same dew point in Denver as in Goodyear — this is the only surface that
// shows that side by side.

export function renderAllHalls() {
  const host = document.getElementById('allhalls-body');
  const sub = document.getElementById('allhalls-sub');
  if (!host) return;
  const sla = state.slaProfiles[state.activeSla];
  let breaches = 0;
  let unplanned = 0;
  let plantIssues = 0;

  const rows = state.hallProfiles.map((h, i) => {
    const active = i === state.activeHall;
    // The active hall's live point may not be stashed yet; use what is on screen.
    const c = active
      ? { aTemp: state.aTemp, aRH: state.aRH, bTemp: state.bTemp, bRH: state.bRH }
      : h.cond;
    const p = h.baroKpa != null ? h.baroKpa : pressureFromAltitude(h.elevFt ?? 0);
    const rates = ['rateCoolF', 'rateWarmF'].some((k) => h[k] > 0);
    if (!rates) unplanned++;

    let status;
    if (!c) {
      status = '<span class="cap-hint">not set up yet</span>';
    } else {
      const chk = checkSLACore(sla, c.aTemp, c.aRH);
      if (!chk.ok) breaches++;
      status = chk.ok
        ? '<span class="badge badge-ok">✓ in SLA</span>'
        : `<span class="badge badge-bad">✗ ${escHtml(fmtSlaReason(chk))}</span>`;
    }

    // Plant status, computed at THIS hall's own air — a humidifier's output
    // depends on the room it is in, so the active hall's condition would grade
    // the wrong thing. A hall never worked on has no condition to grade with,
    // so its media contributes nothing rather than a borrowed number.
    const evapHere = c ? evapLbHrAt(c.aTemp, c.aRH, p) : () => 0;
    const inv = h.equipment || [];
    const plantBits = [];
    if (inv.length) {
      const { now: t, redundancy } = inventoryRollup(inv, evapHere);
      if (t.offline) plantBits.push(`${t.offline} out of service`);
      if (t.degraded) plantBits.push(`${t.degraded} degraded`);
      // Only a FAILING redundancy check earns space here: "you cannot lose a
      // machine" is worth interrupting a scan for, "you can" is not.
      const itKW = (h.calc || {}).it;
      const r = redundancy.cool;
      if (r && itKW > 0 && r.remaining < itKW) {
        plantBits.push(`losing ${escHtml(r.worstName || 'the largest unit')} drops below the IT load`);
      }
    }
    if (plantBits.length) plantIssues++;

    const cond = c
      ? `${dispTs(c.aTemp)}${tLabel()} · ${Math.round(c.aRH)}%  →  ${dispTs(c.bTemp)}${tLabel()} · ${Math.round(c.bRH)}%`
      : '—';
    const where = [h.siteName, h.building].filter(Boolean).join(' · ');
    return (
      `<button type="button" class="hall-row${active ? ' is-active' : ''}" data-hall="${i}">` +
      `<span><span class="hr-name">${escHtml(h.name || `Hall ${i + 1}`)}</span>` +
      `${where ? `<br><span class="hr-meta">${escHtml(where)}</span>` : ''}` +
      `<br><span class="hr-meta">${Math.round(h.elevFt ?? 0).toLocaleString()} ft · ${p.toFixed(1)} kPa` +
      `${rates ? '' : ' · no plant rates'}</span>` +
      (plantBits.length ? `<br><span class="hr-plant">⚠ ${plantBits.join(' · ')}</span>` : '') +
      `</span>` +
      `<span class="hr-cond">${cond}</span>${status}</button>`
    );
  });

  const html = rows.join('') ||
    '<div class="sv-hint">No halls yet — add one in the Data Hall card.</div>';
  if (paintIfChanged(host, html)) {
    host.querySelectorAll('[data-hall]').forEach((/** @type {HTMLElement} */ b) =>
      b.addEventListener('click', () => {
        const i = +b.dataset.hall;
        if (i === state.activeHall) return;
        shell.switchHall(i);
        shell.renderHallTabs(); shell.renderHallEditor(); shell.syncAllControls(); shell.update();
      }),
    );
  }

  if (sub) {
    const n = state.hallProfiles.length;
    sub.textContent =
      `${n} hall${n === 1 ? '' : 's'}` +
      (breaches ? ` · ⚠ ${breaches} outside ${sla.name}` : ' · all inside SLA') +
      (unplanned ? ` · ${unplanned} missing plant rates` : '') +
      (plantIssues ? ` · ${plantIssues} with plant to look at` : '');
  }
}
