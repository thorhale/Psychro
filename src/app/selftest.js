/**
 * In-app validation self-test — runs on load, renders the badge + panel.
 *
 * This is the trust surface an operator sees. CI runs the FULL 3,898-point
 * CoolProp oracle (`test/psychro.test.js`); this on-device subset re-derives a
 * representative sample live from the shipped code, so what the badge asserts is
 * exactly what this build computes — not what some other build computed in CI.
 *
 * Tolerances tightened from v1 where the v2 core earned it: dew point is now a
 * Newton inversion (±0.02 °C here, was ±0.12), wet bulb ±0.02 °C (was ±0.1).
 */

import {
  pressureFromAltitude,
  satPressure,
  humidityRatio,
  saturationHumidityRatio,
  dewPoint,
  dewPointFrom,
  enthalpy,
  specificVolume,
  entropy,
  moistAirDensity,
  wetBulb,
  wetBulbSolve,
  rhFromWetBulb,
} from '../core/psychro.js';

export function runSelfTest() {
  const cases = [];
  const T = (name, got, ref, tol, unit = '') =>
    cases.push({ name, got, ref, tol, unit, pass: Math.abs(got - ref) <= tol });
  const p0 = 101.325;

  // 1. Saturation pressure (kPa) — ASHRAE Eq. 5/6 vs Fundamentals Table 2
  T('p_ws(0°C)', satPressure(0), 0.6112, 0.001, 'kPa');
  T('p_ws(10°C)', satPressure(10), 1.228, 0.002, 'kPa');
  T('p_ws(20°C)', satPressure(20), 2.3388, 0.003, 'kPa');
  T('p_ws(25°C)', satPressure(25), 3.1692, 0.003, 'kPa');
  T('p_ws(40°C)', satPressure(40), 7.3835, 0.006, 'kPa');
  T('p_ws(-10°C ice)', satPressure(-10), 0.2599, 0.001, 'kPa');

  // 2. Pressure vs altitude (kPa) — ASHRAE Eq. 3 vs Table 1
  T('p(0 m)', pressureFromAltitude(0), 101.325, 0.01, 'kPa');
  T('p(1000 m)', pressureFromAltitude(3280.84), 89.875, 0.05, 'kPa');
  T('p(2000 m)', pressureFromAltitude(6561.68), 79.495, 0.05, 'kPa');

  // 3. Humidity ratio (g/kg) at saturation — CoolProp RP-1485 real-gas values
  T('Ws(20°C,sat)', saturationHumidityRatio(20, p0) * 1000, 14.76, 0.02, 'g/kg');
  T('Ws(25°C,sat)', saturationHumidityRatio(25, p0) * 1000, 20.173, 0.02, 'g/kg');
  T('Ws(30°C,sat)', saturationHumidityRatio(30, p0) * 1000, 27.333, 0.03, 'g/kg');

  // 4. Dew point (°C) — Newton inversion of Eq. 5/6; CoolProp cross-check
  T('dp(25°C,50%)', dewPointFrom(25, 50), 13.87, 0.02, '°C');
  T('dp(30°C,60%)', dewPointFrom(30, 60), 21.39, 0.02, '°C');
  T('dp(20°C,sat)=20', dewPoint(satPressure(20)), 20.0, 0.001, '°C');
  T('dp(-15°C,sat)=-15', dewPoint(satPressure(-15)), -15.0, 0.001, '°C');

  // 5. Enthalpy (kJ/kg) — ASHRAE Eq. 30 (CoolProp Hda ≈ 50.423)
  const W25_50 = humidityRatio(25, 50, p0);
  T('h(25°C,50%)', enthalpy(25, W25_50), 50.42, 0.1, 'kJ/kg');

  // 6. Specific volume (m³/kg) — ASHRAE Eq. 26 — and mixture density
  T('v(25°C,50%)', specificVolume(25, W25_50, p0), 0.858, 0.001, 'm³/kg');
  T('v(20°C,dry)', specificVolume(20, 0, p0), 0.8305, 0.001, 'm³/kg');
  T('ρ(25°C,50%)', moistAirDensity(25, 50, p0), 1.1770, 0.002, 'kg/m³');

  // 7. Wet bulb (°C) — branch-aware Eq. 35 solve vs CoolProp
  T('twb(25°C,50%)', wetBulb(25, 50, p0), 17.88, 0.02, '°C');
  T('twb(30°C,40%)', wetBulb(30, 40, p0), 20.06, 0.02, '°C');
  T('twb(35°C,50%)', wetBulb(35, 50, p0), 26.14, 0.02, '°C');

  // 8. Entropy (kJ/kg·K) — vs CoolProp Sda
  T('s(25°C,50%)', entropy(25, 50, p0), 0.18076, 0.001, 'kJ/kg·K');

  // 9. RH from dry bulb + wet bulb (inverse Eq. 35) — must round-trip wetBulb()
  T('rh(25°C, twb@50%)', rhFromWetBulb(25, wetBulb(25, 50, p0), p0), 50, 0.001, '%');
  T('rh(30°C, twb@40%)', rhFromWetBulb(30, wetBulb(30, 40, p0), p0), 40, 0.001, '%');
  T('rh @85 kPa round-trip', rhFromWetBulb(20, wetBulb(20, 60, 85), 85), 60, 0.001, '%');
  T('rh(-5°C ice branch)', rhFromWetBulb(-5, wetBulb(-5, 40, p0), p0), 40, 0.001, '%');
  T('rh(twb=tdb) = sat', rhFromWetBulb(25, 25, p0), 100, 0.01, '%');

  // 10. Solver honesty: the near-freezing ambiguity is flagged, not hidden
  const amb = wetBulbSolve(7.5, 25, 79.5);
  cases.push({
    name: 'near-freezing Twb flagged ambiguous',
    got: amb.ambiguous ? 1 : 0,
    ref: 1,
    tol: 0,
    unit: '',
    pass: amb.ambiguous === true,
  });

  const passed = cases.filter((c) => c.pass).length;
  const failed = cases.length - passed;
  return { passed, total: cases.length, failed, cases };
}
