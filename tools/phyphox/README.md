# phyphox field experiments

Custom experiments for the [phyphox](https://phyphox.org) app, for surveying a
hall with the phone that is already in your pocket. They are **not** part of the
planner bundle — nothing here is imported by `src/`, nothing is precached by
`sw.js`, and the build does not see them. They are files you install on a phone.

| File | What it measures | Needs |
|---|---|---|
| `sound-level-meter.phyphox` | A-, C- and Z-weighted sound level, Leq, Lmax/Lmin, peak, noise dose | microphone |
| `hall-survey.phyphox` | barometric pressure trace + a logged point per location, with dry bulb and RH typed in | barometer |
| `emi-survey.phyphox` | magnetic field and its fluctuating part, for finding live power runs near copper data cable | magnetometer |

## Installing one on a phone

Any of these work:

- **Email or messaging** — send yourself the `.phyphox` file and open it; phyphox
  registers the extension and offers to import it.
- **QR code** — host the file at a URL and encode that URL (`https://…/x.phyphox`)
  in a QR code, then use phyphox's own QR scanner. The QR holds the *link*, not
  the file, so it stays small and scannable.
- **File manager** — copy to the device and tap the file.

Once imported, the experiment sits in your phyphox list alongside the built-in
ones and survives app restarts.

## Why these exist

phyphox ships nothing that reports a weighted sound level: `Audio Amplitude`
gives a sound pressure level, but unweighted and uncalibrated. Data-hall work
wants A-weighting (for people), C-weighting (for the low-frequency fan rumble
that A-weighting discounts), and an equivalent level over time rather than an
instantaneous number.

Nothing ships for the other two jobs at all.

## Accuracy, and where it runs out

**Sound level meter.** The A- and C-weighting curves are applied in the frequency
domain from the IEC 61672 pole definitions; the implementation was checked
against the standard's nominal table and agrees to within 0.27 dB from 10 Hz to
20 kHz, which is the rounding in the table itself. The level chain is exact: a
full-scale sine reads −3.010 dBFS and amplitude scaling is linear to within
0.001 dB.

That is the part that is under our control. The part that is not:

- **The microphone is uncalibrated.** The experiment starts with a +120 dB
  offset, which is a plausible value for a phone and nothing more. Until you
  calibrate against a reference the absolute number is a guess; *differences*,
  spectra and the C−A gap are meaningful immediately.
- **Frequency response is unknown** and typically poor below ~100 Hz — exactly
  where fan noise lives. The C−A difference will read low for that reason.
- **AGC and noise suppression.** If a steady sound produces a reading that
  drifts downward, the OS is applying gain control and no calibration fixes it.
- **Clipping.** Phones clip around 100–110 dB(A). The meter has a clipping
  check; if it trips, the reading is meaningless, not merely inaccurate.
- Time weighting is a rectangular 85 ms / 1 s average, not the exponential Fast
  and Slow of IEC 61672, and the peak is unweighted rather than C-weighted.

Use it to compare positions, find tonal sources and watch trends. Do not use it
for hearing-protection decisions or anything with a legal threshold.

**Hall survey.** Pressure is a real measurement, good to about 0.1 hPa relative,
with absolute calibration possibly several hPa out. Temperature and humidity are
**typed in, not measured** — no phone has a hygrometer, and the phone's internal
temperature sensors read its own electronics. The barometer resolves roughly
1–10 Pa, which is the same order as an aisle-containment differential, so a
containment check is an indication and not a manometer reading. Height matters:
1 m of elevation is about 12 Pa.

**EMI survey.** The magnetometer samples at roughly 50–100 Hz, so 50/60 Hz mains
is at or above Nyquist and **aliases**. That is why the experiment reports the
*size* of the field fluctuation and deliberately not its frequency — any mains
frequency this sensor reported would be an artefact. The fluctuation size is
still a reliable finder for live conductors. It measures field, not interference
coupled into a cable; screening, pair twist and routing geometry are invisible to
it. A strong reading is a reason to check a cable route, not a measurement of
crosstalk. For an actual link problem, test the link.

## Editing them

The format is the [phyphox file format](https://phyphox.org/wiki/index.php/Phyphox_file_format):
XML declaring buffers (`data-containers`), hardware `input`, an `analysis` chain
of small modules run once per cycle, `views`, and `export` sets.

Two traps worth knowing, both of which bite silently:

1. An XML comment cannot contain `--`, so the usual `<!-- ----- section ----- -->`
   divider makes the file unparseable and phyphox just refuses to import it.
2. A buffer is a fixed-size ring. Writing 2047 values into a size-2048 buffer
   with `clear="false"` leaves one stale value at the front and shifts everything
   after it — which, in a spectrum, silently misaligns the frequency axis by one
   bin.

`lint.py` in this directory catches both of those, plus undeclared buffer names,
formula placeholders pointing past the input list, unknown analysis modules and
views bound to nothing. It is validated against the official `audio_amplitude`
and `audio_spectrum` experiments, which it passes with no findings.

```sh
python3 tools/phyphox/lint.py tools/phyphox/*.phyphox
```

## Getting the data back out

Export as CSV from phyphox. Each export set becomes its own file inside a zip.
The column names are set by the `name` attributes in the `export` block, so they
are stable and safe to parse.

`hall-survey.phyphox` exports its `Survey log` set with the column names the
planner's trend parser already looks for — `Timestamp`, `Dry bulb temp (C)`,
`RH (%)` — plus `Pressure (hPa)`.

One catch, unresolved on purpose: `src/lib/trendcsv.js` resolves timestamps with
`new Date(s)`, and phyphox writes time as a bare number. `new Date("1754")`
parses as *the year 1754* rather than failing, so a raw phyphox export would
import as silent nonsense — precisely the failure that module's docblock says it
must never have. Feeding these exports to the planner therefore needs
`parseTrendCsv` taught to recognise a numeric Unix-epoch time column, with the
fixture tests to match. That work is not done here.
