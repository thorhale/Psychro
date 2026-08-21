/**
 * The steady-state ventilation water load, pinned against the hand-derived
 * figures that answered the question it was built for: a 500,000 ft^3 hall at
 * Goodyear with 2,425 CFM of DOAS, held at 73 F.
 */

import { describe, it, expect } from 'vitest';
import { ventilationWater } from '../src/core/ventilation.js';

const GOODYEAR = 97.48; // kPa

describe('ventilationWater', () => {
  it('reproduces the hand calculation at the ceiling', () => {
    // 2,425 CFM at ~14 ft3/lb is ~10,400 lb/hr of dry air; holding 20 % at
    // 73 F is 3.58 g/kg; perfectly dry outdoor air takes all of it.
    const r = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: null, pressureKpa: GOODYEAR });
    expect(r.dryAirLbHr).toBeGreaterThan(10200);
    expect(r.dryAirLbHr).toBeLessThan(10600);
    expect(r.wRoomG).toBeCloseTo(3.58, 1);
    expect(r.lbPerHr).toBeGreaterThan(35);
    expect(r.lbPerHr).toBeLessThan(39);
    expect(r.galPerDay).toBeCloseTo(r.lbPerHr * 24 / 8.3454, 6);
  });

  it('a real design dew point only shaves the ceiling', () => {
    const ceiling = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: null, pressureKpa: GOODYEAR });
    const design = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: -10, pressureKpa: GOODYEAR });
    expect(design.lbPerHr).toBeLessThan(ceiling.lbPerHr);
    expect(ceiling.lbPerHr - design.lbPerHr).toBeLessThan(7); // sub-zero air is nearly empty
    // -10 F is on the ICE branch; W there is ~0.5 g/kg, not garbage.
    expect(design.wOaG).toBeGreaterThan(0.3);
    expect(design.wOaG).toBeLessThan(0.8);
  });

  it('says where the room settles with the humidifiers off', () => {
    const r = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: -10, pressureKpa: GOODYEAR });
    expect(r.settleRH).toBeGreaterThan(1);
    expect(r.settleRH).toBeLessThan(5); // desert-dry: far below any envelope's 8 % floor
  });

  it('scales linearly in flow and refuses non-questions', () => {
    const one = ventilationWater({ cfm: 1000, roomTempF: 73, roomRH: 30, outdoorDpF: 10, pressureKpa: GOODYEAR });
    const two = ventilationWater({ cfm: 2000, roomTempF: 73, roomRH: 30, outdoorDpF: 10, pressureKpa: GOODYEAR });
    expect(two.lbPerHr / one.lbPerHr).toBeCloseTo(2, 9);
    expect(ventilationWater({ cfm: 0, roomTempF: 73, roomRH: 30, outdoorDpF: 10, pressureKpa: GOODYEAR })).toBeNull();
    // Outdoor wetter than the room: humidifiers off, not negative water.
    expect(ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: 60, pressureKpa: GOODYEAR })).toBeNull();
  });

  it('is pressure-aware in both factors, which nearly cancel in the product', () => {
    const denver = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: null, pressureKpa: 83.4 });
    const sea = ventilationWater({ cfm: 2425, roomTempF: 73, roomRH: 20, outdoorDpF: null, pressureKpa: 101.325 });
    // Lower pressure: less dry-air mass per CFM (~p), but a higher W at the
    // same temp and RH (~1/p, since the vapour pressure is fixed by T and RH).
    // Each factor moves by well over 15 % between Denver and sea level...
    expect(denver.dryAirLbHr / sea.dryAirLbHr).toBeLessThan(0.85);
    expect(denver.wRoomG / sea.wRoomG).toBeGreaterThan(1.15);
    // ...and their product cancels to under 0.5 %: water per CFM is nearly
    // pressure-independent. That cancellation is the pin, not an accident.
    expect(Math.abs(denver.lbPerHr - sea.lbPerHr) / sea.lbPerHr).toBeLessThan(0.005);
  });
});
