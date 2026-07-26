# Psychrometric accuracy validation

Everything needed to reproduce, re-derive and re-check the psychrometric core in
`../index.html`. The fitted coefficients in that file are not magic numbers —
each one comes out of a script here, and each accuracy claim in the code comments
is a number one of these scripts prints.

Reference standard throughout is **CoolProp 8.0.0** (IAPWS-95 for water, IAPWS-06
for ice, ASHRAE RP-1485 for moist air).

## Layout

| File | What it does |
|---|---|
| `ref2.py` | Generates the CoolProp reference grid → `coolprop_ref2.json` (1,521 moist-air states, 22 saturation points, 867 enhancement-factor points) |
| `fit2.py` | Fits the **enhancement factor** `f(t,p)` and prints its residual |
| `fit3.py` | Fits **dry-air enthalpy**, **vapour enthalpy** and **liquid-water enthalpy** (two-stage) |
| `wb.py` | Compares wet-bulb methods: ASHRAE Eq. 35 vs a full adiabatic-saturation solve; also quantifies psychrometric vs thermodynamic wet bulb |
| `wb2.py` | Wet-bulb error broken down by RH band |
| `audit.mjs` | **The main audit.** Every property vs CoolProp, banded by pressure |
| `envelope.mjs` | Wet-bulb error restricted to the ASHRAE A1–A4 envelope, plus the ice/water branch diagnostic |
| `behaviour.mjs` | Slider semantics: temp holds dew point, ratchet drift, saturation clamp |
| `sensor.mjs` | Sensor Validation card: RH from dry/wet bulb, verdict bands, unit toggle |
| `smoke.mjs` | Self-test, performance, UI stress, NaN scan |
| `coolprop_ref2.json` | The reference data, committed so the JS audits run **without** installing CoolProp |
| `fits2.json`, `fits3.json` | Raw fitted coefficients as emitted, before being pasted into `index.html` |

## Running

The JavaScript audits need only Node and Playwright, and read the committed
reference JSON — no Python or CoolProp required:

```bash
cd validation
npm install
npm run all          # audit + envelope + behaviour + sensor + smoke
```

If Chromium is already on the machine, point at it instead of downloading one:

```bash
CHROMIUM_PATH=/path/to/chrome npm run all
```

Regenerating the reference data or refitting coefficients does need CoolProp:

```bash
pip install CoolProp numpy
python3 ref2.py      # rebuild coolprop_ref2.json
python3 fit2.py      # re-derive ENH_C
python3 fit3.py      # re-derive HDA_C / HV_C / waterEnthalpy
python3 wb.py        # re-check the wet-bulb method choice
```

## Where each coefficient block comes from

| `index.html` | Produced by | Residual vs CoolProp |
|---|---|---|
| `ENH_C` (enhancement factor) | `fit2.py` | 0.007% max ≥55 kPa, 0.010% over 20–130 kPa |
| `HDA_C`, `HV_C` (enthalpy) | `fit3.py` | 0.063 kJ/kg max |
| `waterEnthalpy` cubic | `fit3.py` | 0.020 kJ/kg max |
| `Z_C` (compressibility) | `fit2.py` | 0.012% max |
| `IAPWS_A`, `ICE_A/B` | Published IAPWS constants, not fitted | 0.007% vs full IAPWS-95 |

## Current results

`audit.mjs`, over 65–125 kPa (every real site sits here):

| Property | Before this work | Now |
|---|---|---|
| saturation pressure (water) | 0.0225 % | **0.0071 %** |
| saturation pressure (ice) | 0.0325 % | **exact (IAPWS-06)** |
| humidity ratio `W` | 0.207 % | **0.0041 %** |
| dew point | 0.0175 °C | **0.0012 °C** |
| wet bulb | 0.484 °C | **0.0155 °C** ¹ |
| enthalpy | 0.186 kJ/kg | **0.011 kJ/kg** |
| specific volume | 0.0749 % | **0.0062 %** |
| `W`↔RH round trip | 0.0206 % RH | **exact** |
| enhancement factor `f` | 0.0402 % | **0.0076 %** |

¹ within the ASHRAE A1–A4 allowable envelope (RH ≥ 8%), per `envelope.mjs`.

## Two known, deliberate limits

**Wet bulb near freezing below 8% RH.** ASHRAE Eq. 35 is discontinuous at 0 °C —
the wick freezes and the latent term jumps by the enthalpy of fusion — so the
equation admits a root on each branch. We take the ice root (the ASHRAE
convention); CoolProp sometimes converges on the supercooled-water root. Where
both roots exist the two can differ by ~0.8 °C. That overlap only occurs below
~8% RH, under the floor of every TC 9.9 envelope. `envelope.mjs` prints this
case in full. Whether a real wick freezes or supercools is genuine nucleation
physics, not something either model settles.

**Eq. 35 was kept for wet bulb on purpose.** A full adiabatic-saturation solve
using the fitted real-gas enthalpies was built and measured (`wb.py`); it is
*worse* than Eq. 35 (mean 0.029 °C vs 0.003 °C against CoolProp over the
realistic envelope). Eq. 35 stayed because it measured better and is traceable
to a published equation rather than to a local fit.
