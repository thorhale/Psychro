/**
 * Envelope Escape Room — the training-mode simulation engine.
 *
 * A scenario throws a plant fault at a hall (humidifier valve stuck open, a
 * CRAC down in summer heat…) and the trainee commits a recovery target. This
 * engine then plays physics referee: it marches the hall state minute by
 * minute under the disturbance plus the plant's capped response, and scores
 * how much SLA time survived.
 *
 * Everything physical comes from the SAME core the planner uses —
 * `humidityRatioFromPw`/`rhFromW` for state, `specificVolume` for the hall's
 * dry-air mass, the SLA check semantics of `envelopes.js` via the caller —
 * so the game can never disagree with the tool it teaches. The integration
 * itself is deliberately simple (explicit Euler, 1-minute steps): the time
 * constants here are hours, and honesty about model simplicity beats fake
 * fidelity — the header says so and so does the UI.
 *
 * Determinism: scenarios take a seed (mulberry32, same PRNG the test suites
 * use) that jitters the fault magnitude — so a challenge code reproduces the
 * exact same run for two competing trainees.
 */

import { fToC, ft3ToM3, lbToKg } from './units.js';
import { humidityRatio, rhFromW } from './psychro.js';
import { specificVolume } from './psychro.js';

/** Same PRNG as the invariant suites — reproducible from the printed seed. */
export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} TrainerScenario
 * @property {string} id
 * @property {string} title
 * @property {string} brief          what the operator is told
 * @property {{tempF:number, rh:number}} start
 * @property {{dTempFPerHr:number, dWaterLbPerHr:number}} fault base magnitudes
 * @property {number} jitter         ± fraction the seed applies to the fault
 * @property {number} simHours       how long the referee runs
 * @property {number} [faultHours]   how long the fault persists (default: the
 *   whole sim). A wash-down ends; a stuck valve doesn't — and with the
 *   dehumidifier locked out, an ENDLESS water leak makes the dew-point cap
 *   unbeatable at any temperature, which is physics, not game design.
 */

/** @type {TrainerScenario[]} */
export const SCENARIOS = [
  {
    id: 'stuck-humidifier',
    title: 'Stuck humidifier',
    brief:
      'A humidifier valve failed open and is dumping moisture into the hall. RH and dew point are climbing. Commit a recovery target before the dew-point cap is breached.',
    start: { tempF: 72, rh: 52 },
    fault: { dTempFPerHr: 0, dWaterLbPerHr: 80 },
    jitter: 0.2,
    simHours: 4,
  },
  {
    id: 'chiller-down',
    title: 'Chiller down, summer afternoon',
    brief:
      'One chiller tripped and the hall is heating. Warm air holds its moisture, so RH falls while dew point holds — the trap is chasing RH instead of temperature.',
    start: { tempF: 74, rh: 45 },
    fault: { dTempFPerHr: 4.5, dWaterLbPerHr: 0 },
    jitter: 0.2,
    simHours: 4,
  },
  {
    id: 'cold-snap',
    title: 'Economizer cold snap',
    brief:
      'The economizer is pulling in winter air: cold AND dry. Temperature and dew point are both falling — mind the RH floor and the low-temperature edge at once.',
    start: { tempF: 70, rh: 42 },
    fault: { dTempFPerHr: -3.2, dWaterLbPerHr: -25 },
    jitter: 0.15,
    simHours: 4,
  },
  {
    id: 'washdown',
    title: 'Dehumidifier out during wash-down',
    brief:
      'Floor cleaning is evaporating water into the hall and the dehumidifier is tagged out — the crew says 90 more minutes. Only temperature moves are yours. The dew-point cap does not care how warm you run; where DOES it let you go?',
    start: { tempF: 71, rh: 55 },
    fault: { dTempFPerHr: 0, dWaterLbPerHr: 25 },
    jitter: 0.2,
    simHours: 4,
    faultHours: 1.5,
  },
];

/** Apply the seed's jitter to a scenario's fault. Deterministic per seed. */
export function faultForSeed(scenario, seed) {
  const rand = mulberry32(seed);
  const j = (base) => base * (1 + (rand() * 2 - 1) * scenario.jitter);
  return {
    dTempFPerHr: j(scenario.fault.dTempFPerHr),
    dWaterLbPerHr: j(scenario.fault.dWaterLbPerHr),
    // washdown special rule: the dehumidifier is unavailable
    dehumLocked: scenario.id === 'washdown',
  };
}

/**
 * Referee one committed recovery.
 *
 * @param {object} p
 * @param {TrainerScenario} p.scenario
 * @param {number} p.seed
 * @param {{tempF:number, rh:number}|null} p.target the committed target — or
 *   null for "no commitment yet": the plant is NOT fighting the fault, which
 *   is exactly what hesitation costs. This is the game's core lesson.
 * @param {{hallVolFt3:number, rateCoolF:number, rateWarmF:number,
 *          rateDehumLb:number, rateHumLb:number}} p.hall
 * @param {(tempF:number, rh:number) => {ok:boolean, detail?:string}} p.checkSla
 * @param {number} p.pressure kPa
 * @returns {{minutesInSla:number, totalMinutes:number, breachedAtMin:number|null,
 *            breachDetail:string|null, stabilized:boolean, score:number,
 *            trail:{tempF:number, rh:number}[]}}
 */
export function refereeRun(p) {
  const { scenario, seed, target, hall, checkSla, pressure } = p;
  const fault = faultForSeed(scenario, seed);
  const totalMinutes = Math.round(scenario.simHours * 60);

  // Hall dry-air mass for the moisture balance, from the same v the app uses.
  const tc0 = fToC(scenario.start.tempF);
  const w0 = humidityRatio(tc0, scenario.start.rh, pressure);
  const mDa = ft3ToM3(hall.hallVolFt3 || 200000) / specificVolume(tc0, w0, pressure);

  let tempF = scenario.start.tempF;
  let w = w0;
  let minutesInSla = 0;
  let breachedAtMin = null;
  let breachDetail = null;
  const trail = [{ tempF, rh: scenario.start.rh }];

  const faultMinutes = Math.round((scenario.faultHours ?? scenario.simHours) * 60);
  for (let m = 1; m <= totalMinutes; m++) {
    const faultActive = m <= faultMinutes;
    // Plant response toward the committed target, capped by the rates.
    // No commitment (target null) = no fight: the fault runs the hall.
    let dTplant = 0;
    let dWplantKg = 0;
    if (target) {
      const dtWant = target.tempF - tempF;
      const tRate = dtWant > 0 ? (hall.rateWarmF || 0) : (hall.rateCoolF || 0);
      dTplant = Math.sign(dtWant) * Math.min(Math.abs(dtWant) * 60, tRate) / 60;

      const wTarget = humidityRatio(fToC(target.tempF), target.rh, pressure);
      const dwWant = wTarget - w;
      const wRateLb = dwWant > 0 ? (hall.rateHumLb || 0) : fault.dehumLocked ? 0 : (hall.rateDehumLb || 0);
      dWplantKg = Math.sign(dwWant) * Math.min(Math.abs(dwWant) * mDa * 60, lbToKg(wRateLb)) / 60;
    }

    // Disturbance (while it lasts) + plant, explicit Euler over one minute.
    tempF += (faultActive ? fault.dTempFPerHr : 0) / 60 + dTplant;
    w += (faultActive ? lbToKg(fault.dWaterLbPerHr) / mDa : 0) / 60 + dWplantKg / mDa;
    w = Math.max(0, w);

    const rh = Math.min(100, Math.max(0, rhFromW(fToC(tempF), w, pressure)));
    trail.push({ tempF, rh });

    const chk = checkSla(tempF, rh);
    if (chk.ok) minutesInSla++;
    else if (breachedAtMin === null) {
      breachedAtMin = m;
      breachDetail = chk.detail || 'SLA bound crossed';
    }
  }

  // Stabilized: the last half hour stayed in-SLA and barely moved.
  const tail = trail.slice(-30);
  const tSpread = Math.max(...tail.map((s) => s.tempF)) - Math.min(...tail.map((s) => s.tempF));
  const stabilized =
    breachedAtMin === null || (minutesInSla >= totalMinutes - 30 && tSpread < 0.75);
  const inWindow = tail.every((s) => checkSla(s.tempF, s.rh).ok);

  // Score: a point per SLA-minute, a stability bonus worth half an hour.
  const score = minutesInSla + (stabilized && inWindow ? 30 : 0);
  return { minutesInSla, totalMinutes, breachedAtMin, breachDetail, stabilized: stabilized && inWindow, score, trail };
}
