# Psychro vs. CoolProp — comparison and validation report

**TL;DR:** CoolProp is a properties *library*; this tool is an *operations
planner* whose property core is now validated against CoolProp point-by-point in
CI. We deliberately do **not** ship CoolProp's WASM build — it is the wrong shape
for an offline-first phone app redrawing a chart at 60 fps — and instead use it
as the accuracy oracle that pins our hand-coded ASHRAE core. Worst-case humidity
ratio deviation across the entire operating envelope: **0.0013 %**.

All numbers below are generated, not asserted: `npm run analyze` re-measures them
from the committed CoolProp 8.0.0 reference grid (5,208 points; 3,898 inside the
declared operating domain), and `npm test` fails if any property drifts past its
documented tolerance.

---

## 1. What each thing is

| | **CoolProp HAPropsSI** | **Psychro (this app)** |
|---|---|---|
| Kind | Open-source thermophysical property library (C++, wrappers for Python/JS/…) | Installable offline PWA for planning data-hall temperature/humidity moves |
| Humid-air model | ASHRAE RP-1485 (Herrmann, Kretzschmar & Gatley 2009): real-gas virial formulation with Henry's-law air solubility | ASHRAE Fundamentals Ch. 1 correlations + a CoolProp-fitted enhancement factor (details in §3) |
| Validity range | −143…350 °C, 0.01 kPa…10 MPa, W ≤ 10 kg/kg | Declared, guard-railed band: −20…55 °C, 60…108 kPa, W ≤ 0.15 kg/kg — the physically reachable envelope of a data hall at any campus elevation |
| Properties | 24 (T, R, B, D, H, S, V, W, μ, k, Z, molar forms, …) | 15 (p_ws, p_w, W, μ_saturation degree, T_dp, T_wb, h, s, v, ρ, absolute humidity, RH, μ, k, + inverse solves) |
| Input pairs | Any thermodynamically valid triple | T + RH, T + T_dp, T + T_wb, T + W, T + h (the pairs an operator actually has) |
| Footprint | ~MB-scale WASM, async init | ~51 KB gzipped for the whole app, instant start, fully offline |
| Chart, TC 9.9 envelopes, SLA compliance, ramp planning, plant capacity model, site catalog, scenarios, PDF/PNG export | none — out of scope | the actual product |

The two aren't competitors. CoolProp answers "what are the properties of moist
air at this state?" with reference-grade accuracy over an enormous range. This
tool answers "can I take Hall 2 from 68 °F/45 % to 87 °F/28 % inside the
customer's SLA, and how long will it take with one chiller derated?" — and needs
property math that is *fast, offline, and provably right in its range* to do it.

## 2. Why not just embed CoolProp?

Considered and rejected, for reasons that are architectural rather than
accuracy-based:

- **Hot path shape.** One chart redraw evaluates thousands of property points
  (envelope polygons at site pressure, RH curves, wet-bulb and specific-volume
  iso-lines, hover inspection). HAPropsSI solves a real-gas formulation
  iteratively per call; the hand-coded correlations are one-shot arithmetic.
- **Offline-first weight.** The whole app is ~51 KB gzipped and boots instantly
  from a service-worker cache on a phone with no signal. CoolProp's JS/WASM build
  is megabytes and initializes asynchronously.
- **The accuracy delta doesn't matter — once it's measured.** Inside a data
  hall's envelope the corrected Ch. 1 correlations agree with RP-1485 to ~1 part
  in 10⁵ on humidity ratio (table below). The gap that *did* matter was that v1
  never measured it — and was silently wrong in places (§3).

So the architecture is: **hand-coded core in the app, CoolProp as the oracle in
CI.** `test/reference/generate_reference.py` sweeps a T×RH×p grid through
HAPropsSI and commits the result; `test/psychro.test.js` asserts every property
at every in-domain grid point on every push.

## 3. What the comparison exercise found (and fixed)

Measuring v1 against CoolProp surfaced three real defects — all shipped, all
invisible to its 26-case self-test:

1. **Silent extrapolation of the enhancement factor.** v1's real-gas correction
   was fitted over 0–50 °C / 65–102 kPa, but the chart reaches 54 °C and the
   elevation input reaches ~22 kPa. Worst in-domain humidity-ratio error: 0.23 %.
   *Fix:* refit over the full reachable domain, as two polynomials — one per
   saturation branch, because ASHRAE Eq. 5 (water) and Eq. 6 (ice) disagree by
   9.7×10⁻⁵ at 0 °C and a single smooth fit can't cross that step. Also fixed the
   evaluation temperature: v1 evaluated f at the *dew point* of the vapour
   pressure instead of the dry bulb (correct only at saturation). Result:
   0.23 % → **0.0013 %**.
2. **Dew point by correlation, not inversion.** v1 used the ASHRAE Eq. 39/40
   curve fit — up to **3.2 °C** off at the cold/dry corner, and dew point is what
   SLA dew-point caps are tested against. *Fix:* Newton inversion of the actual
   saturation equation (analytic derivative, branch-pinned so it can't straddle
   the 0 °C seam), seeded by the old correlation. Result: 3.2 °C → **0.023 °C**.
3. **A wet-bulb solver that converged onto a discontinuity.** ASHRAE Eq. 35 has
   an over-water and an over-ice form that disagree at t_wb = 0 °C. v1 bisected
   blindly across the seam; when the true wet bulb sat just below freezing the
   solver "converged" onto the jump and reported a value up to **0.68 °C** wrong,
   with no warning. (This is the band CoolProp's docs warn about near the triple
   point.) *Fix:* solve each branch strictly in its own domain. Near freezing
   both wick states (ice vs. supercooled water) can be genuinely self-consistent
   — real psychrometry, not a bug — so the solver returns the ice root (matches
   CoolProp on 18 of the 22 ambiguous grid points; the stable wick state below
   freezing is ice) **and sets an `ambiguous` flag** that the UI surfaces.
   v1 also used only the over-water form, so `wetBulb()` and its own inverse
   `rhFromWetBulb()` disagreed below freezing; they now round-trip to 5×10⁻⁹ %.

Two property families were added to narrow the CoolProp gap: **entropy** (ideal-
gas mixture form on CoolProp's reference convention) and **transport properties**
(viscosity, thermal conductivity — Sutherland correlations per component, Wilke
mixing rule, constants fitted to CoolProp because the textbook water-vapour
constants left mixture viscosity 17 % low at high humidity). Plus mixture
density, degree of saturation, and the inverse solves the UI needed.

## 4. Measured agreement with CoolProp 8.0.0

Over all 3,898 reference points inside the declared operating domain
(−20…55 °C, 60…108 kPa, W ≤ 0.15 kg/kg). Regenerate anytime with `npm run analyze`.

```
property             unit          max abs     RMS abs    max rel              worst point
------------------------------------------------------------------------------------------
humidity ratio W     g/kg         6.861e-4    5.647e-5    0.0013%         55°C 95% 79.5kPa
enthalpy h           kJ/kg        3.005e-2    2.156e-3          —         55°C 100% 108kPa
specific volume v    m³/kg        1.678e-4    1.973e-5    0.0114%          50°C 100% 65kPa
density ρ            kg/m³        9.782e-5    1.470e-5    0.0114%         55°C 100% 95kPa
dew point Tdp        °C           3.816e-4    4.084e-5          —           10°C 50% 65kPa
wet bulb Twb         °C           1.588e-3    4.787e-4          —            55°C 1% 65kPa
                     over 3876 of 3898 points
  └ ice/water band   °C           8.483e-1    2.497e-1          —            15°C 1% 65kPa
                     over 22 of 3898 points — double-valued: both wick states are physical
entropy s            kJ/kg·K      3.747e-4    1.188e-4          —         55°C 100% 108kPa
viscosity μ          µPa·s        5.989e-2    3.299e-2    0.3185%         45°C 100% 108kPa
conductivity k       mW/m·K       1.199e-1    5.716e-2    0.4301%       52.5°C 100% 108kPa
```

Reading notes:

- **Dew point** solves its actual definition — the temperature at which this
  air, held at constant humidity ratio and pressure, saturates: `Ws(tdp, p) =
  W`. It used to invert the saturation curve alone, `dewPoint(pw(t, rh))`,
  which drops the enhancement factor. The factor does not cancel here because
  it would be evaluated at two different temperatures (dry bulb on one side,
  dew point on the other), so the omission was worth **2.285e-2 °C**; solving
  the real definition brings it to **3.816e-4 °C**, a factor of sixty. The old
  form survives as the seed — it is within 0.03 °C everywhere, so a ±1 °C
  bracket around it holds the root and forty bisections reach machine
  precision.
- Because a dew point is a property of the air rather than of the contract, an
  SLA's dew-point cap is now graded at the hall's own pressure. The temperature
  and RH bounds are pure contract terms and stay pressure-free, so only a
  capped profile is pressure-sensitive at all, and only by hundredths of a
  degree. The envelope's dew-point EDGE is drawn as the saturation humidity
  ratio at the cap, which is the same quantity `dewPointFrom` inverts — so the
  drawn boundary and the graded verdict are now the same curve by construction
  rather than by a cancellation that happened to work out.
- **Wet bulb** is no longer solved by ASHRAE Eq. 35. Eq. 35 is the closed-form
  solution of the adiabatic-saturation balance *with ideal-gas enthalpies* —
  constant c_p for dry air, a linearised vapour term, no pressure-dependent
  mixing. Since this file already carries an `enthalpy` fitted to RP-1485, the
  balance h(t,W) + (W\*−W)·h_w(t\*) = h(t\*,W\*) is now solved numerically with
  the real thing. Max error **0.0187 °C → 0.0016 °C**, RMS 4.8e-4 — a factor of
  twelve, for one extra bisection per call.
- The 0.85 °C on the second row is **not an accuracy figure.** Within about
  ±0.6 °C of freezing the balance has two self-consistent roots — an ice-covered
  wick and a supercooled-water wick — and both are real psychrometry: two
  instruments in the same air, one frosted and one not, read differently. This
  solver computes *both* to **4e-4 °C**, returns the ice root (the stable phase
  below freezing) and sets `ambiguous`; `wetBulbRoots()` hands back the other.
  CoolProp's iterative solver lands in whichever basin its initial guess falls
  into, agreeing with the ice root 18 times in 22 with no discernible rule, so
  the row measures a difference of convention, not of precision. It is reported
  separately rather than averaged into the headline for exactly that reason.
- **Enthalpy** no longer uses Ch. 1 Eq. 30's constant specific heats
  (1.006 / 1.86 kJ·kg⁻¹·K⁻¹), whose difference from RP-1485's temperature-
  dependent ones dominated the old 0.46 kJ/kg error. It is now h_da(t, p) +
  W·h_v(t, W, p) with both parts fitted to RP-1485 directly, pressure term
  included — max residual 0.030 kJ/kg, a 15× improvement. (An earlier revision
  of this table reported 0.44 kJ/kg for the same code: the *analyzer* was
  calling `enthalpy` without the pressure argument, measuring every altitude
  point against its sea-level value. The oracle suite in `test/psychro.test.js`
  always passed pressure and always knew the true figure.)
- **Specific volume** carries a compressibility factor Z(t, p, W) fitted to
  RP-1485 rather than assuming Z = 1. Real moist air is ~0.06 % denser than an
  ideal mixture at 1 atm, and that was the entire former deviation: max relative
  error drops from 0.1125 % to 0.0114 %, a factor of ten. **Density** is derived
  from v, so it improves identically — the two rows agreeing to the fourth digit
  is itself the check that ρ = (1 + W)/v still holds exactly.
- Transport properties are engineering estimates by construction (ASHRAE Ch. 1
  doesn't define them); 0.3–0.4 % is ample for pressure-drop and coil work.
- Relative error is only shown for strictly-positive properties; it is
  meaningless for quantities that cross zero.

Spot check, end-to-end through the built app (sensor validation, 75 °F dry bulb /
62 °F wet bulb at the Goodyear AZ site, 1,066 ft → 97.4821 kPa):

| | RH | dew point | W |
|---|---|---|---|
| App — **thermodynamic** wet bulb | 48.7 % | 54.4 °F | 9.40 g/kg |
| CoolProp `HAPropsSI` | 48.70 % | 54.4 °F | 9.39 g/kg |
| App — **psychrometer** wet bulb (default) | 48.2 % | 54.1 °F | 9.30 g/kg |

The card's default is the psychrometer formula, because that is what a sling or
aspirated psychrometer physically reads: a wet wick exchanges heat with its
surroundings by radiation and imperfect convection, so it settles slightly above
the thermodynamic wet bulb. CoolProp only offers the thermodynamic definition,
so only the first row is a comparison — the third is a different quantity, not a
disagreement. The 0.5 % RH gap between them is small enough to be mistaken for
rounding and large enough to fail a calibration audit, which is why the card
makes you choose and `test/e2e/app.spec.js` pins both numbers.

## 5. What this tool has that CoolProp doesn't

The property core is the commodity; the domain layer is the product:

- **TC 9.9 envelopes as real constraint polygons** (RH curve vs. dew-point cap,
  whichever binds first), recomputed at site pressure — not static overlay art.
- **Customer SLA engine**: envelope + ramp-rate contracts, per-point compliance
  with the specific violated bound named.
- **Plant capacity model**: per-hall cooling/warming/dehum/humidify rates,
  efficiency factor calibrated from logged predicted-vs-actual runs, per-lever
  derates for today's degraded plant.
- **First-principles moisture mass balance** for move-time estimates (hall air
  mass × ΔW ÷ equipment lb/hr), direction-aware, with the passive
  ride-the-temperature component correctly excluded.
- **Site catalog with barometric pressure** from elevation (Eq. 3) — the reason
  a 45 % RH reading means different absolute moisture in Denver than in Houston.
- **Sensor validation** (sling-psychrometer inverse solve with pass/marginal/fail
  grading), scenarios, save-file sharing, PNG/PDF export, offline PWA install.

## 6. Validity guard rails

`src/core/domain.js` declares the validated band; the chart shows a warning chip
whenever either state point leaves it (calculations still run — an operator
planning an excursion needs numbers, not a refusal, but they're labelled). The
same declaration is embedded in the reference grid, and a CI test asserts the two
stay in sync, so the guard can't silently drift from what is actually validated.

## 7. Reproducing everything

```bash
pip install CoolProp
npm run reference        # regenerate test/reference/coolprop-reference.json
npm test                 # 52 tests incl. per-point oracle assertions
npm run analyze          # the table in §4
npm run fit:enhancement  # re-derive enhancement-factor coefficients
npm run fit:secondary    # re-derive entropy offsets + transport constants
```

### References

- ASHRAE Handbook — Fundamentals, Chapter 1 "Psychrometrics" (equation numbers cited in `src/core/psychro.js`)
- Herrmann, S., Kretzschmar, H.-J., Gatley, D.P. (2009). *Thermodynamic Properties of Real Moist Air, Dry Air, Steam, Water, and Ice* (ASHRAE RP-1485)
- Bell, I.H. et al. (2014). "Pure and Pseudo-pure Fluid Thermophysical Property Evaluation and the Open-Source Thermophysical Property Library CoolProp", *Ind. Eng. Chem. Res.* 53(6) — [coolprop.org](https://coolprop.org/fluid_properties/HumidAir.html)
