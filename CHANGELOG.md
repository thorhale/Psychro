# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The service-worker cache key and the in-app footer stamp both derive from the
`version` field in `package.json` plus the git SHA, so bumping the version is
what rolls an update out to installed apps.

## [Unreleased]

### Changed — UI polish

- **The onboarding no longer taxes returning users.** The Start-here guide and
  the glossary were two full-width cards permanently above the tool — on a
  phone they consumed the top of the screen before you reached anything you
  came for. They are now one quiet, dashed card with the glossary nested
  inside, and a "Got it — hide this" button that retires it for good, leaving
  a single line to bring it back.
- **Hint text inside field labels is no longer shouted.** Labels uppercase
  their contents, which turned "optional — a barometer beats the elevation
  estimate" into three lines of capitals above one input. Hints now render as
  sentences, and unit symbols keep their case — `kPa`, not `KPA`.

## [2.2.0] — 2026-08-02

Two rounds of feature work and two rounds of audit. Highlights: six ways to
validate a temperature or humidity sensor against a physical reference, with
guard-banded verdicts that refuse to overclaim; shareable deep links, QR codes
and one-tap change-ticket briefings; a sensor drift logbook with per-instrument
specs and calibration recall; plan-vs-actual import from BMS trend exports; a
printable door placard; a training mode whose physics teaches real lessons; and
a first-run guide and glossary for operators new to the tool. Two cross-site
scripting paths found by audit are closed, and the app is now keyboard- and
screen-reader-operable.

### Added — a way in for someone who has never used this before

- **"Start here" card**: what this tool is for, and the four steps in order —
  describe the hall, set the contract, plan the move, check your instruments.
  An audit found the app had no first-run guidance of any kind.
- **Plain-English glossary**: every derived number the app prints — humidity
  ratio, dew point, wet bulb, enthalpy, SHR, the ASHRAE classes, site
  pressure, and the guard band on sensor verdicts — explained without jargon.
- **`docs/OPERATOR-GUIDE.md`**: a walkthrough for the person in the hall with
  a phone, linked from the app footer. The existing docs were all written for
  developers or for store submission.
- **The reference docs the app cites are now published with it.** Four places
  on screen pointed at `docs/*.md`, but only `dist/` is deployed — so on the
  live site and in both native shells those were 404s.

### Changed — accessibility, performance, offline

- **The chart is operable from the keyboard.** It had always been in the tab
  order, but every interaction was pointer-only, so a keyboard user tabbed
  into a dead stop. Arrows pan, `+`/`−` zoom, `0` resets — and the label says
  so.
- **Sensor verdicts announce themselves** to screen readers (`role="status"`,
  polite live region). It was the one dynamic region in the app that didn't.
- **Every field label is bound to its input** — around 40 numeric fields
  announced as unlabelled, and tapping a label never focused its field, which
  matters most on a phone.
- **The logbook's pass/fail column carries a word**, not just a colour.
- **Typing no longer writes to storage on every keystroke.** `update()` runs
  on every input event and saved the entire profile set synchronously, so a
  slider drag issued ~60 storage writes per second; saves are now debounced
  and flushed when the page is hidden or closed. The chart also stops
  reallocating its backing bitmap on every frame.
- **The offline download actually works offline.** The install banner
  advertises a take-it-with-you file that was never precached, so the one
  affordance that promised offline use was the one that 404'd without a
  network.
- **Manifest completeness**: a properly padded maskable icon (the previous one
  reused unpadded art and lost its edges to Android's icon masks), install
  screenshots, and an explicit app id.

### Fixed — seams and inconsistencies in the last round's work (round 2)

- **The logbook and the live verdict now use one grader.** History rows were
  coloured against the *recalibrate* bound and ignored the reference's
  uncertainty entirely, so a check the card above had just called MARGINAL
  rendered green in the table below it. Rows now carry the verdict word too —
  colour alone was the app's last colour-only signal.
- **Temperature history reads in your unit.** The spec editor said ±0.5 °C
  while the table under it printed ±1.8 and +0.30 °F/month, unlabelled. Same
  for the trend summary, which printed "Achieved 4.5 °F/hr" directly above a
  ramp line in °C.
- **Ladder mode speaks the fourth verdict.** Hands-free mode announced PASS,
  MARGINAL and FAIL but went silent on "TOO CLOSE TO CALL" — the one verdict
  that means *your reference cannot decide this*.
- **A breached training run can no longer collect the stability bonus.** A
  hall that blew the dew-point cap at minute 68 and settled afterwards was
  quietly scoring 30 points the result panel never explained. Challenge codes
  are now `v3`.
- **The cold-snap drill's brief matches its physics.** It promised a
  low-temperature threat that v2's server-heat load had made impossible — an
  idle hall *warms*. Rewritten to teach what the referee actually does: winter
  air cannot chill this hall, but it will strip the water out of it. (Raising
  the fault instead would have made the drill unwinnable, not harder — the
  training hall's warming rate is 4 °F/hr.)
- **An imported trend survives editing the hall card.** The result panel lived
  inside markup that unrelated edits rebuilt, so toggling a capability wiped
  the unit toggle and the "log to calibration" button while leaving the
  overlay drawn. It now redraws from the retained file.
- **A measured trail belongs to its hall.** Switching halls left the previous
  hall's trajectory on the chart, re-projected onto the new hall's pressure.
- **Exported artifacts state the real pressure basis.** The placard and
  briefing hardcoded "standard atmosphere at elevation" even when a measured
  barometer was in force — a laminated door sheet printing a measured 96.4 kPa
  as an estimate.
- **The set-point ladder states real elapsed hours.** A 40-hour move printed
  twelve rungs numbered 1–12 and called the last one "arrival".
- **Registry fixes**: the spec editor now edits the sensor named in the label
  box (it was editing whichever sensor sorted first alphabetically); sensors
  that arrive from a save file are selectable instead of being permanently
  "overdue" and unreachable; the overdue tally is correct at boot and after
  deleting a history.
- **Pinch-to-drag no longer jumps the chart** when you lift one finger.

### Security — untrusted text can no longer reach the DOM as markup

- **Fixed two cross-site-scripting paths.** Names in this app arrive from
  colleagues' save files and from BMS trend exports, not just from the local
  keyboard, so a crafted string was never "only the user's own problem": it
  would have run inside the app with access to every stored hall, SLA and the
  whole calibration logbook.
  - A trend-CSV import failure echoed the file's own header row into the page
    as HTML. The parser no longer quotes untrusted file text back at all — it
    names the columns it needed and how many it saw — and the message renders
    as text, not markup.
  - A hall's site name and an SLA profile's name were interpolated unescaped
    into the conditions readout, so importing a colleague's save file could
    execute code and persist it for every later boot.
  One escaper (`escHtml`) now covers every place user-supplied text meets
  `innerHTML`, and stored data is still preserved verbatim so legitimate names
  containing `&` or `<` are never mangled. End-to-end tests arm a tripwire and
  assert the payload stays inert through save-file, CSV and sensor-label paths.
- **The calibration logbook can no longer fail to save in silence.** Its two
  writers bypassed the quota-aware storage helper, so on a full device the
  most audit-critical data in the app was dropped while the UI confirmed each
  check as "Logged". Both now surface the storage-full warning.
- **A save file from a newer build is refused, not half-imported.** The format
  version was written but never read, so a future file merged whatever this
  build recognised and reported success while silently discarding the rest.

### Changed — the training referee got real (v2)

- **The servers never stop.** An uncommanded hall now drifts warm under a
  constant IT heat load — "do nothing" was previously a perfectly stable
  hall, the single most optimistic thing a recovery drill could teach. Every
  scenario now punishes hesitation: the stuck humidifier breaches the
  dew-point cap sooner, the tripped chiller runs away, and even the benign
  wash-down drifts out of its comfort zone and forfeits the stability bonus.
- **The plant is machinery, not an equation.** Outputs now chase demand with
  a first-order lag (τ ≈ 8 min), so the first minutes of any commit deliver
  only part of the plant — committing early beats committing perfectly, and
  the chiller-down drill now shows a real excursion-then-recovery arc. One
  emergent lesson: the old wash-down "answer" (78 °F / 45 %) actually asked
  the humidifier to add water mid-wash-down, and with lag that overshoot
  rides the leak into the dew-point cap — the sound target asks for *dry*.
- **"Stabilized" now means stable.** The bonus previously applied to any
  unbreached run and only ever looked at temperature; it now requires the
  final half hour to be entirely in-SLA and genuinely settled in both
  temperature and humidity.
- **Challenge codes carry the referee version** (`#train=v2.<scenario>.<seed>`).
  A code minted before the physics changed still opens and runs — on today's
  referee, with a plain warning that scores may differ — rather than being
  silently re-scored or keeping two physics engines alive.

### Added — sensor registry, calibration recall, audit-ready logbook

- **Sensor registry**: each instrument can now record its OWN datasheet spec
  (±%RH, ±temp) and calibration cadence. A registered spec replaces the
  generic tolerance in that sensor's verdicts — a ±3 %RH hall transmitter is
  no longer failed for meeting its own spec, and a ±1 %RH reference probe is
  no longer passed while out of its. Persisted, mirrored to native storage,
  and carried by save-file export/import (incoming specs win, so a
  colleague's fresher datasheet numbers replace stale ones).
- **Calibration recall**: give a sensor a check-every-N-days cadence and the
  logbook becomes a recall list — "next check due in 12 days" per sensor,
  and an "⚠ N sensors overdue" note on the card's collapsed summary so the
  reminder is visible without opening anything.
- **Audit-ready log entries**: each logged check now records the hall, the
  site, and the technician's initials — the first three questions a customer
  QA review asks of a calibration record. Old save files stay valid; the
  fields are optional.
- **The whole logbook exports as CSV** (named `sensor-logbook_<hall>_<date>`)
  for QA packs and spreadsheets, and a sensor's temperature and humidity
  histories are now shown side by side — logging one ice-point check used to
  hide a sensor's entire RH history.
- **The briefing became a work order**: a generated-at timestamp and an
  hour-by-hour set-point ladder ("Hour 3: 72 °F / 41% RH") computed with the
  same pacing the chart's tick marks show — the ticket and the chart cannot
  disagree about hour three.
- **Measured barometer override**: a hall with a barometer can enter the real
  site pressure (55–110 kPa); it replaces the ±2 kPa elevation estimate
  everywhere, the readout says "measured on site", and clearing the field
  falls back to the elevation model. Out-of-range entries are cleared, never
  silently clamped into a different wrong value.

### Changed — field usability on the hall floor

- **Touch targets sized for gloved thumbs.** On touch screens every small
  control (zoom buttons, legend chips, tabs, preset and delete buttons)
  grows to the 44 px platform guidance; desktop keeps the compact layout.
- **Tap to inspect the chart.** The crosshair readout was mouse-only while
  the hint promised hover and modifier clicks; a still tap now pins the
  inspector on a phone, a second tap (or any pan/pinch) dismisses it, and
  the hint tells the truth about which gestures need a mouse.
- **Typed values reconcile on blur.** Values are clamped live but the box
  being typed in was never rewritten — type 95 °F under an 80 °F SLA and
  the box said 95 forever while everything computed 80. Leaving the box (or
  pressing Enter) now snaps it to what the app actually used and explains
  the limit in plain words.
- **Deleting an SLA profile or a saved scenario asks first** — both were
  single un-undoable taps while hall delete always confirmed.
- **Export filenames name their contents**:
  `placard_<hall>_<SLA>_<date>.pdf` instead of every export from every hall
  saving as the same `sdc_psychrometric.pdf`. RH and other positive-only
  fields request the phone's decimal keypad.
- **The door placard prints on white.** It is a laminated door sheet, and
  the dark full-bleed page drained toner and collapsed the amber/red limit
  columns to matching grey on a mono laser. Bold black on white now, chart
  framed as a figure, and the QR caption promises exactly what the link
  carries (set-points and site elevation — the limits are on the sheet).

### Changed — measured-data honesty (guard-banding, trend import, drift, boiling)

- **Sensor verdicts are now guard-banded (ISO 14253-1).** Claiming PASS
  requires the error to be inside tolerance *by more than the reference's own
  uncertainty*; when the reference's ±u straddles the limit, the verdict is a
  new "TOO CLOSE TO CALL — use a tighter reference to decide". The previous
  rule widened the pass band instead, which let a *worse* reference pass more
  sensors — backwards, and now impossible. Grading moved to a unit-tested
  core module (`src/core/svverdict.js`); `docs/sensor-validation.md` explains
  the rule and its honest consequence: the boiling-point method (±0.9 °F
  practical) can catch gross errors but can never certify a PASS — the ice
  bath can.
- **BMS trend import got street-smart.** Null sentinels (−9999, 32767) are
  rejected *before* the temperature-unit heuristic they used to corrupt, and
  values that only become nonsense after unit conversion are dropped too.
  Day/month vs month/day is decided from the whole date column (an EU export
  no longer silently time-travels), and the readout says when the order was
  assumed rather than proven. The temperature-unit override that existed in
  the parser but never in the UI is now two taps ("°F / °C — re-read the
  file"). Dropout gaps break the chart overlay line instead of being drawn
  as confident straight segments.
- **SLA ramp limits are finally checked against something.** New `checkRamp`
  in the tested core plus a gap-aware rolling-window maximum rate: every
  imported trend now reports its fastest *sustained* ramp (window widens to
  the sample interval on coarse data, and says so) with a plain verdict
  against the SLA's °F/hr and %RH/hr limits — the same numbers the door
  placard prints as DO NOT CROSS. Long idle stretches at either end of a
  trend are called out, since they dilute the average rate and any
  efficiency logged from it.
- **Drift forecasts earn their precision.** The logbook's days-to-band figure
  now requires three checks (two points fit any line exactly), carries the
  slope's standard error, and renders as a range ("roughly 40–90 days")
  instead of a single number that reads like a scheduling date.
- **Boiling-point reference: fixtures now span the full declared 55–110 kPa
  window** (IAPWS-IF97 oracle, agreement ≤0.002 °C), and a non-converged
  inversion returns "no answer" instead of its last guess.
- **Site pressure displays one decimal, not three**, labeled "standard
  atmosphere at elevation — weather swings ±2 kPa". Three decimals asserted
  precision the elevation model does not have; the placard's "all numbers
  below are pressure-aware" overclaim now names exactly what is (the
  dew-point cap).

### Fixed — say true things (verdicts, units, planner honesty)

- **Briefing said "remove moisture" on every move, even humidification.**
  The copied change ticket branched on the sign of the water mass — which is
  always positive (it's a mass). It now takes its direction from the same
  plan label the on-screen readout uses, and the test suite pins both
  directions.
- **The ASHRAE zone badge now agrees with the drawn envelope at every
  pressure.** Classification previously used fixed sea-level g/kg caps while
  the chart drew the real pressure-aware boundary, so at altitude a point
  could sit visibly inside the plotted A1 polygon while the badge said A2.
  Both now share one boundary engine, pinned by a property test that
  ray-casts random points against the very polygons the chart renders.
- **SLA verdicts follow the °C/K toggle.** "T < 50°F" used to appear verbatim
  in °C mode (headline chip, chart tooltip, copied briefing). The core now
  returns the violated bound as data and the display layer formats it in the
  active unit ("T below 10 °C").
- **The Customer SLA editor is unit-aware.** The one card where the
  customer's contract numbers get typed was Fahrenheit-only; it now edits in
  the active display unit and stores canonically, including the per-hour
  ramp limit (which converts as a temperature *difference*, not an absolute).
- **A missing plant rate no longer yields a confident plan.** With no
  cooling/warming rate entered, `null × factor` silently produced an
  unconstrained estimate and a "✓ Achievable within about an hour" verdict.
  The planner now flags the missing rate, the readout explains what to enter
  and where, and the briefing says "Duration unknown — plant rates are not
  set for this hall" instead of "No plant work required."

### Added — training mode, NFC tags, hands-free voice

- **Envelope Escape Room** (`src/core/trainer.js`): a training card where a
  plant fault hits a fixed training hall — stuck humidifier, chiller down,
  economizer cold snap, dehumidifier tagged out during a wash-down — and the
  trainee commits a recovery target. A physics referee (same core equations
  as the planner, explicit 1-minute steps, plant rates capped) plays out four
  hours and scores the SLA minutes kept plus a stabilization bonus. Faults
  are jittered deterministically per seed, so a **challenge code**
  (`#train=<scenario>.<seed>`) reproduces the identical run on any device —
  the training hall is fixed at standard pressure for exactly that reason.
  The "Hesitate…" button runs the fault with no plant response: the cost of
  not committing is the game's core lesson. Unit-tested for determinism,
  physicality, and — because a drill must be beatable — winnability of every
  scenario at both test and standard pressure.
- **NFC hall tags**: on browsers with Web NFC (Chrome on Android), a "Write
  NFC tag" button writes the current scenario deep-link to a physical tag —
  stick it on the hall door, tap it with any phone. Feature-detected: the
  button simply does not exist elsewhere, and QR remains the universal
  fallback.
- **Ladder mode**: a hands-free toggle on the sensor-validation card — big
  type readable from the floor, and each new verdict spoken aloud through
  the device's own speech synthesis (local voices only, off by default,
  feature-detected). For when both hands are holding a psychrometer up a
  ladder.

### Added — operator companion (logbook, plan-vs-actual, placard)

- **Sensor drift logbook**: any validation check (any of the six methods) can
  be logged against a named sensor. Per-sensor history table plus a
  least-squares drift trend (`src/core/driftfit.js`): %RH-or-°F per month and
  days-to-the-recalibrate-band, always labelled as a linear extrapolation with
  its point count and span. Persisted (new `sdc_psychro_sensorlog_v1` key,
  mirrored to native storage), schema-validated and capped at 500 entries,
  and carried by save-file export/import with de-duplication.
- **Plan vs. reality**: import the BMS/BAS trend CSV of a real move
  (`src/lib/trendcsv.js` — BOM, semicolon/comma-decimal EU exports, quoted
  fields, shuffled columns; refuses rather than guesses, and REPORTS which
  temperature unit it assumed and why). The actual trajectory overlays the
  chart as a legend-toggleable layer next to the plan, and one tap logs the
  measured duration into the existing efficiency calibration — same entry
  shape as the stopwatch path, so `renderPva` treats both identically.
- **Door placard PDF**: one printable portrait page per hall — the
  do-not-cross SLA numbers (incl. dew-point cap and ramp limits), envelope
  chart snapshot, site pressure basis, and a QR deep-link to the live planner.
  The PDF emitter grew a portrait option; still zero dependencies.

### Added — share everywhere (deep links, QR, briefing, playback)

- **Scenario deep links** (`src/state/urlstate.js`): the whole A→B setup in
  the URL hash — paste it in a change ticket, text it to the on-call phone.
  Versioned, hostile-input-hardened, property-tested round-trip; carries the
  site elevation so a device without the named hall still lands at the right
  pressure (and says so instead of silently substituting).
- **QR codes** (`src/lib/qr.js`): a self-contained encoder (byte mode, EC-M,
  versions 1–10, Reed–Solomon, mask selection) keeping the zero-runtime-
  dependency rule. Proven like the physics: `test/qr.test.js` round-trips
  every version and 25 fuzzed payloads through an independent decoder (jsqr,
  devDependency only) — which caught a real spec bug during development
  (alignment patterns on the timing column must be drawn, not skipped).
- **One-tap briefing** (`src/app/briefing.js`): the planned move as plain
  English — deltas, duration, binding constraint, SLA verdicts, site basis —
  built from the same derived states every display surface uses, so the prose
  cannot contradict the table beside it. Copy-to-clipboard via a new shared
  `copyText` helper.
- **Ramp playback**: play/scrub the move along the chart's A→B line, marker
  riding exactly the pacing-tick interpolation, readout expressing the
  scrubbed point through the same core the hover inspector uses. Honors
  `prefers-reduced-motion` (steps hour-by-hour instead of gliding). The
  animation loop redraws the chart only — never the persistence path.

### Changed

- Bundle size budget raised 220/65 → 280/85 kB (raw/gzipped) — deliberate
  growth: the sensor suite, QR encoder, deep links, briefing and playback add
  ~9 kB gzipped, with headroom for the logbook/CSV/training milestones. The
  budget still fails instantly on a vendored library or an inlined asset.

### Added — sensor-validation suite (six external reference methods)

- The Sensor Validation card grew from one method to six, each producing a
  reference value **with its uncertainty**, and every verdict band widens by
  that uncertainty — a check can never claim more confidence than its
  reference has. New: **dew-point instrument** (chilled-mirror class, via the
  existing tested inverse), **saturated-salt chambers** (`src/core/saltref.js`
  — Greenspan 1977 NBS polynomial fits for six salts, 0–50 °C, transcribed
  from the paper's full text and pinned in `test/saltref.test.js` to its
  tabulated values at 0/25/50 °C; conservative per-salt uncertainties),
  **ice-point** and **altitude-corrected boiling-point** temperature checks
  (`src/core/boilref.js` — Newton inversion of the Hyland–Wexler curve,
  oracle-tested against IF-97 steam-table points, agreement ≤0.023 °C; the
  UI states the ±0.5 °C practical limit of a field boil), and
  **reference-instrument comparison** with certificate uncertainty. The
  psychrometer method is unchanged. Verdict bands are named constants now,
  not magic numbers. **Salt-chamber uncertainty is computed, not lumped**:
  u = √(u_table² + (dRH/dT·u_T)²), with the salt's own curve slope and a
  user-entered chamber-temperature confidence — the breakdown shown with the
  verdict. This makes the gold-standard nature of NaCl visible (−0.04 %RH/°C:
  nearly immune to chamber-temperature error) and the cost of using
  Mg(NO₃)₂ with sloppy temperature control equally visible (−0.30 %RH/°C);
  both slopes are pinned in tests. `docs/sensor-validation.md` documents every method,
  reference, and uncertainty; the in-app self-test gained four cases pinning
  the new reference data (35 → 39).

### Fixed

- A calibrated plant efficiency above 100 % survived only until reload:
  `normalizeHall` clamped `effPct` to 1–100 while the UI and calibration flow
  allow 1–150, so a measured 120 % silently degraded to 100 %. Schema ceiling
  now matches the UI; pinned in `test/schema.test.js`.

### Added — store submission kit

- `docs/store/LAUNCH-GUIDE.md` — a plain-language, first-timer walkthrough of
  both store submissions: accounts, keys, the one branding decision, Play's
  12-tester/14-day rule, listing copy-paste map, rejection playbook, and a
  complete pre-flight checklist of every store requirement with its status.
- `npm run screenshots` (`scripts/store-screenshots.mjs`) — renders the six
  checklist shots at every store-required size (iPhone 6.9", iPad 13", Play
  phone/tablet) plus the Play feature graphic, dimension-asserted from the PNG
  headers; committed under `docs/store/screenshots/`. Not in CI by design.
- `Release builds (store upload)` workflow — dispatch-only. Android: signed
  `.aab` artifact. iOS: archive + upload straight to TestFlight via the App
  Store Connect API key, so no Mac is ever needed. Each job checks its secrets
  first and ends green with a plain-English notice when they aren't configured.
- Conditional release `signingConfigs` in `android/app/build.gradle`, inert
  unless the workflow provides a keystore — debug builds unaffected.

### Fixed

- The data-table footnote still described enthalpy as Eq. 30 and specific
  volume as plain Eq. 26 — superseded when both became real-gas fits. The
  footnote now states what the table actually computes; the chart's iso-line
  guides (which do use the closed forms, deliberately) got a comment saying so.

### Added — store-upload readiness

- **Privacy policy**, required by both app stores even for a zero-collection
  app (the store docs wrongly said otherwise): hosted at `/privacy.html` on the
  deployed site for the consoles' mandatory URL field, and reachable in-app via
  a footer "Privacy" dialog (Google Play requires the in-app copy). One source
  of statements (`src/app/privacy.js`); `test/assets.test.js` pins the hosted
  page to it so the two copies cannot drift.

### Fixed — store-upload readiness

- `UIRequiredDeviceCapabilities` said `armv7` (32-bit) while the project
  targets iOS 15, which is 64-bit only — an upload-validation failure waiting
  to happen. Now `arm64`.
- `ITSAppUsesNonExemptEncryption = false` declared in Info.plist (no crypto
  anywhere, verified by scan), so App Store Connect stops prompting per upload.
- Native version numbers synced to package.json 2.1.1 (Android
  `versionName`/`versionCode 20101`, iOS `MARKETING_VERSION`); they still said
  1.0/1.
- Android FileProvider scope tightened from the entire external storage root to
  the cache directory — the only place `src/platform/index.js` ever writes a
  shared file.

### Changed

- **CI now fits a free GitHub plan.** Every commit on a PR branch was running
  the entire pipeline twice (`push: ['**']` and `pull_request` both matched),
  and the iOS compile job — billed at macOS's 10× minute multiplier — ran on
  every PR update regardless of what changed. Together they consumed a full
  month's 2,000 free Actions minutes in one day. Push triggers now fire on
  `main` only, PRs run once, superseded runs are auto-cancelled, and the iOS
  job runs only for PRs that touch the native projects (or on demand). Nothing
  was removed from the gate that guards merges — the web pipeline still runs
  in full on every PR, and every merge to `main` still runs everything.

## [2.1.1] — 2026-07-31

### Fixed

- **The live app's own download link 404'd.** The deployed site is the built
  `dist/` (deploy.yml), but `StreamHallPlanner.html` was only ever written to
  the repo root — so the "download this app" link and the install banner's
  file fallback pointed at a file the deployment did not contain. Every test
  stayed green because only the raw-served tree asserted the link, and the raw
  tree has the root copy. Three-layer fix: `make-shareable` now writes the file
  into `dist/` too (byte-identical), `verify-bundle` fails any dist/ missing it
  or carrying different bytes, and a new E2E test fetches the link's href under
  BOTH artifacts and requires a 200 with a real payload.
- Comments across the tree claimed "GitHub Pages serves this repo raw" — true
  before deploy.yml existed, false since. Corrected everywhere it steered
  decisions; the repo root remains build-free servable and tested as such.

## [2.1.0] — 2026-07-31

Everything since 2.0.0: the round-2 hardening and native projects, the merge
with `main`, the first-visit offline fix, and the shakedown below.

### Fixed — measurement, not physics

- **The accuracy analyzer under-reported the core's enthalpy accuracy 14×.**
  `scripts/analyze-accuracy.mjs` called `enthalpy(t, W)` without the pressure
  argument, so the fit's real-gas mixing term defaulted to sea level while the
  reference grid spans 60–108 kPa — every altitude point was graded against the
  wrong answer. True agreement with CoolProp is **max 0.030 kJ/kg** (RMS 0.002),
  not the 0.437 previously published; `docs/coolprop-comparison.md` §4 is
  corrected. No shipped number was affected: the app's own call sites and the
  oracle suite always passed pressure (the suite's tolerance comment already
  read "measured max 0.031" — the two measurements disagreeing was the loose
  thread). The analyzer is the number generator behind the published table, so
  an error here is an accuracy bug even though no physics changed.

### Changed — raw-deploy freshness no longer depends on a human

- **Service worker is now stale-while-revalidate instead of cache-first.**
  Cache-first froze the raw GitHub Pages deploy at whatever a visitor first
  cached, to be invalidated only by a hand-bumped `RAW_VERSION` in `sw.js` — a
  manual step destined to be forgotten, after which returning visitors would
  run outdated physics silently and forever. Now every online visit serves from
  cache instantly (the offline guarantee is unchanged) while refreshing the
  cache in the background, so a returning visitor is at most one load behind
  the deployed code with no bump required. `RAW_VERSION` remains only as a
  cache namespace for strategy changes.

### Removed

- Stale `test/**/*.mjs` lint glob (no such files since the E2E unification) and
  leftover merge-context comments.

### Added — native

- **Capacitor projects for iOS and Android** (`android/`, `ios/`), wrapping the
  same `dist/` the web app deploys — one build artifact, not two. Platform
  differences live entirely behind `src/platform/`, selected by runtime bridge
  detection, so no UI code imports a Capacitor package.
- **Durable native storage.** Reads stay synchronous from localStorage; writes
  mirror to Capacitor Preferences; boot restores localStorage from Preferences.
  This is what survives iOS evicting WebView storage from an app left unused.
  Same-key mirrors are serialised per key — without that, a write resolving after
  a later delete resurrects data the user removed.
- Status-bar styling, splash dismissal after first render, and an Android
  hardware-back handler that closes dialogs and panels before closing the app.
- `docs/store/` — listing copy, both stores' privacy answers, screenshot
  checklist, and a signing guide covering every credential and step.
- `ios/App/App/PrivacyInfo.xcprivacy` declaring no tracking and no collected data.
- `native.yml` CI: unsigned Android debug APK on push, iOS compile check on PRs.
  Neither gates the web pipeline.

### Fixed

- **Offline correctness.** Vite fingerprinted the `<link rel="manifest">`
  target, rewriting the HTML to `manifest-<hash>.webmanifest` while `sw.js`
  precached the literal `./manifest.webmanifest` — so the manifest the installed
  PWA actually referenced was never in the offline cache. Fingerprinting is now
  off for assets (`build.rollupOptions.output.assetFileNames`), and the assets
  stay at the repo root as a single copy. Moving them under `public/` would have
  worked for the build and broken the raw GitHub Pages deploy, which serves
  `index.html` from the root and needs its siblings there; keeping a copy in both
  places makes Vite resolve the root one and start hashing again. Cache busting
  never depended on filenames — it comes from the per-build service-worker key.
  `test/assets.test.js` pins the root layout, including that every icon the
  manifest names exists and is precached.
- **Manifest icon references were unverified.** `@capacitor/assets` rewrote the
  manifest to point at `../icons/*.webp` — outside the deploy root, wrong MIME
  type, and absent from the precache list — and the bundle verifier passed it,
  because it checked the link *reaching* the manifest but never the manifest's
  own contents. Now checked: path containment, existence, precache membership,
  MIME/extension agreement, required fields.

### Added

- `scripts/verify-bundle.mjs` — post-build gate asserting 41 properties of the
  shipped artifact: the single-file promise, no fingerprinted PWA assets, and
  that every service-worker precache entry exists and covers what the HTML
  references. Exits non-zero; runs in CI after every build. The cache-key check
  *evaluates* sw.js's own expression rather than pattern-matching a literal, so
  it cannot agree with a service worker whose versioning rule silently changed.
- `src/core/derive.js` — one `deriveState(tc, rh, p)` consumed by all four
  display surfaces (properties table, Current→Target readout, chart hover,
  export canvas), making cross-surface agreement structural.
- `src/state/persistence.js` — the v4/v3/v1 storage migration extracted from
  `loadProfiles()` as a pure function, with 17 fixture tests over the real
  historical payload shapes.
- **Invariant test suite** (`test/invariants.test.js`) — physical laws asserted
  over 2,000 seeded-random states: round trips, orderings, monotonicity,
  saturation limits, envelope containment at five site pressures, determinism,
  and domain-guard completeness against the oracle grid.
- **Cross-surface consistency suite** (`test/consistency.test.js`) — proves
  `deriveState` equals raw core recomputation exactly, and that the planner's
  water-mass figure reconciles with the humidity ratios displayed beside it.
- **Playwright E2E + visual regression** — 22 tests against the built artifact,
  including an offline boot test and five committed chart goldens.
- CI: build/verify/e2e jobs; Pages deploy workflow gated on the full suite.

### Changed

- `checkSLA` consolidated into `src/core/envelopes.js` (it existed twice —
  tested-but-unused in core, used-but-untested in the UI). It now owns the
  operator-facing badge strings.
- The PNG/PDF export header gained a derived-properties line; an exported sheet
  previously omitted dew point, the number SLA caps are written against.
- Test count: 52 → 136 unit + 58 E2E. Bundle checks: 20 → 41.
- Bundle size 46.3 → 59.2 kB gzipped: one artifact serves web and native, so the
  Capacitor plugin code ships to web even though the web path never runs it.
  Two builds would mean E2E verifies a different artifact from the one on a
  phone — a worse consistency risk than the bytes. A size budget (220 kB raw /
  65 kB gzipped) now fails the build on accidental growth.

### Fixed — offline on a first visit

- **The app claimed to be offline-ready after one visit while holding none of
  its own code.** A service worker does not control the page that registers it,
  so on a first visit every module under `src/` was fetched before the worker
  existed and never reached its fetch handler. The precache list names the shell
  and cannot name ~40 modules without going stale on the next import. Measured
  on the raw deploy: **3 of 19 resources cached** at `navigator.serviceWorker.ready`,
  and full coverage only after a second *online* load. `src/app/pwa.js` now sends
  the worker the same-origin URLs the page actually pulled (read from the
  resource timeline, so it cannot drift from the real module graph) and the
  worker caches them. First visit now reaches **19/19**.
- The runtime cache fill used a fire-and-forget `cache.put`. `respondWith`
  resolves as soon as the response is in hand and the browser may kill an idle
  worker once its events settle, so the write could be dropped — invisibly, the
  page having rendered fine from the network. Now tied to `e.waitUntil`.
- The E2E offline test passed locally and failed in CI because it was relying on
  the browser's HTTP cache rather than the service worker. It now waits for the
  cache to actually cover what the page loaded, and asserts the expected
  resource count per artifact, so "everything is cached" cannot be satisfied by
  an empty set. (`page.waitForFunction` cannot express this: it treats the
  Promise an async predicate returns as truthy and resolves immediately.)

### Merged with `main`

`main` had evolved independently. Both deploy models are now supported rather
than one replacing the other, and both test suites survive:

- **The repo root stays directly servable.** At the time of the merge GitHub
  Pages published this repo raw, so `index.html` and its ES modules had to work
  with no build step (they still do — local preview and the `raw` E2E project
  depend on it; the live site now publishes the built `dist/` via deploy.yml). The
  Vite single-file build is now the *second* artifact, not the only one.
- **E2E covers all three artifacts** under one static server: the raw module
  tree, the built `dist/`, and `StreamHallPlanner.html` over `file://`. The
  behaviour suite runs against the first two under separate Playwright projects,
  so they cannot drift apart silently. This caught a real defect immediately:
  `page.goto('/')` discards the baseURL's directory, so the `built` project had
  been testing the raw app — the version-stamp assertion is what exposed it.
- Duplicate `playwright.config.{js,mjs}` and `app.spec.{js,mjs}` unified; both
  branches' specs kept (main's install/download/single-file-integrity coverage
  alongside the boot/wiring/persistence/offline/visual suites).

### Changed by the merge — physics accuracy improved

`main` replaced two correlations, and `npm run analyze` measures both as better
against CoolProp 8.0.0. `docs/coolprop-comparison.md` §4 is updated to match:

- **Enthalpy** is now a pressure-dependent polynomial fitted to RP-1485 instead
  of Ch. 1 Eq. 30's constant specific heats: max 0.461 → 0.030 kJ/kg, 15×.
  (This entry originally said "→ 0.437": the analyzer that produced that number
  was itself dropping the pressure argument — see the 2.1.0 fix below.)
- **Specific volume** carries a fitted compressibility factor Z(t, p, W) instead
  of assuming ideal mixing: max relative error 0.1125 % → 0.0114 %, a factor of
  ten. **Density** derives from it and improves identically.
- The **sensor-validation card defaults to the psychrometer formula** (what a
  sling psychrometer physically reads) rather than the thermodynamic wet bulb.
  At 75/62 °F that is 48.2 % RH, not 48.7 %. Both are now pinned by E2E and
  documented side by side, because a 0.5 % RH swap looks like rounding and
  fails a calibration audit.

### Verified

Full gate green after the merge: 136 unit tests, 58 E2E (including the five
committed chart goldens, which matched **without** re-blessing — the chart
renders identically across both artifacts), 41 bundle checks, lint, typecheck.
`npm run analyze` reproduces `docs/coolprop-comparison.md` §4 digit-for-digit.

## [2.0.0] — 2026-07-27

Rebuild of the single-file v1 tool around a CoolProp-validated physics core.
See [`docs/coolprop-comparison.md`](docs/coolprop-comparison.md) for the full
comparison and measured accuracy table.

### Fixed

Three defects that shipped in v1 and passed its 26-case self-test:

- **Humidity ratio, 0.23 % → 0.0013 %.** The enhancement factor was fitted over
  0–50 °C / 65–102 kPa while the chart reaches 54 °C and elevation reaches
  ~22 kPa, and it was evaluated at the dew point rather than the dry bulb —
  correct only at saturation. Refitted per saturation branch over the full
  reachable domain.
- **Dew point, up to 3.2 °C → 0.023 °C.** Replaced the ASHRAE Eq. 39/40
  correlation with a branch-pinned Newton inversion of the saturation equation.
  Dew point is what SLA dew-point caps are tested against.
- **Wet bulb, up to 0.68 °C silent error → <0.011 °C.** The solver bisected
  across the Eq. 35 ice/water discontinuity at 0 °C and "converged" onto the
  jump. Each branch is now solved in its own domain, and the genuine
  near-freezing ambiguity (ice wick vs supercooled-water wick) is flagged rather
  than silently resolved. This also closed a self-inconsistency: `wetBulb()` used
  only the over-water form while its own inverse had both branches.

### Added

- Entropy, mixture density, degree of saturation, viscosity and thermal
  conductivity, narrowing the property gap against CoolProp's HAPropsSI.
- `src/core/domain.js` — declares the CoolProp-validated band; the chart shows a
  warning chip when a state point leaves it, and a CI assertion keeps the
  declaration in sync with the oracle grid.
- Vitest suite with per-point oracle assertions against a committed 3,898-point
  CoolProp reference grid; ESLint, `checkJs` typecheck, GitHub Actions CI.
- Toasts and a promise-based confirm replacing `alert()`/`confirm()`; a session
  error log with a copyable panel replacing silent `catch {}` blocks.
- Whole-payload validation before save-file merges; loud storage-quota warnings.
- `src/platform/` adapters (storage, share, saveFile, haptics) as the Capacitor
  seam; safe-area viewport, canvas and tablist ARIA, focus-visible styles.
- `LICENSE` (MIT), `NOTICE` (ASHRAE / CoolProp / three.js attribution), and an
  in-app planning-tool disclaimer.

### Changed

- One 3,881-line `index.html` split into tested ES modules. The ramp planner is
  now pure (state passed in) so it can be unit-tested at all.
- `humidityRatio` takes `(tc, rh, p)` — the dry bulb is required for the
  enhancement factor.
- The service-worker cache name is stamped from version + git SHA at build time,
  replacing the manual `sdc-psychro-vNN` bump the old README required. Users with
  the app open get a "new version ready" toast.
