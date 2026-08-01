# Sensor validation methods — references and uncertainties

The app's Sensor Validation card offers six ways to check a temperature or RH
sensor against an **independent physical reference**. This page records what
each method's reference actually is, how good it is, and when to reach for it.
Every verdict in the app widens its pass band by the reference's uncertainty —
a check can never claim more confidence than its reference has.

Verdict bands (before widening): RH ±2 % PASS / ±5 % MARGINAL (typical
capacitive-sensor spec); temperature ±0.9 °F (0.5 °C) PASS / ±1.8 °F (1 °C)
MARGINAL.

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

**Reference:** the equilibrium humidity above a saturated salt slurry in a
sealed container — the classic NIST calibration method. Cheap, absolute, slow.
**Physics:** Greenspan, *Humidity Fixed Points of Binary Saturated Aqueous
Solutions*, J. Res. NBS 81A(1), 89–96 (1977). The app carries the paper's own
polynomial fits for six salts, valid 0–50 °C, verified in `test/saltref.test.js`
against the paper's tabulated values at 0/25/50 °C:

| Salt | RH @ 25 °C | App's uncertainty (conservative) |
|---|---|---|
| Lithium chloride | 11.3 % | ±0.6 |
| Magnesium chloride | 32.8 % | ±0.4 |
| Magnesium nitrate | 52.9 % | ±0.7 |
| Sodium chloride | 75.3 % | ±0.4 |
| Potassium chloride | 84.3 % | ±0.6 |
| Potassium sulfate | 97.3 % | ±1.1 |

The uncertainty applied is at or above Greenspan's largest tabulated value for
the salt anywhere in 0–50 °C — conservative on purpose (it can only make a
PASS harder). Technique: slurry with visible solids ("wet sand"), sensor
suspended above it, jar sealed, hours to equilibrate (longer above 80 %RH).
**Use when:** you want an absolute check with no second instrument — table
salt gives you a 75.3 % point for pennies.

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
against IF-97 steam-table points — agreement within 0.023 °C over
60–101.325 kPa. This math sits outside the app's CoolProp-validated core
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
it); the verdict band widens by exactly that amount.
**Use when:** day-to-day spot checks — fastest method, and exactly as good as
the reference's paperwork.

## Choosing

- Fast spot check: **6** (reference instrument) or **1** (psychrometer).
- Absolute RH, no second instrument: **3** (salt jars — NaCl first).
- Best-available RH: **2** (dew-point meter).
- Temperature offset: **4** (ice). Temperature slope: add **5** (boiling).

Cross-validate: a sensor that passes NaCl at 75 % and LiCl at 11 % has proven
span, not just a lucky offset. Log every check (the app's history features)
and watch drift, not single verdicts.
