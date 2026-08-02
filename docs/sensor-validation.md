# Sensor validation methods — references and uncertainties

The app's Sensor Validation card offers six ways to check a temperature or RH
sensor against an **independent physical reference**. This page records what
each method's reference actually is, how good it is, and when to reach for it.

Verdicts are **guard-banded** (the ISO 14253-1 decision rule): to claim PASS,
the sensor's error must be inside its tolerance *by more than the reference's
own uncertainty* — otherwise the reference itself could be why the number
looks good. Concretely, with tolerance `tol` and reference uncertainty `u`:

- **PASS** — |error| ≤ tol − u (confidently in spec)
- **TOO CLOSE TO CALL** — |error| within ±u of the tolerance limit: the
  reference isn't accurate enough to decide. Repeat the check with a tighter
  reference (a salt jar or ice bath instead of a field instrument).
- **MARGINAL** — confidently past the tolerance, up to the recalibrate band
  widened by `u` (recalibrate + `u`)
- **FAIL** — |error| > recalibrate band + u (confidently out, even granting
  the reference its full uncertainty)

A worse reference therefore makes *every confident verdict harder* to earn —
which is what uncertainty means. (An earlier release widened the PASS band by
`u` instead, which let a sloppier reference pass more sensors; that was
backwards, and this rule replaces it.)

Tolerances: RH ±2 % (recalibrate at ±5 %) — typical capacitive-sensor spec;
temperature ±0.9 °F / 0.5 °C (recalibrate at ±1.8 °F / 1 °C).

**Per-sensor specs override these defaults.** Register a sensor in the logbook
with its own datasheet tolerance and every verdict for that sensor is graded
against *its* number instead — a ±3 %RH hall transmitter stops being failed
for meeting its own spec. The recalibrate band is then derived from the spec
the same way the defaults relate (×2.5 for RH, ×2 for temperature). One
consequence: the note below is true at the ±0.9 °F default, but a sensor
registered at a looser spec can pass a boiling check.

The boiling-point method's practical
uncertainty (±0.9 °F) equals the temperature tolerance, so it can never issue
a confident PASS — it is a *gross-error* check, good for catching a sensor
that is degrees off, not tenths. The ice bath (±0.1 °F) is the method that
can actually certify a PASS.

## 1. Psychrometer (dry-bulb + wet-bulb) — RH

**Reference:** a sling or aspirated psychrometer you operate on the spot.
**Physics:** WMO CIMO psychrometer formula (what the instrument reads) or
ASHRAE Eq. 35 thermodynamic wet bulb (a chart property) — selectable, because
the two differ by ~0.5 %RH *systematically*.
**Uncertainty used:** ±0.5 %RH (the spread between the two definitions —
technique errors add to this).
**Use when:** you have a psychrometer and airflow ≥3 m/s over a wet wick.
Fast, cheap, mid-range accuracy.

## 2. Dew-point instrument — RH

**Reference:** a chilled-mirror or equivalent dew-point meter.
**Physics:** RH follows from T_db and T_dp alone (ratio of saturation
pressures — pressure-independent). Uses the same Newton-inverted
Hyland–Wexler curve the whole app runs on.
**Uncertainty used:** ±1.0 %RH (a maintained chilled mirror is ±0.2 °C dew
point, ≈ ±1 %RH at hall conditions).
**Use when:** the site owns a dew-point instrument — this is the
reference-grade option.

## 3. Saturated-salt chamber — RH

**The gold standard of practical RH calibration — and it's worth being clear
about why.** A saturated-salt jar is an *absolute* reference: the equilibrium
humidity over the slurry is set by physical chemistry, not by a factory
calibration. It cannot drift, cannot expire, and cannot lose its paperwork.
Greenspan's uncertainty for NaCl at 25 °C is **±0.12 %RH** — on paper better
than a working chilled mirror. National metrology labs only surpass salts
with gravimetric hygrometers and two-pressure generators.

**Physics:** Greenspan, *Humidity Fixed Points of Binary Saturated Aqueous
Solutions*, J. Res. NBS 81A(1), 89–96 (1977). The app carries the paper's own
polynomial fits for six salts, valid 0–50 °C, verified in
`test/saltref.test.js` against the paper's tabulated values at 0/25/50 °C.

**What limits a real jar is temperature knowledge, and it differs sharply by
salt** — so the app *computes* the uncertainty instead of guessing one:

```
u = √( u_table² + (dRH/dT · u_T)² )
```

where `u_table` is a conservative bound on Greenspan's tabulated uncertainty,
`dRH/dT` is the slope of the salt's own curve, and `u_T` is how well you know
the chamber temperature (you enter it; default ±0.5 °C). The breakdown is
shown with every verdict.

| Salt | RH @ 25 °C | u_table | dRH/dT @ 25 °C | u with chamber ±2 °C |
|---|---|---|---|---|
| Lithium chloride | 11.3 % | ±0.6 | −0.02 | ±0.60 |
| Magnesium chloride | 32.8 % | ±0.4 | −0.06 | ±0.42 |
| Magnesium nitrate | 52.9 % | ±0.7 | **−0.30** | ±0.92 |
| Sodium chloride | 75.3 % | ±0.4 | **−0.04** | ±0.41 |
| Potassium chloride | 84.3 % | ±0.6 | −0.15 | ±0.67 |
| Potassium sulfate | 97.3 % | ±1.1 | −0.06 | ±1.11 |

Read the last column: NaCl barely notices a sloppy chamber — that flatness is
*why* it is the workhorse — while magnesium nitrate pays heavily for the same
sloppiness. `test/saltref.test.js` pins the slopes (against finite
differences) and NaCl's flatness specifically.

Technique: slurry with visible solids ("wet sand"), sensor suspended above
it, jar sealed, hours to equilibrate (longer above 80 %RH), and the jar at a
stable, known temperature.
**Use when:** you want the most trustworthy check available without a
metrology lab. Table salt gives you an absolute 75.3 % point for pennies.

## 4. Ice point — temperature

**Reference:** a properly made ice slurry is 0.00 °C by definition of the
scale, reliable to better than ±0.05 °C.
**Uncertainty used:** ±0.1 °F.
**Technique:** crushed ice + a little distilled water — slush, not floating
cubes; stir; wait two minutes; probe mid-bath, off the walls.
**Use when:** always — it is the cheapest trustworthy temperature check that
exists.

## 5. Boiling point, altitude-corrected — temperature

**Reference:** pure water boils where its saturation pressure equals ambient
pressure. The app computes the local boiling point from the site pressure it
already knows — at 5,000 ft water boils near 203 °F, not 212 °F, and a check
that forgets this fails good sensors.
**Physics:** Newton inversion of the Hyland–Wexler saturation curve
(published validity 0–200 °C), oracle-tested in `test/boilref.test.js`
against IAPWS-IF97 saturation points across the full declared 55–110 kPa
window — agreement within 0.002 °C. This math sits outside the app's CoolProp-validated core
domain and therefore carries its own steam-table oracle.
**Uncertainty used:** ±0.9 °F practical — dissolved solids raise the boiling
point, pots superheat near the element, and a probe touching metal reads the
pot. The equation is ~10× better than the technique; the verdict honors the
technique.
**Use when:** you need a second temperature point above ambient to check
sensor slope, not just offset.

## 6. Reference-instrument comparison — RH or temperature

**Reference:** a recently calibrated instrument, side by side with the sensor
under test, both settled at the same spot.
**Uncertainty used:** whatever its calibration certificate says (you enter
it); the guard band applies exactly that amount, so a vague certificate
means more "too close to call" verdicts — as it should.
**Use when:** day-to-day spot checks — fastest method, and exactly as good as
the reference's paperwork.

## Choosing

- Fast spot check: **6** (reference instrument) or **1** (psychrometer).
- Most trustworthy RH, no lab required: **3** (salt jars — NaCl first; at a
  stable known temperature this is the gold standard).
- Continuous/process-grade RH instrument on site: **2** (dew-point meter).
- Temperature offset: **4** (ice). Temperature slope: add **5** (boiling).

Cross-validate: a sensor that passes NaCl at 75 % and LiCl at 11 % has proven
span, not just a lucky offset. Log every check (the app's history features)
and watch drift, not single verdicts.
