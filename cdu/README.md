# cdu-sim

An interactive steady-state model of a **500 kW direct-to-chip Coolant Distribution
Unit** — a PG25 glycol server loop rejecting heat to a facility chilled-water loop
through a counterflow plate heat exchanger.

Open `index.html`. That's the whole application: one file, no build step, no server,
and **no external requests** — it runs offline from a local disk or any static host.

## What it's for

It answers one question that is easy to get backwards:

> *Should I run the glycol loop faster and the chilled water slower to cool the chips harder?*

**Half of that is right.** Running the glycol faster does help — it shrinks the rack
ΔT, so the hottest die runs closer to the coolant supply temperature.

**The other half is backwards.** At steady state the heat crossing the plates is
*exactly* the IT load, no matter what the pumps do — slowing the facility loop cannot
remove more heat. What it does is lower the exchanger's overall conductance
`G = εC_min`, so the entire glycol loop must float hotter to push the same load
across. Slowing the chilled water makes the chips **hotter**, not cooler.

Click through the three presets to see it:

| preset | hottest die | facility ΔT | pump power |
| --- | --- | --- | --- |
| Design point | 45.7 °C | 10.0 K | ×1.00 |
| Fast glycol · slow water | **54.7 °C** (+9.0 K) | 20.0 K | ×1.85 |
| Tuned | 50.7 °C (+5.0 K) | 16.0 K | ×1.03 |

So the move is real, but it is an **energy** play, not a **cooling** play: the +10 K
facility return is worth genuine chiller efficiency, and you pay for it in die
temperature. "Tuned" is the compromise — it clears the plant target for +5 K of die
temperature and essentially no extra pumping.

There is also a trap the page makes visible: **effectiveness ε climbs toward 100%
exactly when you starve the facility loop and the chips are at their hottest.** ε is
the wrong number to optimise. `G = εC_min` is the one that governs cooling.

## The model

- Counterflow **ε–NTU**, solved for temperature rather than duty: the secondary loop
  floats to whatever temperature it needs in order to reject the load.
- Fluid properties from **CoolProp** — `INCOMP::MPG-25%` for the glycol loop and
  `Water` for the facility loop, as polynomial fits over 5–65 °C (max error
  **2.7e-4 %**, pinned in CI against a committed CoolProp grid; the water side is
  additionally cross-checked against Wolfram's IAPWS data to 0.03 %).
  The two loops are *not* interchangeable: at equal flow the glycol-side film
  coefficient is ~35% lower and it costs ~20% more pumping.
- Plate-pack film coefficients from a chevron-plate correlation,
  `Nu = C·Re^0.7·Pr^(1/3)`, in series with a fixed wall-and-fouling resistance, so UA
  saturates at high flow instead of growing without bound.
- The **hottest die sits at the rack outlet**, not at the mean coolant temperature —
  using the mean understates the worst device by half the rack ΔT.
- Facility supply 18 °C, an **ASHRAE W27**-class facility loop.
- Geometry anchored to a **3 K design approach**, the figure CDU vendors publish.

### Assumptions that are mine, not a standard

Stated plainly because the page is only as good as these:

- The **8 K rack / 12 K facility ΔT figures are site targets**, not standards. Change
  `RACK_DT_MAX` / `FAC_DT_MIN` to match your spec.
- **360 devices at 0.012 K/W** cold-plate resistance sets the die-above-coolant rise.
- Pump power uses the affinity law (`∝ flow³`) with a glycol viscosity penalty; it
  ignores pump and motor efficiency curves.
- A **dew-point floor is not modelled.** Real CDUs hold the secondary supply above the
  room dew point to stay 100% sensible. Nothing here stops you dialling in a supply
  temperature that would sweat.

## Validation

```
node tools/validate.mjs
```

Sweeps 124,488 operating points across the full control envelope and asserts:

- effectiveness stays strictly inside (0, 1) — it is asymptotic and never reaches 1
- no temperature crossing at either terminal
- energy balance closes (residual < 1e-6 W; observed 5.8e-10 W)
- heat across the plates equals the IT load at *every* flow setting
- conductance rises, and the hottest die falls, with **either** flow — the result that
  refutes the "slow the chilled water" claim
- the constants in `index.html` match `tools/model.mjs`, so the shipped page and the
  test core cannot drift apart

Exits non-zero on failure, so it can be wired straight into CI.

`tools/cdu_reference.py` is the CoolProp reference implementation. It regenerates the
property fits and the geometry anchor, and is what the JavaScript was checked against
(agreement within 0.003 K). It needs `pip install CoolProp`.

## Layout

```
index.html              the application — standalone, offline, no dependencies
tools/model.mjs         numeric core, mirrored from the page for testing
tools/validate.mjs      invariant sweep + drift check
tools/cdu_reference.py  CoolProp reference model and property-fit generator
```
