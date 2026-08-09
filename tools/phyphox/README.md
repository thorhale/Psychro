# phyphox field experiments

Custom experiments for the [phyphox](https://phyphox.org) app, for surveying a
data hall with the phone that is already in your pocket. They are **not** part of
the planner bundle — nothing here is imported by `src/`, nothing is precached by
`sw.js`, and the build does not see them. They are files you install on a phone.

| File | What it measures | Sensor |
|---|---|---|
| `walk-logger.phyphox` | noise, magnetic field, light, pressure, tilt and cadence on one clock, with a waypoint button | all of them |
| `dimension-survey.phyphox` | sonar distances with a temperature-corrected speed of sound, air temperature from a known distance, floor level and rack plumb | speaker + mic + accelerometer |
| `fan-tacho.phyphox` | fan RPM from blade-passing tone, imbalance and bearing crest factor | mic + accelerometer |
| `busway-load.phyphox` | relative loading of a busway or feed, non-contact | magnetometer |
| `emi-survey.phyphox` | live-conductor finder, for routing copper away from power | magnetometer |
| `hall-survey.phyphox` | barometric trace plus a logged point per location, T and RH typed in | barometer |
| `sound-level-meter.phyphox` | A/C/Z weighted level, Leq, Lmax/Lmin, peak, noise dose | mic |

## Installing one on a phone

- **Email or messaging** — send yourself the `.phyphox` file and open it.
- **QR code** — host the file and encode its URL (`https://…/x.phyphox`); phyphox
  scans it. The QR holds the *link*, not the file, so it stays scannable.
- **File manager** — copy to the device and tap it.

## What phyphox cannot do

It reads accelerometer, gyroscope, magnetometer, light, pressure, proximity,
microphone, GPS, camera, and Bluetooth LE from custom devices.

**There is no WiFi.** No RSSI, no scanning — it sits on the phone's sensor
framework and WiFi is not in it. For a coverage survey you need a separate app,
or an ESP32 running the phyphox BLE library, scanning APs and notifying RSSI as a
Bluetooth input. The walk logger is built to make either work: every row carries
a Unix timestamp, so a separate RSSI log joins to it on time alone.

## Accuracy, and where it runs out

Everything below was checked numerically before it was written down.

**Sound level meter.** A- and C-weighting are applied in the frequency domain
from the IEC 61672 pole definitions, and agree with the standard's nominal table
to within 0.27 dB from 10 Hz to 20 kHz — which is the rounding in the table
itself. The level chain is exact: a full-scale sine reads −3.010 dBFS, amplitude
scaling is linear to 0.001 dB. What is *not* under our control: the microphone is
uncalibrated (it ships with a +120 dB offset that is a plausible guess and
nothing more), its response below ~100 Hz is poor which is exactly where fan
noise lives, the OS may apply gain control, and phones clip around 100–110 dB(A).
Time weighting is a rectangular 85 ms / 1 s average, not the exponential Fast and
Slow of IEC 61672. Fine for comparing positions and finding tones; not for
hearing-protection decisions.

**Dimension survey.** The sonar core is phyphox's own chirp and cross-correlation,
unmodified. Added: speed of sound from air temperature rather than a fixed
340 m/s, which matters because 22 °C and 40 °C air differ by 3.0% — 9 cm over a
3 m span. Run backwards, a known distance gives the speed of sound and hence the
air temperature, which is a thermometer for air the phone is not touching. The
sensitivity is unforgiving: 1% error in the distance you type becomes 5.97 °C of
temperature error, and one sample of timing jitter at 48 kHz is 3.6 mm, worth
about 1 °C over a 2 m target. Measure the span properly, use a long one, take
several readings. Range is a few metres — a phone speaker is not loud.

The inclinometer is the most accurate instrument here, good to a few hundredths
of a degree once still, but only when completely still. Accelerometers carry a
zero offset, so check by rotating the phone 180° in place: the true slope is half
the difference.

**Fan tacho.** Blade-passing tone divided by blade count gives RPM. Crest factor
(peak over RMS) senses bearing impacts in the time domain, which matters because
phone accelerometers reach only 50–250 Hz — nowhere near bearing defect
frequencies. Overall level is acceleration, not the mm/s velocity of ISO 10816,
so do not read it against those charts. Compare unit to unit.

**Busway load.** Field falls off with distance and the phases in a busway partly
cancel, so standoff dominates and a balanced run reads low even at high current.
A pointer to something worth metering properly, not a measurement.

**EMI survey.** The magnetometer samples at 50–100 Hz, so 50/60 Hz mains is at or
above Nyquist and **aliases** — which is why these report the *size* of the field
fluctuation and never a frequency. It measures field, not interference coupled
into a cable; screening, pair twist and routing geometry are invisible to it.

**Walk logger.** No position, deliberately. Heading indoors comes from the
magnetometer, which in a hall full of steel and live conductors is wrong by tens
of degrees and changes as you walk; integrating the gyroscope drifts instead.
Either way the track curls up and looks plausible, which is worse than useless.
Waypoints plus interpolation, therefore. The step count is an estimate from
cadence — about 5% at a 100 Hz accelerometer rate, ~20% at 400 Hz. Good enough to
say you are two thirds down a row, not to count paces.

**Hall survey.** Pressure is real, ~0.1 hPa relative, absolute possibly several
hPa out. Temperature and humidity are **typed in, not measured** — no phone has a
hygrometer. The barometer resolves 1–10 Pa, the same order as an aisle
containment differential, so that check is an indication, not a manometer. Height
matters: 1 m of elevation is about 12 Pa.

## Editing them

The format is the [phyphox file format](https://phyphox.org/wiki/index.php/Phyphox_file_format):
XML declaring buffers (`data-containers`), hardware `input`, an `analysis` chain
of small modules run once per cycle, `views`, and `export` sets.

Three traps, all of which fail silently:

1. An XML comment cannot contain `--`, so the usual `<!-- ----- section ----- -->`
   divider makes the file unparseable and phyphox simply refuses to import it.
2. A buffer is a fixed-size ring. Writing 2047 values into a size-2048 buffer with
   `clear="false"` leaves one stale value at the front and shifts everything after
   it — which in a spectrum misaligns the frequency axis by one bin.
3. `log` inside a `formula` is not documented as natural or base-10. Use the
   `<log>` *module*, which is documented as natural, and multiply by
   4.342944819032518 for decibels.

`lint.py` catches the first two, plus undeclared buffer names, formula
placeholders pointing past the input list, unknown analysis modules, scientific
notation in formulas, and views bound to nothing. It is validated against the
official `audio_amplitude` and `audio_spectrum` experiments, which it passes with
no findings.

```sh
python3 tools/phyphox/lint.py tools/phyphox/*.phyphox
```

## Getting the data back out

Export as CSV; each export set becomes its own file inside a zip, with column
names taken from the `name` attributes in the `export` block, so they are stable
and safe to parse. Every logging experiment stamps rows with **Unix seconds**,
which is what lets separate recordings — a WiFi survey, camera shots, a second
phone — be joined on time.

If a second device is involved, log one obvious shared event (a hand clap in
front of both) so the alignment can be verified rather than assumed.

One catch, unresolved on purpose: `src/lib/trendcsv.js` resolves timestamps with
`new Date(s)`, and phyphox writes time as a bare number. `new Date("1754")`
parses as *the year 1754* rather than failing, so feeding a raw phyphox export to
the planner would import silent nonsense — precisely the failure that module's
docblock says it must never have. Wiring these into the planner needs
`parseTrendCsv` taught to recognise a numeric Unix-epoch column, with fixtures to
match. Not done here.

## Status

All seven pass the linter. **None has been run on a phone.** The physics and the
arithmetic are checked; whether phyphox's parser accepts every construct, and
whether the sonar behaves in a room full of hard reflective surfaces, is not.
