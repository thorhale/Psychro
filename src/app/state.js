/**
 * Application state — the single mutable object every surface reads from.
 *
 * Its own module because it is what everything else needs. While it lived in
 * main.js, any panel extracted out of main.js had to import back into it, and
 * a cycle between an entry point and the things it starts up is a boot-order
 * bug waiting for a bad day. Panels import state from here; nothing here
 * imports a panel.
 *
 * Mutable on purpose: this is a live document that the DOM, the chart and the
 * persistence layer all read on every update. It is normalized on load by
 * src/state/schema.js and written out by src/state/persistence.js.
 */

import { pressureFromAltitude } from '../core/psychro.js';

export const state = {
  pressure: pressureFromAltitude(1066),
  aTemp: 68, aRH: 45,
  bTemp: 87, bRH: 28,
  showEnvelopes: true,
  // Per-boundary visibility — each can be toggled independently from the legend.
  visible: { Rec:true, A1:true, A2:true, A3:true, A4:true, SLA:true, plan:true, timepts:true, specvol:true, enthalpy:false, actual:false },

  /** Display only — the stored values never change with it.
   *  @type {'F'|'C'|'K'} */
  tempUnit: 'F',

  // ── DATA HALL PROFILES: each is one physical facility — site, elevation,
  //    air volume, installed plant (capabilities + rates), real-world
  //    efficiency factor, and current capacity derates. Every building / hall
  //    gets its own profile; tabs switch between them. Separate from the
  //    customer SLAs below, which are pure contracts evaluated inside the
  //    ACTIVE hall. `state.hall` (defined below) is always the active profile.
  hallProfiles: [{
    // Just "Hall 1". This used to ship as "PHX · Hall 1" — a site code the
    // operator never typed, glued to the name of the only hall they had, in a
    // field where they would then also see PHX offered as a building. It read
    // as a mystery hall in somebody else's building. The site lives in
    // siteName, where the tab strip and the overview can label it themselves.
    name: 'Hall 1',
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
  /**
   * Customer contracts. Typed so an artifact that prints a bound — the door
   * placard, the briefing — is checked against the field actually existing.
   * @type {SlaProfile[]}
   */
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

/**
 * Is this hall inside the current location / building filter?
 *
 * Shared, because the tab strip and the all-halls overview must agree about
 * what "these halls" means. They did not: narrowing to one building left the
 * overview listing every hall on site, so the two surfaces disagreed on the
 * screen at the same time.
 *
 * @param {{siteName?:string, building?:string}} h
 */
export function hallVisible(h) {
  const v = state.hallView;
  if (v.loc && (h.siteName || '').trim() !== v.loc) return false;
  if (v.bld && (h.building || '').trim() !== v.bld) return false;
  return true;
}
