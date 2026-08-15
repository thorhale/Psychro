# Where every number comes from

One row per quantity: what computes it, whose authority it rests on, and
whether that is ASHRAE verbatim or something else. Written to be handed to
someone who asks "can you defend this number?" — including where the answer is
"not from ASHRAE, and here is why that is the right call."

Re-measure any accuracy figure quoted here with `npm run analyze`; the
tolerances are asserted in `test/psychro.test.js`.

---

## The thing to understand first: ASHRAE publishes two tiers

The Handbook of Fundamentals Chapter 1 gives **perfect-gas relations** — Eq. 20
for humidity ratio, Eq. 26 for specific volume, Eq. 30 for enthalpy, Eq. 35 for
wet bulb, Eq. 39/40 for dew point. They are presented as what they are:
closed forms suitable for hand calculation, each an approximation of an exact
relation stated alongside it.

ASHRAE **also** funded and publishes **RP-1485** (Herrmann, Kretzschmar &
Gatley) — the real-gas formulation for moist air. The psychrometric tables in
recent editions of the Handbook are RP-1485-based. CoolProp's `HAPropsSI`
implements it, which is what this project validates against.

So "strictly ASHRAE" has two possible meanings, and they disagree with each
other by more than this tool's error bars. **This project uses ASHRAE's
definitions, evaluated at RP-1485 accuracy** — not Chapter 1's hand-calculation
shortcuts. Where those two diverge, the shortcut is the one we drop.

---

## Operating envelopes — the numbers that decide pass or fail

| Quantity | Authority | Status |
|---|---|---|
| Recommended, A1–A4 envelopes | **ASHRAE TC 9.9, *Thermal Guidelines for Data Processing Environments*, 5th ed. (2021)** | **Verbatim.** Transcribed in SI, nothing converted. Pinned by `test/envelopes.test.js`, which fails if any bound moves. |
| Class ordering / containment | TC 9.9 | Verbatim; asserted A1 ⊂ A2 ⊂ A3 ⊂ A4. |
| Customer SLA profiles | Your contract | Yours. The shipped examples are exact conversions of the TC 9.9 numbers (15 °C = 59.0 °F, not a rounded 60). |

This is the part that determines whether a hall passes, and it is the part
that is pure ASHRAE with no interpretation.

---

## Core psychrometrics

| Quantity | Basis | Status |
|---|---|---|
| Pressure from altitude | ASHRAE Ch. 1 **Eq. 3** | Verbatim, clamped to its stated validity. |
| Saturation pressure over water / ice | ASHRAE Ch. 1 **Eq. 5 / Eq. 6** (Hyland–Wexler) | Verbatim, including the genuine 9.7e-5 discontinuity at the 0 °C seam. |
| Humidity ratio | ASHRAE Ch. 1 **Eq. 20** | Eq. 20's form, times a fitted enhancement factor — see *Departures* below. |
| Specific volume | ASHRAE Ch. 1 **Eq. 26** | Eq. 26 with a fitted compressibility correction Z(t, W, p). Eq. 26 alone runs 0.14 % high; corrected, 0.012 %. |
| Density | Derived from specific volume | Follows v exactly. |
| **Dew point** | The **definition**: saturation temperature at this air's humidity ratio and pressure, `Ws(tdp, p) = W` | Solved numerically. Ch. 1's Eq. 39/40 *correlation* is retained only as the iteration seed. **3.8e-4 °C** vs RP-1485. |
| **Wet bulb** | The **definition**: ASHRAE's adiabatic-saturation energy balance, `h(t,W) + (W*−W)·h_w(t*) = h(t*,W*)` | Solved numerically. Ch. 1's **Eq. 35 is the closed-form approximation *of this balance*** — we solve the balance itself. **1.6e-3 °C** vs RP-1485. |
| Enthalpy | **ASHRAE RP-1485**, via a fit | Not Eq. 30 — see *Departures*. |
| Entropy | RP-1485 reference convention | Fitted; 3.7e-4 kJ/kg·K. |
| Viscosity, conductivity | Wilke mixing rule, constants fitted to RP-1485 | **Not in Chapter 1 at all.** Engineering-grade: 0.32 % and 0.43 %. |

### On the two solvers that changed

Both moved **toward** ASHRAE's definitions, not away from them. Chapter 1
states the exact relation and then gives a closed form for hand use; we now
solve the exact relation. The only non-ASHRAE ingredient is the *enthalpy*
those balances are evaluated with, and that is RP-1485 rather than Eq. 30.

**The caveat, stated plainly:** if a compliance document requires Eq. 35
implemented literally, our wet bulb will differ from it by up to **0.019 °C**
(measured: Eq. 35 scores 0.01870 °C against RP-1485 over the core domain, this
solver 0.00159) —
because Eq. 35 carries a 0.019 °C error against ASHRAE's own reference
formulation, and we do not reproduce that error. Same story for dew point at
0.023 °C. We are further from the shortcut and closer to the standard.

---

## Deliberate departures, and why

**Enthalpy is not Eq. 30.** `1.006·t + W·(2501 + 1.86·t)` holds the specific
heat of dry air constant (it really runs 1.0057→1.0089 over 0–50 °C),
linearises the vapour term, and drops the pressure-dependent real-gas mixing
term. Measured **0.461 kJ/kg** off RP-1485 over the core operating domain
(0.55 over the wider band the fit was made on). We use
h_da(t,p) + W·h_v(t,W,p) with both parts fitted to RP-1485: **0.030 kJ/kg**. Same reference state as
ASHRAE (h = 0 for dry air at 0 °C), so differences and chart iso-lines are
unaffected.

**The enhancement factor is fitted, not textbook.** It absorbs two things at
once: the real-gas departure Eq. 20 omits, *and* the systematic 1.0–2.2e-4 bias
of Eq. 5/6 against IAPWS-95. That second job is why it is not the textbook
enhancement factor and why it inherits Eq. 5/6's 0 °C discontinuity. It is the
single largest reason humidity ratio lands at 0.0013 % instead of 0.23 %.

**Psychrometer RH is WMO, not ASHRAE — on purpose.** Eq. 35 defines the
*thermodynamic* wet bulb, an adiabatic-saturation property. A sling or
aspirated psychrometer measures the *psychrometric* wet bulb, set by the
heat/mass-transfer balance at the wick. They are not the same temperature.
Feeding an instrument reading through the Eq. 35 inverse biases RH low by a
measured 0.4–0.6 percentage points — a quarter of a ±2 % sensor tolerance, and
systematic, so it does not average out. The sensor card uses the **WMO CIMO
Guide** psychrometer formula for instrument readings and keeps the ASHRAE
inverse for thermodynamic work. Both are offered, labelled.

---

## Sensor-validation references

| Method | Authority | Status |
|---|---|---|
| Saturated-salt fixed points | **Greenspan 1977** (NBS/NIST), *Humidity Fixed Points of Binary Saturated Aqueous Solutions* | Verbatim polynomials, with Greenspan's own per-temperature uncertainties carried through. |
| Ice point | Definition (0.00 °C) | — |
| Boiling point vs pressure | ASHRAE Eq. 5 inverted by Newton | Pinned against **IAPWS-IF97** across 55–110 kPa. |
| Psychrometer | WMO CIMO Guide | See above. |
| Pass / marginal / fail bands | **ISO 14253-1** / ILAC-G8 guard-banding | A verdict must clear tolerance by more than the reference's own uncertainty, or it reads "too close to call". |

---

## What this means in practice

For anything a data-hall SLA turns on — temperature, humidity, dew point,
the ASHRAE class badge — the numbers rest on TC 9.9 verbatim and on ASHRAE's
own reference formulation, and are accurate to roughly a thousandth of a degree.

The places we leave Chapter 1 are places where Chapter 1 offers a
hand-calculation shortcut and ASHRAE elsewhere offers something better. Every
one of them is listed above, with its measured effect.
