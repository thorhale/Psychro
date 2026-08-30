/**
 * The saturation line, checked against a source that is not CoolProp.
 *
 * Every other reference in this repo — the 3,898-point moist-air grid, the CDU
 * property grids — traces back to CoolProp. That is a single point of failure
 * for the whole tool: if CoolProp's moist-air model were wrong, nothing here
 * would notice, because everything is graded against it.
 *
 * Wolfram's ThermodynamicData implements the IAPWS formulations directly, with
 * no CoolProp in the chain. These points are the independent check.
 *
 * What they establish, and why it matters:
 *
 *   ASHRAE Ch.1 Eq. 5 (saturation over water) runs a systematic 0.013–0.023 %
 *   LOW against IAPWS. docs/provenance.md has claimed that number for a long
 *   time as the reason the enhancement factor is fitted rather than textbook —
 *   the fit absorbs this bias along with the real-gas departure. Until now that
 *   claim rested on the same CoolProp everything else did. It does not any more.
 *
 *   Eq. 6 (saturation over ice) agrees with IAPWS to 5e-4 % from −20 to −5 °C,
 *   so the bias is a WATER-branch effect, not a property of both equations.
 *   The ice branch is what the ventilation-water math uses below freezing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { satPressure } from '../src/core/psychro.js';

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, 'reference', 'wolfram-reference.json'), 'utf8'));

/** Our saturation pressure at t, in Pa, vs the reference — as a percentage. */
const devPct = (tC, pPa) => (100 * (satPressure(tC) * 1000 - pPa)) / pPa;

describe('saturation line vs an independent (non-CoolProp) source', () => {
  it('reproduces the documented Eq. 5 bias against IAPWS over water', () => {
    // Not a loose bound: every point must sit inside the band provenance.md
    // quotes, and the band is only 0.010 % wide. A refit that moved the
    // saturation line would fall straight out of it.
    for (const { tC, pPa } of ref.water) {
      const d = devPct(tC, pPa);
      expect(d, `Eq.5 at ${tC} °C`).toBeLessThan(-0.012);
      expect(d, `Eq.5 at ${tC} °C`).toBeGreaterThan(-0.024);
    }
  });

  it('shows the bias is largest mid-range and shrinks at both ends', () => {
    // The shape matters as much as the magnitude: a fit that accidentally
    // introduced a slope would keep the endpoints and break this.
    const at = (t) => Math.abs(devPct(t, ref.water.find((w) => w.tC === t).pPa));
    expect(at(25)).toBeGreaterThan(at(10));
    expect(at(25)).toBeGreaterThan(at(60));
  });

  it('is essentially exact over ice where the app actually uses it', () => {
    // −20…−5 °C is the band a design-day outdoor dew point lands in, which is
    // what src/core/ventilation.js reads when it converts one to a humidity
    // ratio. Five ten-thousandths of a percent is nothing.
    for (const { tC, pPa } of ref.ice.filter((r) => r.tC >= -20)) {
      expect(Math.abs(devPct(tC, pPa)), `Eq.6 at ${tC} °C`).toBeLessThan(5e-4);
    }
  });

  it('degrades gracefully, not silently, at the cold end of the ice branch', () => {
    // −40 °C is outside anything this tool plans for, but the error there
    // (0.031 %) is worth pinning so nobody mistakes the ice branch for exact
    // everywhere. It is exact where we use it, and this says where that stops.
    expect(Math.abs(devPct(-40, ref.ice[0].pPa))).toBeLessThan(0.04);
    expect(Math.abs(devPct(-40, ref.ice[0].pPa))).toBeGreaterThan(0.02);
  });
});
