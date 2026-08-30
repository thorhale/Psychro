/**
 * The Data Hall card: hall identity, plant capability and rates, the
 * derive-from-specs calculators, the ventilation water readout, real-world
 * efficiency factors, and the plan-vs-actual / trend-import panel.
 *
 * Lifted out of main.js, where `renderHallEditor` alone had reached 698 lines
 * inside a 3,000-line entry point. Nothing about it changed in the move: the
 * markup, the wiring and the nested helpers (`renderPva`, `runRateCalc`,
 * `applyTrendText`) came across verbatim, which is what makes the existing
 * end-to-end suite a meaningful check on the extraction.
 *
 * It takes the handful of things only the entry point can do through `shell`,
 * the same pattern `equipment-ui.js` uses — a panel that imports back from
 * main.js creates the cycle that makes panels impossible to extract at all.
 */

import { state } from './state.js';
import { inp } from '../ui/dom.js';
import { toast } from '../ui/notify.js';
import {
  tU, dispTs, dispT1, disp1, tLabel, dispDeltaT, deltaLabel, mDisp, mTo, mLabel,
} from '../ui/format.js';
import {
  fToC, ft3ToM3, cfmToM3s, toKW, toLbHr, deltaFromF, LATENT_BTU_PER_LB,
} from '../core/units.js';
import { humidityRatio, saturationHumidityRatio, specificVolume } from '../core/psychro.js';
import { checkRamp } from '../core/envelopes.js';
import { rampPlanFor as rampPlanCore, fmtHrs } from '../core/planner.js';
import { evapMediaOutput, effectivenessFromOutput } from '../core/evapmedia.js';
import { ventilationWater } from '../core/ventilation.js';
import { parseTrendCsv, maxWindowedRate } from '../lib/trendcsv.js';
import { renderEquipment, ratesAreLive } from './equipment-ui.js';
import { currentW, thermalC } from './hallphysics.js';

/**
 * The few things only the entry point can do.
 * @type {{update:Function, planMove:Function, syncAllControls:Function,
 *         renderHallTabs:Function, applyElevation:Function,
 *         syncActualTrailToHall:Function, syncLegend:Function}}
 */
let shell = {
  update() {}, planMove() { return { hours: 0 }; }, syncAllControls() {},
  renderHallTabs() {}, applyElevation() {}, syncActualTrailToHall() {}, syncLegend() {},
};

/** Hand this module the few things only the entry point can do. */
export function wireHallEditor(callbacks) {
  shell = { ...shell, ...callbacks };
}

/**
 * Imported BMS trend, drawn on the chart when state.visible.actual is on.
 *
 * Session-scoped on purpose: a trail belongs to the move it recorded, not to
 * every future session — the durable record is the calibration entry.
 *
 * It lives here because the trend panel that produces it lives here. main.js
 * reads it through the accessors below rather than sharing a mutable binding
 * across the module seam, which is what made this variable the one thing the
 * extraction could not simply carry across.
 * @type {any}
 */
let actualTrail = null;

/** The imported trail, or null. Read by the chart and the hall-switch guard. */
export const getActualTrail = () => actualTrail;

/**
 * Drop the imported trail and its legend layer.
 *
 * A trail records ONE move in ONE hall: left on screen across a hall switch it
 * was re-projected onto the new hall's pressure axis, still labelled "Actual",
 * with the panel that named its source file gone.
 */
export function clearActualTrail() {
  if (!actualTrail) return;
  actualTrail = null;
  state.visible.actual = false;
  const out = inp('trend-res');
  if (out) { out.style.display = 'none'; out.textContent = ''; }
  shell.syncLegend();
}

/**
 * Clear the trail if the active hall is no longer the one it was imported for.
 * Checked centrally rather than at each switch site, because halls also change
 * via "add hall", delete, and the location/building filters.
 */
export function syncActualTrailToHall() {
  if (actualTrail && actualTrail.hall !== state.activeHall) clearActualTrail();
}

// ── Steady-state ventilation water readout ──────────────────────────────────
// Painted from shell.update() (it is a readout, not an input, so repainting while
// someone types into the CFM field above it is safe). Uses the TARGET point:
// this is the duty of holding the hall where you want it, not where it is.
export function paintVentReadout() {
  const el = inp('vent-res');
  if (!el) return;
  const h = state.hall;
  if (!(h.doasCfm > 0)) { el.textContent = '—'; return; }
  const r = ventilationWater({
    cfm: h.doasCfm, roomTempF: state.bTemp, roomRH: state.bRH,
    outdoorDpF: h.designDpF, pressureKpa: state.pressure,
  });
  if (!r) {
    el.innerHTML = 'The design outdoor dew point is wetter than the Target room — ventilation <em>adds</em> moisture at this setpoint, so the humidifiers idle. (Dehumidification load is a different question.)';
    return;
  }
  const basis = h.designDpF == null
    ? 'bone-dry outdoor air assumed'
    : `outdoor dew point ${dispTs(h.designDpF)}${tLabel()}`;
  // Duty against the plant as it stands today: nameplate × efficiency × derate.
  const rate = h.canHumidify && h.rateHumLb > 0
    ? h.rateHumLb * ((h.effPct ?? 100) / 100) * ((h.derateHumPct ?? 100) / 100)
    : null;
  const duty = rate ? ` — <strong>${(r.lbPerHr / rate * 100).toFixed(0)}%</strong> of today's humidify capacity` : '';
  const sla = state.slaProfiles[state.activeSla];
  const settle = r.settleRH < (sla?.rhMin ?? 0)
    ? ` Humidifiers off, the room settles near <strong>${disp1(r.settleRH)}% RH</strong> — below this SLA's ${sla.rhMin}% floor, so this is standing duty, not margin.`
    : '';
  el.innerHTML = `Holding Target ${dispTs(state.bTemp)}${tLabel()} / ${disp1(state.bRH)}% with ${h.doasCfm.toLocaleString()} CFM outside air (${basis}): ` +
    `<strong>${r.lbPerHr.toFixed(1)} lb/hr · ${r.galPerDay.toFixed(0)} gal/day</strong> of humidifier water${duty}.${settle}` +
    ` Evaporative units drinking utility water: budget 1.5–3× that for bleed-off.`;
}

export function renderHallEditor() {
  const hed = inp('hall-editor');
  if (!hed) return;
  syncActualTrailToHall(); // A's measured trajectory is not B's

  // A plant rate is STORED canonically in °F/hr but typed and read in whatever
  // unit is on screen. A rate is a DELTA per hour, so it scales — 9 °F/hr is
  // 5 °C/hr — and never offsets.
  const showRate = (f) => (f == null ? '' : String(Math.round(dispDeltaT(f) * 10) / 10));

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
    <div class="sla-field"><label for="hall-elev">Elevation ft <span class="cap-hint">preset from location; fine-tune here</span></label><input type="number" id="hall-elev" aria-label="Site elevation, feet" value="${state.hall.elevFt ?? 0}" step="any" min="-15000" max="20000" ></div>
    <div class="sla-field"><label for="hall-baro">Measured pressure <span class="u">kPa</span> <span class="cap-hint">optional — a barometer beats the elevation estimate</span></label><input type="number" inputmode="decimal" id="hall-baro" aria-label="Measured barometric pressure, kilopascals" value="${state.hall.baroKpa ?? ''}" step="0.1" min="55" max="110" placeholder="blank = from elevation"></div>
    <div class="sla-caps">
      <div class="sla-caps-label">Plant capability &amp; rates — what this hall can actually do</div>
      <div class="cap-explain">Temperature rates: use commissioning-observed ${deltaLabel()}/hr, or derive a physics estimate below (IT load, excess sensible capacity, thermal mass). Moisture is first-principles: hall air mass × ΔW ÷ equipment lb/hr. Enter NET capacity (nameplate minus steady makeup-air latent load). Blank = not plant-limited; the SLA ramp limit still governs.</div>
      <div id="equip-panel"></div>
      <div class="cap-line"><span class="cap-name">Hall air volume <span class="cap-hint">for the moisture mass balance</span></span><input type="number" id="hall-vol" aria-label="Hall air volume" class="cap-rate" value="${mDisp(state.hall.hallVolFt3, 'volume')}" placeholder="—" step="any" min="0"><span class="cap-u">${mLabel('volume')}</span></div>
      <div class="cap-line"><span class="cap-name">Supply airflow <span class="cap-hint">for the cooling-load estimate</span></span><input type="number" id="hall-cfm" aria-label="Supply airflow" class="cap-rate" value="${mDisp(state.hall.airflowCfm, 'flow')}" placeholder="—" step="any" min="0"><span class="cap-u">${mLabel('flow')}</span></div>
      <div class="cap-line"><span class="cap-name">Cooling</span><input type="number" id="rate-cool" aria-label="Cooling rate, degrees per hour" class="cap-rate" value="${showRate(state.hall.rateCoolF)}" placeholder="—" step="0.1" min="0"><span class="cap-u">${deltaLabel()}/hr</span></div>
      <div class="cap-line"><span class="cap-name">Warming <span class="cap-hint">reheat or IT load</span></span><input type="number" id="rate-warm" aria-label="Warming rate, degrees per hour" class="cap-rate" value="${showRate(state.hall.rateWarmF)}" placeholder="—" step="0.1" min="0"><span class="cap-u">${deltaLabel()}/hr</span></div>
      <div class="cap-line"><label class="cap-ck"><input type="checkbox" id="cap-dehum" ${state.hall.canDehumidify?'checked':''}> Dehumidify</label><input type="number" id="rate-dehum" aria-label="Dehumidify rate" class="cap-rate" value="${mDisp(state.hall.rateDehumLb, 'massRate')}" placeholder="—" step="0.1" min="0" ${state.hall.canDehumidify?'':'disabled'}><span class="cap-u">${mLabel('massRate')}</span></div>
      <div class="cap-line"><label class="cap-ck"><input type="checkbox" id="cap-hum" ${state.hall.canHumidify?'checked':''}> Humidify</label><input type="number" id="rate-hum" aria-label="Humidify rate" class="cap-rate" value="${mDisp(state.hall.rateHumLb, 'massRate')}" placeholder="—" step="0.1" min="0" ${state.hall.canHumidify?'':'disabled'}><span class="cap-u">${mLabel('massRate')}</span></div>
      <details class="calc">
        <summary>Derive your rates from equipment specs <span class="sect-chev">▸</span></summary>
        <div class="calc-body">
          <div class="calc-intro">Pick the equipment you actually have; enter the number straight off the manufacturer's schedule. Uses the live Current condition, site pressure, and hall volume.</div>

          <div class="calc-method">Shared — thermal mass</div>
          <div class="calc-grid2">
            <input type="number" id="rc-it" class="cap-rate" value="${(state.hall.calc||{}).it ?? ''}" placeholder="IT load kW" min="0" step="any">
            <input type="number" id="rc-mass" class="cap-rate" value="${(state.hall.calc||{}).mass ?? ''}" placeholder="equip mass lb (opt)" min="0" step="any">
          </div>
          <div class="calc-hint2">Capacitance = hall air + equipment mass (cₚ≈0.12 BTU/lb·°F). Blank mass = air-only ceiling.</div>

          <div class="calc-method mt">Cooling <span class="cap-hint">total sensible delivered — any source</span></div>
          <div class="calc-grid">
            <input type="number" id="cc-units" class="cap-rate" value="${(state.hall.calc||{}).ccUnits ?? ''}" placeholder="units" min="0" step="1">
            <span class="calc-x">×</span>
            <input type="number" id="cc-cap" class="cap-rate" value="${(state.hall.calc||{}).ccCap ?? ''}" placeholder="sensible ea." min="0" step="0.1">
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
            <input type="number" id="wc-reheat" class="cap-rate" value="${(state.hall.calc||{}).reheat ?? ''}" placeholder="+ reheat kW (opt)" min="0" step="0.1">
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
              <input type="number" id="dh-each" class="cap-rate" value="${(state.hall.calc||{}).dhEach ?? ''}" placeholder="removal ea." min="0" step="0.1">
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
              <input type="number" id="dh-lat" class="cap-rate" value="${(state.hall.calc||{}).dhLat ?? ''}" placeholder="latent ea." min="0" step="0.1">
              <select id="dh-latunit" class="sla-select calc-sel">
                <option value="ton"${((state.hall.calc||{}).dhLatUnit??'ton')==='ton'?' selected':''}>lat. tons</option>
                <option value="kw"${(state.hall.calc||{}).dhLatUnit==='kw'?' selected':''}>kW</option>
                <option value="mbh"${(state.hall.calc||{}).dhLatUnit==='mbh'?' selected':''}>MBH</option>
              </select>
            </div>
          </div>
          <div id="dh-coil" class="dh-pane" style="display:none">
            <div class="calc-grid2">
              <input type="number" id="dc-cfm" class="cap-rate" value="${(state.hall.calc||{}).cfm ?? ''}" placeholder="total CFM" min="0" step="any">
              <input type="number" id="dc-dp" class="cap-rate" value="${(state.hall.calc||{}).dp != null ? dispT1((state.hall.calc||{}).dp) : ''}" placeholder="supply DP ${tLabel()}" step="0.1">
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
              <input type="number" inputmode="decimal" id="hc-cfm" class="cap-rate" value="${(state.hall.calc||{}).hCfm ?? ''}" placeholder="airflow across media CFM" min="0" step="any">
              <input type="number" inputmode="decimal" id="hc-eff" class="cap-rate" value="${(state.hall.calc||{}).hEff ?? ''}" placeholder="saturation eff. %" min="1" max="100" step="0.1">
            </div>
            <div class="calc-hint2">Saturation effectiveness comes from your media's own data — the fraction of the theoretical maximum it actually achieves. <strong>This is the number mineral scale destroys:</strong> as deposits block wetted surface and channel air past it, effectiveness falls and so does capacity. Re-enter it as the media fouls, or measure it below.</div>
            <div class="calc-grid2" style="margin-top:8px">
              <input type="number" inputmode="decimal" id="hc-meas" class="cap-rate" value="${(state.hall.calc||{}).hMeas ?? ''}" placeholder="measured output lb/hr (optional)" min="0" step="0.1">
              <span class="calc-inline-note">↳ back-calculates the effectiveness you are really getting</span>
            </div>
          </div>
          <div class="calc-grid" id="hc-rated">
            <input type="number" id="hc-qty" class="cap-rate" value="${(state.hall.calc||{}).hQty ?? ''}" placeholder="units" min="0" step="1">
            <span class="calc-x">×</span>
            <input type="number" id="hc-each" class="cap-rate" value="${(state.hall.calc||{}).hEach ?? ''}" placeholder="output ea." min="0" step="0.1">
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
      <div class="sla-caps-label">Ventilation moisture load — steady-state humidifier duty</div>
      <div class="cap-explain">Once the hall is holding its Target, the humidifiers only replace what the outside-air ventilation carries out: DOAS dry-air mass × (room moisture − outdoor moisture). Leave the dew point blank to assume bone-dry outdoor air — the worst case no weather record can beat.</div>
      <div class="cap-line"><span class="cap-name">DOAS outside air <span class="cap-hint">fresh-air makeup, not the recirculating supply</span></span><input type="number" id="hall-doas" aria-label="DOAS outside air" class="cap-rate" value="${mDisp(state.hall.doasCfm, 'flow')}" placeholder="—" step="any" min="0"><span class="cap-u">${mLabel('flow')}</span></div>
      <div class="cap-line"><span class="cap-name">Design outdoor dew point <span class="cap-hint">blank = bone dry, the worst case</span></span><input type="number" id="hall-ddp" aria-label="Design outdoor dew point" class="cap-rate" value="${state.hall.designDpF != null ? dispT1(state.hall.designDpF) : ''}" placeholder="—" step="0.1"><span class="cap-u">${tLabel()}</span></div>
      <div class="calc-res" id="vent-res" role="status" aria-live="polite">—</div>
    </div>
    <div class="sla-caps">
      <div class="sla-caps-label">Real-world factors — efficiency &amp; current capacity</div>
      <div class="cap-explain"><strong>Efficiency factor</strong>: the fraction of nameplate performance this hall actually delivers once mixing losses, stratification, control deadbands, and sensor lag are paid — <strong>85% is the planning default</strong>; calibrate it with logged results below. <strong>Capacity derates</strong>: today's temporary reductions — chillers offline, crusty evaporative media on the humidifiers, fouled coils. Every plant rate is scaled by efficiency × derate before timing a move.</div>
      <div class="cap-line"><span class="cap-name">Efficiency factor <span class="cap-hint">predicted real-world vs. nameplate</span></span><input type="number" id="hall-eff" aria-label="Plant efficiency factor, percent" class="cap-rate" value="${state.hall.effPct ?? 85}" step="0.1" min="1" max="150"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Cooling capacity today <span class="cap-hint">e.g. chillers down for service</span></span><input type="number" id="der-cool" aria-label="Cooling capacity available today, percent" class="cap-rate" value="${state.hall.derateCoolPct ?? 100}" step="0.1" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Warming capacity today</span><input type="number" id="der-warm" aria-label="Warming capacity available today, percent" class="cap-rate" value="${state.hall.derateWarmPct ?? 100}" step="0.1" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Dehumidify capacity today</span><input type="number" id="der-dehum" aria-label="Dehumidify capacity available today, percent" class="cap-rate" value="${state.hall.derateDehumPct ?? 100}" step="0.1" min="1" max="100"><span class="cap-u">%</span></div>
      <div class="cap-line"><span class="cap-name">Humidify capacity today <span class="cap-hint">e.g. crusty evap media</span></span><input type="number" id="der-hum" aria-label="Humidify capacity available today, percent" class="cap-rate" value="${state.hall.derateHumPct ?? 100}" step="0.1" min="1" max="100"><span class="cap-u">%</span></div>
    </div>
    <div class="sla-caps">
      <div class="sla-caps-label">Predicted vs. actual — calibrate the efficiency factor</div>
      <div class="cap-explain">After a real move finishes, log how long it actually took. Implied efficiency = time predicted at nameplate (with today's capacity derates) ÷ actual time. Runs where the SLA ramp limit — not the plant — was the binding constraint are kept for the record but excluded from calibration, since they can't reveal plant efficiency.</div>
      <div class="calc-res" id="pva-pred" role="status" aria-live="polite">—</div>
      <div class="calc-grid2">
        <input type="number" id="pva-actual" class="cap-rate" placeholder="actual duration" min="0" step="1">
        <select id="pva-unit" class="sla-select calc-sel" aria-label="Unit for the actual duration"><option value="min">minutes</option><option value="hr">hours</option></select>
      </div>
      <div class="addcity-actions" style="margin-top:8px"><button type="button" class="scn-btn scn-btn-primary" id="pva-log">Log this move's result</button></div>
      <div id="pva-list" style="margin-top:10px"></div>
      <div class="cap-explain" style="margin-top:12px"><strong>Or import the trend export.</strong> Drop the BMS/BAS CSV of the move (time, temp, RH columns) — the actual trajectory overlays the chart next to the plan, and the measured duration feeds the same calibration with no stopwatch honesty required.</div>
      <div class="addcity-actions"><button type="button" class="scn-btn" id="trend-import">⤒ Import trend CSV</button><input type="file" id="trend-file" accept=".csv,text/csv" style="display:none"></div>
      <div class="calc-res" id="trend-res" role="status" aria-live="polite" style="display:none"></div>
    </div>
  `;
  // Capability checkboxes are always active (a site characteristic, like elevation).
  const capWire = (id, key) => {
    const el = inp(id);
    if (el) el.addEventListener('change', function() {
      state.hall[key] = this.checked;   // Target sliders stay wherever they are — no reclamp needed.
      shell.syncAllControls(); shell.update();
      renderHallEditor();   // refresh paired rate-field enabled state
    });
  };
  capWire('cap-dehum', 'canDehumidify');
  capWire('cap-hum', 'canHumidify');
  // Plant rate fields — always editable (a site attribute, like elevation).
  /**
   * @param {string} id
   * @param {string} key
   * @param {boolean} [isTempRate] true for the °F/hr rates, which are stored
   *   canonically but typed in whatever unit is on screen. A rate is a DELTA
   *   per hour, so it scales (÷1.8 for °C) and never offsets: 9 °F/hr is
   *   5 °C/hr, not −12.8. Without this, an operator working in °C typed "5"
   *   meaning 5 °C/hr and the hall stored 5 °F/hr — 2.8 °C/hr, so every
   *   predicted duration came out nearly twice as long as the plant can do.
   * @param {'volume'|'flow'|'massRate'|'water'|'pressure'} [measureKind] set
   *   for a quantity that follows the IP/SI toggle, so a value typed in m³ is
   *   stored as the ft³ every calculation uses.
   */
  const rateWire = (id, key, isTempRate = false, measureKind = undefined) => {
    const el = inp(id);
    if (el) el.addEventListener('input', function() {
      const typed = parseFloat(this.value);
      // Three cases, and getting any of them wrong stores a wrong number
      // silently: a temperature RATE scales (9 °F/hr is 5 °C/hr), a measured
      // quantity converts back to canonical (m³ typed, ft³ stored), and
      // everything else is already canonical.
      const v = isTempRate ? typed / deltaFromF(1, state.tempUnit || 'F')
        : measureKind ? mTo(typed, measureKind)
        : typed;
      state.hall[key] = (v == null || isNaN(v) || v <= 0) ? null : v;
      shell.update();
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
  rateWire('rate-cool',  'rateCoolF', true);
  rateWire('rate-warm',  'rateWarmF', true);
  rateWire('rate-dehum', 'rateDehumLb', false, 'massRate');
  rateWire('rate-hum',   'rateHumLb',   false, 'massRate');
  rateWire('hall-vol',   'hallVolFt3',  false, 'volume');
  rateWire('hall-cfm',   'airflowCfm',  false, 'flow');

  // Hall identity fields — name renames the tab; building/site feed the
  // Location/Building filters above the tabs; site/elevation drive pressure.
  const nameEl = inp('hall-name');
  if (nameEl) nameEl.addEventListener('input', function() {
    state.hall.name = this.value;
    shell.renderHallTabs(); shell.update();
  });
  const bldEl = inp('hall-building');
  if (bldEl) bldEl.addEventListener('input', function() {
    state.hall.building = this.value;
    // Editing must never filter the hall you're typing in out of view.
    if (state.hallView.bld && this.value.trim() !== state.hallView.bld) state.hallView.bld = '';
    shell.renderHallTabs(); shell.update();
  });
  const siteEl = inp('hall-site');
  if (siteEl) siteEl.addEventListener('input', function() {
    state.hall.siteName = this.value;
    if (state.hallView.loc && this.value.trim() !== state.hallView.loc) state.hallView.loc = '';
    shell.applyElevation(); shell.renderHallTabs(); shell.update();
  });
  const elevEl = inp('hall-elev');
  if (elevEl) elevEl.addEventListener('input', function() {
    const v = parseFloat(this.value); if (isNaN(v)) return;
    // Not rounded: a surveyed pad elevation can carry a decimal, and the
    // pressure model has no reason to refuse it.
    state.hall.elevFt = Math.max(-15000, Math.min(20000, v));
    shell.applyElevation(); shell.update();
  });
  const baroEl = inp('hall-baro');
  if (baroEl) baroEl.addEventListener('input', function() {
    const v = parseFloat(this.value);
    // Blank or out-of-window clears the override — back to the elevation model.
    state.hall.baroKpa = isNaN(v) || v < 55 || v > 110 ? null : v;
    shell.applyElevation(); shell.update();
  });

  // Ventilation moisture load — DOAS CFM plus a unit-aware design dew point.
  const doasEl = inp('hall-doas');
  if (doasEl) doasEl.addEventListener('input', function() {
    const v = mTo(parseFloat(this.value), 'flow');
    state.hall.doasCfm = v == null || isNaN(v) || v <= 0 ? null : Math.min(v, 1e6);
    shell.update();
  });
  const ddpEl = inp('hall-ddp');
  if (ddpEl) ddpEl.addEventListener('input', function() {
    const v = parseFloat(this.value);
    state.hall.designDpF = isNaN(v) ? null : Math.max(-80, Math.min(90, tU().toF(v)));
    shell.update();
  });
  paintVentReadout(); // the freshly built readout div starts painted, not '—'

  // Real-world factor fields (%): efficiency + per-system capacity derates.
  const pctWire = (id, key, lo, hi, dflt) => {
    const el = inp(id);
    if (el) el.addEventListener('input', function() {
      const v = parseFloat(this.value);
      state.hall[key] = isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v));
      shell.update();
    });
  };
  pctWire('hall-eff', 'effPct',        1, 150, 85);
  pctWire('der-cool',  'derateCoolPct',  1, 100, 100);
  pctWire('der-warm',  'derateWarmPct',  1, 100, 100);
  pctWire('der-dehum', 'derateDehumPct', 1, 100, 100);
  pctWire('der-hum',   'derateHumPct',   1, 100, 100);

  // ── Predicted vs. actual — log real results, back out implied efficiency ──
  function renderPva() {
    const planEff = shell.planMove();                       // with efficiency
    const planNom = shell.planMove({ nameplate: true });  // nameplate × derates
    const predEl = inp('pva-pred');
    if (predEl) {
      if (planNom.hours > 0) {
        predEl.innerHTML = `Current move ${dispTs(state.aTemp)}${tLabel()}/${disp1(state.aRH)}% → ${dispTs(state.bTemp)}${tLabel()}/${disp1(state.bRH)}%: predicted <strong>${fmtHrs(planEff.hours)}</strong> at ${Math.round(state.hall.effPct ?? 100)}% eff · ${fmtHrs(planNom.hours)} at nameplate · binding: ${planNom.binding}`;
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
          <div class="scn-item-name">${dispTs(r.aTemp)}${tLabel()}/${disp1(r.aRH)}% → ${dispTs(r.bTemp)}${tLabel()}/${disp1(r.bRH)}%</div>
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
      state.hall.results.splice(+(/** @type {HTMLElement} */ (b)).dataset.pvadel, 1); renderPva(); shell.update();
    }));
    const applyBtn = inp('pva-apply');
    if (applyBtn) applyBtn.addEventListener('click', () => {
      state.hall.effPct = Math.max(1, Math.min(150, Math.round(avgEff * 100)));
      renderHallEditor(); shell.update();
    });
  }
  const pvaLog = inp('pva-log');
  if (pvaLog) pvaLog.addEventListener('click', () => {
    const v = parseFloat(inp('pva-actual').value);
    if (!(v > 0)) { toast('Enter the actual duration the move took.', { kind: 'warn' }); return; }
    const hrs = inp('pva-unit').value === 'hr' ? v : v / 60;
    const planEff = shell.planMove();
    const planNom = shell.planMove({ nameplate: true });
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
    renderPva(); shell.update();
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
      shell.syncLegend();

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
          `${dispTs(first.tempF)}→${dispTs(last.tempF)} ${tLabel()}, ${disp1(first.rh)}→${disp1(last.rh)}%RH.` +
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
          renderPva(); shell.update();
        });
      shell.update();
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
    cs.cfm = num('dc-cfm');
    // Supply dew point is an absolute temperature, typed in whatever unit is
    // on screen — convert to the canonical °F the coil maths expects.
    { const v = num('dc-dp'); cs.dp = v == null ? null : tU().toF(v); }
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
    const rateF = kw => kw * 3600 / C.c * 1.8;                    // °F/hr, canonical
    // …shown in the active unit. A rate is a delta per hour, so it scales.
    const showR = (f) => `${(Math.round(dispDeltaT(f) * 10) / 10).toFixed(1)} ${deltaLabel()}/hr`;
    const tag = C && C.airOnly ? ' <span class="cap-hint">(air-only ceiling)</span>' : '';

    // Cooling — excess sensible over IT load
    const cc = g('cc-res');
    if (cc) {
      if (cs.ccUnits > 0 && cs.ccCap > 0 && cs.it != null) {
        if (!C) cc.innerHTML = '<span class="calc-warn">Set hall volume first.</span>';
        else {
          const excess = toKW(cs.ccUnits * cs.ccCap, cs.ccUnit) - cs.it;
          if (excess <= 0) cc.innerHTML = '<span class="calc-warn">No pulldown margin — sensible capacity ≤ IT load.</span>';
          else cc.innerHTML = `excess ${excess.toFixed(0)} kW → <strong>${showR(rateF(excess))}</strong>${tag} <button class="calc-apply" data-rk="rateCoolF" data-rv="${rateF(excess).toFixed(2)}">Apply</button>`;
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
          wc.innerHTML = `${q.toFixed(0)} kW → <strong>${showR(rateF(q))}</strong>${tag} <button class="calc-apply" data-rk="rateWarmF" data-rv="${rateF(q).toFixed(2)}">Apply</button>`;
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
            `At the Current point (${dispTs(state.aTemp)}${tLabel()} / ${disp1(state.aRH)}% RH, wet bulb ${dispTs(r.twbF)}${tLabel()}): ` +
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
      shell.syncAllControls(); shell.update(); renderHallEditor();
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
      el.addEventListener(ev, () => { runRateCalc(); shell.update(); });
    }
  });
  runRateCalc(); // once at render time; shell.update() is already in flight above us

}
