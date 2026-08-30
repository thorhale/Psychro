# Bibliography

Every external authority this project relies on, with a full citation and a
plain statement of **what we actually use it for**. `docs/provenance.md` says
which number rests on which authority; this file says where to find that
authority and how to check us.

Entries marked **[primary]** are load-bearing: a number in the app changes if
the source changes. **[supporting]** entries inform a design choice but do not
feed the arithmetic.

---

## Moist-air thermodynamics

**ASHRAE. (2021). *ASHRAE Handbook — Fundamentals*, Chapter 1: Psychrometrics.
Atlanta: ASHRAE.** **[primary]**
The definitional backbone. We implement Eq. 3 (pressure from altitude), Eq. 5
and Eq. 6 (saturation pressure over water and ice), Eq. 20 (humidity ratio),
Eq. 26 (specific volume), and take the *definitions* — not the closed-form
approximations — of dew point (Eq. 39/40) and thermodynamic wet bulb (Eq. 35).
Where the chapter offers a hand-calculation shortcut and ASHRAE elsewhere
offers a reference formulation, we use the latter; every such departure is
listed in `provenance.md`.

**Herrmann, S., Kretzschmar, H.-J., & Gatley, D. P. (2009). Thermodynamic
properties of real moist air, dry air, steam, water, and ice (RP-1485).
*HVAC&R Research*, 15(5), 961–986. https://doi.org/10.1080/10789669.2009.10390874**
**[primary]**
ASHRAE's own real-gas formulation for moist air, and the basis for the
psychrometric tables in recent Handbook editions. This — not Chapter 1's
perfect-gas forms — is the accuracy target the whole core is graded against.
Validity: 0.01 kPa to 10 MPa, −143.15 to 350 °C.

**Hyland, R. W., & Wexler, A. (1983). Formulations for the thermodynamic
properties of the saturated phases of H₂O from 173.15 K to 473.15 K.
*ASHRAE Transactions*, 89(2A), 500–519.** **[primary]**
The origin of Handbook Eq. 5 and Eq. 6, which we implement verbatim, including
the genuine 9.7e-5 discontinuity where the two meet at 0 °C. A companion paper
in the same volume (pp. 520–535) covers dry and saturated moist air.

**Wagner, W., & Pruß, A. (2002). The IAPWS formulation 1995 for the
thermodynamic properties of ordinary water substance for general and
scientific use. *Journal of Physical and Chemical Reference Data*, 31(2),
387–535. https://doi.org/10.1063/1.1461829** **[primary]**
IAPWS-95, the reference standard for water. It is the yardstick behind our
independent second-source check of the saturation line, and the reason we can
state that ASHRAE Eq. 5 runs 0.013–0.023 % low rather than merely asserting it.

**Bell, I. H., Wronski, J., Quoilin, S., & Lemort, V. (2014). Pure and
pseudo-pure fluid thermophysical property evaluation and the open-source
thermophysical property library CoolProp. *Industrial & Engineering Chemistry
Research*, 53(6), 2498–2508. https://doi.org/10.1021/ie4033999** **[primary]**
The oracle. `HAPropsSI` implements RP-1485; our committed reference grid
(`test/reference/coolprop-reference.json`, 3,898 points, CoolProp 8.0.0) is
generated from it, and every accuracy figure we publish is measured against it.
Its limitation is that it is a *single* oracle — see the next entry.

**Wolfram Research. `ThermodynamicData` — IAPWS property data.** **[primary]**
The independent second source. `LiquidVaporPhaseBoundary` and
`SolidVaporPhaseBoundary` give saturation pressure from an IAPWS
implementation with no CoolProp in the chain, which is the only check in this
repository that could catch a CoolProp error. Twelve points are committed in
`test/reference/wolfram-reference.json` and asserted by
`test/secondsource.test.js`. Also used to verify the CDU's water properties
and, symbolically, its ε–NTU limit.

**Wilke, C. R. (1950). A viscosity equation for gas mixtures. *The Journal of
Chemical Physics*, 18(4), 517–519. https://doi.org/10.1063/1.1747673**
**[primary]**
The mixing rule behind our moist-air viscosity and thermal conductivity — the
only two properties Chapter 1 does not cover at all. Wilke supplies the
composition weighting; the dilute-gas component values and the pressure
closure term on top of it are fitted here (0.0127 % and 0.0190 %).

---

## Data-centre operating envelopes

**ASHRAE Technical Committee 9.9. (2021). *Thermal Guidelines for Data
Processing Environments* (5th ed.). Atlanta: ASHRAE.** **[primary]**
The Recommended and A1–A4 allowable envelopes, transcribed verbatim in SI with
nothing converted or rounded. This is the part of the tool that decides pass or
fail, and it is pure ASHRAE with no interpretation. `test/envelopes.test.js`
fails if any bound moves.

---

## Sensor validation

**Greenspan, L. (1977). Humidity fixed points of binary saturated aqueous
solutions. *Journal of Research of the National Bureau of Standards — A.
Physics and Chemistry*, 81A(1), 89–96.** **[primary]**
The saturated-salt reference humidities, with Greenspan's own per-temperature
uncertainties carried through into our guard-banded verdicts rather than
discarded. Freely available from NIST.

**World Meteorological Organization. *Guide to Instruments and Methods of
Observation* (WMO-No. 8), the CIMO Guide.** **[primary]**
The psychrometer formula used for *instrument* wet-bulb readings. Deliberately
not ASHRAE Eq. 35: a sling psychrometer measures the psychrometric wet bulb,
set by heat and mass transfer at the wick, which is not the thermodynamic wet
bulb Eq. 35 defines. Using the Eq. 35 inverse on an instrument reading biases
RH low by a measured 0.4–0.6 percentage points.

**IAPWS. *Industrial Formulation 1997 for the Thermodynamic Properties of
Water and Steam* (IAPWS-IF97).** **[primary]**
Boiling-point-versus-pressure fixtures for the boiling-water sensor check,
across the full declared 55–110 kPa.

**ISO 14253-1. *Geometrical product specifications (GPS) — Inspection by
measurement of workpieces and measuring equipment — Part 1: Decision rules for
verifying conformity or nonconformity with specifications.*** **[primary]**
The guard-banding decision rule. A verdict must clear tolerance by more than
the reference's own uncertainty, or it reads "too close to call". Without this,
a *worse* reference makes PASS *easier*, which is backwards.

**ILAC-G8. *Guidelines on Decision Rules and Statements of Conformity.***
**[supporting]**
Corroborates the same decision-rule approach.

---

## CDU flow calculator

**Kays, W. M., & London, A. L. (1984). *Compact Heat Exchangers* (3rd ed.).
McGraw-Hill.** **[primary]**
The ε–NTU counterflow effectiveness relation. Its Cr→1 limit (NTU/(1+NTU)),
which the model swaps to below a threshold, was verified symbolically in
Wolfram; the swap costs at most 2.3e-4 in ε.

**Martin, H. (1996). A theoretical approach to predict the performance of
chevron-type plate heat exchangers. *Chemical Engineering and Processing:
Process Intensification*, 35(4), 301–310.
https://doi.org/10.1016/0255-2701(95)04129-X** **[supporting]**
Background for the chevron-plate film correlation `Nu = C·Re^0.7·Pr^(1/3)`.
Our exponent and plate constant are **modelling choices, not standards** — the
CDU README states them plainly, and they are worth whole kelvins where the
property fits are worth thousandths.

---

## Historical lineage

**Goff, J. A., & Gratch, S. (1945).** and **Nelson, H. F., & Sauer, H. J.
(2001).** **[supporting]**
The ASHRAE psychrometric algorithm's earlier generations. Cited by RP-1485 as
what it supersedes; useful when reconciling this tool against an older
calculator that still implements them.

---

## How to check us

- `npm run analyze` regenerates every accuracy figure quoted in
  `provenance.md` against the committed CoolProp grid.
- `npm test` runs the envelope pins, the second-source saturation check, and
  the cross-surface consistency properties.
- `npm run validate:cdu` sweeps the CDU model over three sites and 370,526
  points against its own committed property grids.

Anything this file cannot support, `provenance.md` says so out loud — notably
the aqueous-glycol properties on the CDU side, which rest on CoolProp alone
because no second source was available.
