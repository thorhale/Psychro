# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The service-worker cache key and the in-app footer stamp both derive from the
`version` field in `package.json` plus the git SHA, so bumping the version is
what rolls an update out to installed apps.

## [Unreleased]

### Added — steady-state ventilation water on the hall card

Once a hall is holding its Target, humidifier duty is set by the outside-air
ventilation, not the room volume: DOAS dry-air mass × (room moisture −
outdoor moisture). The Data Hall card now takes the DOAS outside-air CFM and
an optional design outdoor dew point, and reports the standing water load in
lb/hr and gal/day, the share of today's humidify capacity it consumes, where
the room would settle with the humidifiers off, and the 1.5–3× utility-water
bleed-off budget for evaporative units.

Leaving the dew point blank assumes bone-dry outdoor air — the worst case no
weather record can beat, so the figure is defensible without one. A design
dew point can only shave that ceiling; the ice-branch saturation curve is
used below freezing. The load is computed at the Target point at site
pressure — and the core tests pin the neat cancellation that makes water per
CFM nearly pressure-independent even though dry-air mass and humidity ratio
each swing well over 15 % between sea level and Denver.

### Added — the CDU tool is site-programmable

The numbers its README said to edit in the source are a panel now: glycol type
(PG/EG) and concentration 0–60 % by mass, facility supply temperature, CDU
design capacity, design approach and loop rises, device count, cold-plate
resistance, die throttle, and both site ΔT targets. Temperatures follow the
°C/°F toggle — absolutes convert, deltas scale.

The plate-pack geometry re-anchors live from the design point, running the
same derivation `tools/cdu_reference.py` ran offline to produce the original
constants; at the default site it reproduces the original `K_GEO` and
`R_WALL` and the published preset table, asserted in the sweep. Presets and
slider ranges scale with the design flows, so a 2 MW unit is not stranded at
a 500 kW slider. The mixture's freeze point is shown, with a warning when the
facility supply comes within 5 K of it. Configuration persists per device; a
corrupted store clamps or falls back rather than half-applying.

Glycol properties are degree-5×5 fits to CoolProp's INCOMP MPG/MEG mixtures
over −10…60 °C × 0–60 % — fits that RECOVER CoolProp's own polynomial model
(~1e-8), pinned against a committed 705-point grid. The validator now sweeps
**370,526 points across three sites** — the default, a MEG-40 cold site, and
water-water at 2 MW — asserting the same invariants everywhere, because a
parameterized model's bugs live where nobody hand-tuned.

Found while testing: editing a site field and clicking a preset in one motion
fired the field's blur-change between mousedown and mouseup, which rebuilt the
preset buttons and made the click silently die — for a person exactly as for
the test. The buttons are built once now and resolve their values at click
time.

### Added — the Branding card: upload a logo, every tool follows

The logo-to-palette feature has existed since the palette was first derived —
as `npm run brand:sample`, a build-time script nobody on a hall floor will
ever run. It was reported missing because it had no button. Now it has one.

A Branding card in the planner takes any image, samples its dominant colour on
a canvas, derives the five-colour palette — primary from the mark's biggest
saturated solid, accent from its hue rotated toward cyan at a fixed saturation
and lightness so ANY logo stays legible on the dark interface — previews the
swatches, and applies on click. The palette persists on the device and is read
at boot by all three pages: the planner through `applyBrand`, the launcher and
the CDU tool through small inline scripts, since those two are deliberately
static and cannot import modules. Reset returns to the built-in brand. Colours
only — names and wording stay put. The logo is read once and never stored.

One derivation, two doors: the sampling moved to `src/config/palette.js` and
the build script now imports it, so the button and the script cannot drift.
The refactored script reproduces the committed palette byte-for-byte, and a
unit test pins the chain — Stream-navy pixels in, the committed PALETTE out.

Only strict `#rrggbb` strings ever reach CSS, and a corrupted store is
rejected wholesale — asserted by a test that plants `url(javascript:x)` in the
key and checks the defaults stand.

### Changed — the CDU tool wears the same skin

Rethemed from its own black/grey tokens onto the planner's ground, surface,
border and text colours, so the dashboard reads as one product. The loop
colours — glycol blue, water green — are semantic, mean fluids rather than
brand, and stay exactly as authored. Its physics constants are untouched and
its 124,488-point sweep still passes.

### Changed — the CDU tool now holds the same accuracy standard as the rest of the app

Its property fits were "max error <0.1 %", and `PH_SEC` sat at **0.0994 %** —
on the line. Refitted to higher degree, every one of the four polynomials is now
within **2.7e-4 %** of CoolProp, which is the band the psychrometric core works
in.

Pinned, not trusted: `cdu/tools/property-reference.json` is a committed CoolProp
grid over 5–65 °C, and `npm run validate:cdu` checks all four fits against it on
every push. No Python, no network — the same bargain the psychrometric oracle
makes. Reverting a coefficient now fails twice, once on drift between the page
and the test core and once on accuracy.

**What it was worth: 0.003 K.** That is the honest measure. Retuning moved every
reported temperature — hottest die, facility return, at design point and at both
extremes of the control envelope — by at most three thousandths of a degree. The
property fits were never this tool's limiting factor and are now three orders
below its first modelling assumption.

### Verified — the CDU physics against a source with no CoolProp in it

Everything in this project traced to CoolProp, which is a single point of
failure for a claim of accuracy. Wolfram is independent, and now cross-checks
two things:

- **The ε–NTU relation, symbolically.** The Cr→1 limit really is `NTU/(1+NTU)`,
  which is the closed form the model swaps to; ε rises monotonically with NTU
  for all `0<Cr<1`; and the swap at `Cr>0.9995` costs at most **2.3e-4** in ε.
- **The facility-loop water properties.** Wolfram's IAPWS `ThermodynamicData`
  agrees with the fitted ρ·c_p to **0.03 %** across 10–50 °C.

The glycol loop could **not** be cross-checked — Wolfram has no aqueous-glycol
mixture data and no second source was available, so it rests on CoolProp alone.
That is a narrower footing than the water side and `docs/provenance.md` says so
rather than implying both were verified equally.

The same doc now carries a CDU section stating what actually limits the tool:
not the arithmetic, but the 3 K design approach, the chevron-plate exponent, the
360 devices at 0.012 K/W and the wall resistance taken as 5 % of the total.
Those are worth whole kelvins.

### Added — a launcher, because the second tool could not be found

The CDU sim shipped as a link in the planner's masthead, and the person it was
built for could not find it. That is a design failure, not a user failure: a
product with two tools needs a front door.

The root is now a launcher — one card per tool, static, no modules, nothing to
fetch. It is also the PWA `start_url`, so the installed app opens there. Both
tools carry a link back to it in the same place, so the way out is muscle
memory; without one the CDU page was a dead end.

**Every existing link still works.** The planner moved to `planner.html`, so
every share URL, QR code and challenge code this app has produced — all of
which point at the root with their state in the hash — would have opened a menu
instead of the hall they encode. The launcher forwards any hash straight
through before the page paints, and an E2E pins that with a real v1 state link.

While repointing the bundle checks: the service-worker precache verifier only
ever looked at the top level of `dist/`, so a nested entry like
`./cdu/index.html` could not be verified at all — it would have passed a
precache list pointing at nothing. It resolves paths properly now.

The launcher repeats the brand tokens as literals because a static page cannot
import `brand.js`. Two copies of a palette is how a product ends up with two
different blues, so a test asserts the copies agree.

### Added — CDU sim, as a second tool

`thorhale/cdu-sim` imported **byte-for-byte** and reachable from the masthead.
It is a steady-state model of a 500 kW direct-to-chip Coolant Distribution
Unit: a PG25 glycol server loop rejecting to a facility chilled-water loop
through a counterflow plate exchanger, solved by ε–NTU for temperature rather
than duty. Liquid cooling is its own problem, so it is its own page rather
than another card on the psychrometric chart.

It lands in `cdu/` alongside `blockworld/` — an independent static mini-app the
build copies through **unprocessed**. That is deliberate and now enforced:
`verify-bundle` asserts the shipped copy is byte-identical to the source and
carries no external references, because the file is its own source and its own
build output and the whole point is that it stays one offline file.

Its physics keeps its own gate. `npm run validate:cdu` sweeps 124,488
operating points — energy balance closes to 5.8e-10 W, no temperature crossing
at either terminal, and the page's constants are checked against the test core
so the two cannot drift — and CI runs it on every push. `cdu/` is excluded from
eslint for the same reason it is excluded from the bundler: reformatting an
imported artefact to satisfy a house `no-var` rule would be the tail wagging
the dog.

Three E2E tests cover what that sweep cannot see: that the link from the
planner reaches it, that the build copied it through intact, that a slider
still moves the answer in the right direction, and that the page makes no
network requests at all.

### Fixed — the Target temperature slider stopped at the SLA's floor

It was pinned to the active contract's band, so on the Recommended profile it
bottomed out at 64.4 °F. That sounds protective and isn't: "how far out of
contract does a chiller failure put me", "what does a free-cooling excursion to
50 °F actually cost" are ordinary questions, and the operator could not even
point at the answer.

Both temperature sliders now run the full 32–130 °F range. The contract is
still on screen three ways — the SLA card's summary line, the polygon drawn on
the chart, and the verdict chip the moment you cross it. Saying you are outside
the SLA is what this tool is for; refusing to let you look there as well was
one mechanism too many.

### Changed — dew point solves its real definition, 60× more accurate

A dew point is the temperature at which *this* air, held at constant humidity
ratio and pressure, saturates: `Ws(tdp, p) = W`. The app inverted the
saturation curve alone instead — `dewPoint(pw(t, rh))` — which drops the
enhancement factor. That factor does not cancel here, because it would be
evaluated at two different temperatures: the dry bulb on one side, the dew
point on the other. Worth **2.285e-2 °C**; solving the real definition brings
it to **3.816e-4 °C**.

The old form is kept as the seed — it is within 0.03 °C everywhere, so a ±1 °C
bracket around it is guaranteed to hold the root.

`rhFromDewPoint` inverts the same relation, so a dew point still round-trips.

### Changed — a dew-point cap is graded at the hall's own pressure

Because a dew point is a property of the air rather than of the contract. The
same temperature and humidity dews out at a different temperature in Denver
than in Goodyear, and the verdict now says so. Temperature and RH bounds are
pure contract terms and stay pressure-free, so a profile only becomes
pressure-sensitive once it carries a dew-point cap — and then only by
hundredths of a degree.

The envelope's dew-point **edge** is now drawn as the saturation humidity ratio
at the cap, which is precisely the quantity `dewPointFrom` inverts. The drawn
boundary and the graded verdict are therefore the same curve by construction,
rather than by a cancellation that happened to work out. (It did work out — the
property test added last week proved it across 900 points — but "provably
identical" beats "measured identical".)

A test asserting SLA verdicts were pressure-independent has been replaced. It
was vacuous: it mapped over four pressures without passing any of them, so it
compared one call against itself four times. In its place, two tests that state
what is actually true — a capless profile grades identically at every pressure,
and a capped one may only disagree for readings sitting within 0.1 °F of the
cap.

### Changed — wet bulb is solved as a real-gas balance, 12× more accurate

ASHRAE Eq. 35 is the closed-form solution of the adiabatic-saturation energy
balance **with ideal-gas enthalpies**: a constant specific heat for dry air, a
linearised vapour term, and no pressure-dependent real-gas mixing. This file
already carries an `enthalpy` fitted point-by-point to CoolProp, so the
balance

    h(t, W) + (W* − W)·h_water(t*) = h(t*, W*)

is now solved numerically with the real thing instead. Against the reference
grid the worst wet bulb goes from **1.87e-2 °C to 1.59e-3 °C**, RMS 4.8e-4 —
for one extra bisection per call, which is nothing next to how often the
answer is read.

`rhFromWetBulb` inverts the same balance, so a psychrometer reading still
round-trips exactly; inverting a *different* equation from the one the forward
solver uses would have let the sensor-validation card grade an instrument
against a reference that disagreed with the chart beside it.

### Changed — the near-freezing wet bulb is reported as an ambiguity, not an error

Within about ±0.6 °C of freezing the balance has two self-consistent
solutions: an ice-covered wick and a supercooled-water wick. Both are real —
two psychrometers in the same air, one frosted and one not, genuinely read
differently — and this solver computes **both to 4e-4 °C**. It returns the ice
root (the stable phase below freezing) and flags `ambiguous`; the new
`wetBulbRoots()` hands back the other.

The accuracy report used to average those 22 points into one headline number,
which read as 0.85 °C of inaccuracy and hid a 12× improvement everywhere else.
They now get their own labelled row, with the count of points it covers. The
oracle test asserts the honest claim: not that our number matches the
reference in that band — nothing could, since which root to report is a
convention — but that we reproduce **whichever root the reference chose**, to
4e-4 °C.

Enthalpy, humidity ratio, specific volume, density and entropy are untouched
and bit-identical.

### Fixed — a pinch could blank the chart

Reported from the floor: the chart "glitched out and stopped showing the
lines". Reproduced and fixed.

Pinching to zoom out until the two fingers **meet** makes the touchscreen
report both contacts at the same coordinate. The zoom factor is the ratio of
the old separation to the new one, so that frame divides by zero, and
Infinity multiplied by a zero-length anchor offset is NaN. The view window
went non-finite, every plotted coordinate came out NaN, and the canvas
painted its background and nothing else — no envelopes, no curves, not even
axes — with no way back except a Fit button nobody knows to look for. (A
pinch that merely *started* with both fingers together was always safe; only
a converging one reached it.)

Three layers of fix, deliberately: the pinch no longer treats a zero
separation as a gesture; `zoomAt` rejects a factor that is not a sane
positive multiplier and refuses to work from a collapsed plot rectangle; and
`clampView` — which every zoom, pan and fit already calls — now resets the
view if any corner has gone non-finite. The last one is what makes the whole
class of bug impossible rather than just this instance of it fixed. Pans go
through it too, which they did not before.

The regression test drives the real gesture and counts pixels that are **not**
the background fill: the pre-existing blank-canvas test measures alpha, and
an all-background canvas is fully opaque, so it never would have caught this.
Against the unguarded code the new test reads 34 drawn pixels where it should
read 957.

### Verified — the drawn contract and the graded contract are the same contract

An accuracy audit of the one shape the tool both draws and grades by two
different routes. `slaPolygon` builds the dew-point edge as a constant-W line
(enhancement factor at the dry bulb, pressure-aware); `checkSLA` inverts the
saturation equation to a dew-point temperature and compares in °F. Equivalent
on paper — `dewPoint()` is a Newton inversion of the same saturation branches
the W-line is built from, and the enhancement factor appears on both sides
and cancels — and now asserted across 900 random points, three real contract
shapes and 70–103 kPa. No divergence. "The chart says I'm inside and the
badge says I'm out" is the most corrosive thing this tool could do, and it
now cannot happen silently.

### Fixed — the Recommended envelope was drawn slightly too wide

ASHRAE TC 9.9 gives the recommended low-moisture limit as **−9 °C dew point
AND 8 % RH** — both constraints, whichever binds. The envelope table carried
`rhMin: 0`, so the lower edge was the dew-point line alone. At sea level the
two all but coincide and nothing moved; at reduced pressure the 8 % RH curve
is the higher of the two, so a point near the warm, dry corner of a
high-altitude hall could be drawn and graded as inside Recommended when the
standard puts it outside. Every SLA preset in the app already used 8 %; this
table was the one place that disagreed with them.

The whole table is now pinned by a test against the published 5th-edition
(2021) numbers, in the SI units the standard is written in and with nothing
converted, so no boundary can pick up a rounding error on the way through a
conversion again. All five envelopes verified: Recommended 18–27 °C /
8–60 % / −9…15 °C DP, A1 15–32 / 8–80 / −12…17, A2 10–35 / 8–80 / −12…21,
A3 5–40 / 8–85 / −12…24, A4 5–45 / 8–90 / −12…24.

### Fixed — plant rates were always read as °F/hr

The standards are metric, the contracts here are stored in °F, and the °C
toggle had reached the SLA editor but not the Data Hall card. Typing `10`
into the cooling rate while reading °C stored 10 **°F**/hr — 5.6 °C/hr — so
a pulldown the plant could do in two hours was predicted at nearly four, with
nothing on screen to say so.

Rates are typed, shown and labelled in the unit on screen now, and converted
as **deltas**: 9 °F/hr is 5 °C/hr, never −12.8. Same fix for the coil
calculator's supply dew point (an absolute temperature), the derived-rate
readouts under "Derive your rates from equipment specs", the saved-scenario
names, and the volume warning. Switching the toggle re-renders the hall card
along with the SLA card.

Nothing about the stored data changed — °F/hr remains canonical on disk, so
existing saves and shared links keep their meaning.

### Added — every hall tab carries its own verdict

A dot on each hall tab: green inside the active SLA, red with a halo outside
it, hollow for a hall nobody has set up yet, and the reason in the tooltip.
The strip you already use to move between halls is the cheapest place in the
app to see which one is out of spec — no card to open, no list to read, and
the hall is one tap away once you have found it.

Each hall is graded at its own elevation and pressure, and the active hall's
dot follows the point on screen rather than the last one saved. The dots are
recoloured in place on every update — the strip is never rebuilt — so
fourteen halls cost nothing per frame.

### Changed — All halls is a building picker

A campus is a list of buildings you walk into, not a flat list of fourteen
halls. With more than one building in view the overview leads with the
buildings; the one you are standing in opens itself and the rest stay closed
until you press them. A closed building still carries its own rollup — "⚠ 1
outside SLA" in red — so collapsing never hides the thing worth walking over
for. With a single building there is no disclosure to press, because it would
be a step that answers nothing.

Rows inside a building drop the building from their name, and on a phone the
verdict now sits beside the hall name instead of stretching across a line of
its own: fourteen halls in three buildings read in about half a screen.

### Fixed — the shipped hall was called "PHX · Hall 1"

A site code the operator never typed, glued onto the name of the only hall
they had, in an app that also offered PHX as a *building*. It read as a
mystery hall in somebody else's building. It ships as "Hall 1"; the site
lives in the site field, where the tab strip and the overview label it
themselves.

### Changed — a hall tab names only what tells it apart

Fourteen tabs reading "Goodyear, AZ · A2 · Hall 1" took five rows and pushed
the only part that differs — the hall's name — off the end of each one. A
facet is printed only when it actually varies across the halls in view, so
one site and one building leaves just "Hall 1", and two buildings gives
"A2 · Hall 1".

### Fixed — hall management on a phone

Reported from the floor, in a screen recording. Four separate problems.

- **Browsing the Location list created halls.** Both filter dropdowns called
  `ensureHallAt()` on change, so scrolling through the site catalog to *look*
  at somewhere left a new hall behind every time — which is how a single
  operator ended up with a campus of fourteen halls nobody asked for.
  Filtering is a view action now and creates nothing; it moves you to the
  first hall that matches instead.
- **There was no way to delete a hall from the list.** Every row in All halls
  carries an ✕ that asks first. Deleting the last one is refused with an
  explanation rather than a disabled button.
- **"+ New hall" put the hall at sea level.** With no location filter set it
  wrote an empty site and 0 ft, so a hall on a 1,066 ft campus computed every
  verdict at 101.3 kPa instead of 97.5 — silently wrong, and wrong in the
  direction that says PASS. A new hall now inherits the site, building,
  elevation and barometer of the hall you added it from, and is numbered
  within its own building.
- **A campus code looked like a building.** "PHX" comes out of the site
  catalog; sitting bare in the Building list next to "A2" it reads as a
  building somebody named and can't be identified. The list is now grouped:
  *Buildings you have named* and *Campus codes from the site list*.

### Fixed — tapping a section threw the page away

Opening the Data Hall card moved its own header 2,383 px off the top of the
screen: the phone stack re-orders cards with CSS `order`, so the browser's
scroll anchoring compensated against DOM order and landed somewhere else
entirely. You tapped a card and arrived nowhere near it, then tapped again to
get back. The header you tap now stays exactly where your finger left it and
the content opens underneath it. Measured in the test suite — the assertion
fails by 2,383 px if the pin is removed.

### Changed — All halls reads at a glance

Fourteen halls took more than two phone screens because every row repeated
the site, the elevation, the pressure and "no plant rates". Facts every
visible hall shares are stated once in a header above the list; rows carry
only what differs, and lead with the building. The list also honours the
Location and Building filters, so the tab strip and the overview can no
longer disagree on screen at the same time.

### Changed — typography and buttons

- **One button, four emphases.** There were four button systems —
  `.scn-btn`, `.sla-tab-btn`, `.sla-tab-add`, `.calc-apply` — with three
  border radii, three font sizes and three paddings between them, so a single
  row of related actions rendered in five visual weights. They now share one
  shape and differ only in emphasis: primary is filled, danger is red, the
  rest are quiet.
- **Field labels are sentence case.** A caps eyebrow works on a two-word
  section title; on "Location sets site + elevation" it is a sentence in a
  raincoat. Two CSS rules existed purely to undo the uppercase on nested
  spans — both gone.
- **Explanatory prose is reference material, not a heading.** The blocks
  inside form cards were near body-text weight and colour, competing with the
  fields they describe. Muted, smaller, and capped at 62 characters a line.
- **Monospace is for columns of figures.** The hall-row meta line mixed a
  place name and a plain-English "no plant rates" with two numbers; the
  numbers were not in a column, so the prose was paying for nothing. The
  condition column across rows *is* aligned, and stays mono.
- **Hover tints come from the brand.** Nine rules used `rgba(59,158,255,…)` —
  a blue in no brand file — so hovering a button changed its hue, not just
  its value. Tints are now `color-mix` against `--brand-accent` and follow a
  brand swap with everything else.

### Changed — field-first layout

The app opens on a phone with a logo, four closed drawers, and the chart —
the entire point — below the fold. Someone standing in a hall opened it to
see where the room is, not to re-enter its elevation.

- **The chart and the sliders come first** on any screen narrower than the
  two-column breakpoint. Setup cards follow; the start-here guide moves to
  the end, since help belongs after the tool rather than in front of it. The
  DOM order is unchanged — this is `order` on a flex stack, so reading order
  for screen readers and the desktop layout both stay as they were.
- **The masthead is a strip, not a billboard.** It stacked company, product
  and tagline on three lines; that was about a quarter of a phone screen
  spent on branding. Now one row, with the tagline dropped below 900 px.
- **The chart card's own chrome shrank.** The two zoom buttons that pinch
  already replaces are hidden on touch, the mouse-only half of the hint is
  hidden where there is no mouse, and the ten-item legend scrolls sideways
  instead of stacking into half a screen.
- **Card summaries are no longer monospaced.** Monospace is for columns of
  digits; on a sentence it reads as log output and costs about 15 % more
  width, which is why those summaries were truncating mid-word.

Net effect on a phone: the chart and all three Current sliders now fit on the
first screen. Colours are unchanged — this is the brand palette from
`src/config/brand.js`, used with more discipline.

### Added — the arithmetic is audited, and the interactive path has budgets

**Every conversion constant is now derived from its definition and checked**
(`test/constants.test.js`). A mistyped ton-to-kilowatt factor produces
plausible capacities that are simply wrong, and no test comparing the app to
itself would ever catch it — so the ton of refrigeration is rebuilt from
12 000 BTU_IT/hr, the cubic foot from the international inch, and so on.
Internal consistency is checked too: MBH is a *thousand* BTU/hr, a ton is
twelve MBH, a litre per second is 3.6 m³/hr.

**The two derived chains are checked against longhand arithmetic**
(`test/energychain.test.js`) — kilowatts installed becoming °F/hr, and airflow
over wet media becoming lb/hr. Each is recomputed a second way with the units
written out, so a missing 3600 or a Kelvin/Fahrenheit mix-up shows as a factor
rather than a nudge. This includes pinning that the app uses the *delta*
temperature conversion, not the absolute one.

**A finding worth knowing:** wetted media at altitude moves *less* water, not
more. Thinner air holds more moisture per kilogram (+10 % here) but a fixed
CFM carries 22 % less mass, and mass flow wins — about 14 % less output at
7 000 ft. A humidifier sized by CFM at sea level under-delivers in Denver,
which is why the app computes it at the hall's own pressure.

**Performance budgets now run in CI** (`test/e2e/perf.spec.js`), measured in a
real browser against the deployed artifact. Current figures: a full update
5.4 ms, a chart pan frame 2.7 ms, boot to interactive 364 ms, and a hall with
twenty equipment units costs no more per frame than an empty one — the
evidence that the single-pass inventory rollup does what it claims.

### Added — branding is swappable, and the palette is sampled from the artwork

There was a `BRAND` config object that nothing imported, while the real hex
codes sat inline in the stylesheet, the toast styles and the PDF renderer.
"Change it here" changed nothing.

- **`src/config/brand.js` is now the single source** for names and colours.
  Every surface reads it: the CSS custom properties, the toast styles, and the
  export and placard canvases, which have no stylesheet to inherit from.
- **`npm run brand:sample`** decodes the logo PNGs and derives the palette from
  them — dominant saturated colour for the primary, its shades, and an
  interactive accent rotated toward cyan at a fixed saturation and lightness so
  any future hue still reads on the dark interface. `-- --write` rewrites the
  palette in place. The PNG decoder is hand-rolled on `node:zlib`; the project
  still carries no runtime dependencies.
- Sampling the current mark gives `#193c76` / `#10a8c6`, within a hair of the
  hardcoded values it replaces — the check that the derivation is sound rather
  than merely automatic.
- **`test/brand.test.js` fails if a module hardcodes a palette hex again**,
  which is the failure mode that made the old config inert.

### Changed — every module under `src/app` is now type-checked

Turning it on surfaced 195 errors, all pre-existing and invisible while the
code sat outside the checker's scope. Two were real:

- A **runtime crash** in the scenario save button, from a variable shadowing
  its own initialiser — introduced by this pass's own rename and caught
  immediately by the check the pass was adding.
- Two **dead comparisons** testing a numeric dew-point cap against `''`.

The rest were typing gaps. `src/ui/dom.js` states element intent once
(`inp` / `el` / `canvasEl`) instead of casting at 90 call sites, `SlaProfile`
is declared so an artifact printing a contract bound is checked against the
field existing, and the Vite build constants are declared for the checker.

### Added — save files carry the whole inventory

The save-file tests used halls with no equipment, so nothing said an imported
plant model kept its condition history, its per-unit derates, or a wetted-media
unit's measured effectiveness. Now pinned, including that unrepairable entries
are dropped without taking the good ones with them.

### Changed — the rest of the planned main.js split

Four more sections out, following the pattern set by the first split:

- **`src/app/chart.js`** (789) — drawing the psychrometric chart *and*
  navigating it. These moved together because they share the view window:
  `view` is what the renderer reads and what zoom, pan and the fit buttons
  write. Splitting them would export that mutable window across a module
  boundary — the same coupling with more ceremony.
- **`src/app/sensor-ui.js`** (771) — the validation forms, the calibration
  logbook and the drift forecast. The save-file merge RULES moved with it,
  because "a duplicate is the same sensor on the same day by the same method"
  belongs with the data it governs, not with the file reader.
- **`src/app/export-ui.js`** (271) — image and PDF artifacts. Everything that
  leaves the app to be read on paper, away from the state that produced it.
- **`src/app/training-ui.js`** (222) — the Envelope Escape Room.

`src/app/main.js` is **2,627 lines**, down from 5,081 at the start of the
split. Each extracted panel imports downward and receives the few
"re-render the rest of the app" callbacks from the entry point.

`dispT1` (°F at one decimal) moved into `src/ui/format.js`, where both the
sensor suite and the trainer can reach it.

### Changed — main.js split into modules

`src/app/main.js` was 5,081 lines holding the whole UI. The first pieces are
out, chosen because they were the ones other pieces kept reaching for:

- **`src/app/state.js`** — the state object. This was the blocker: while it
  lived in main.js, any panel extracted out of main.js had to import back into
  it, and a cycle between an entry point and the things it starts up is a
  boot-order bug waiting for a bad day.
- **`src/ui/format.js`** — display conversion, including the SLA-verdict
  wording. A panel that reaches into the entry point for its formatting is a
  panel that eventually prints a stored °F into a °C interface.
- **`src/ui/escape.js`** — HTML escaping. A panel that has to reach back into
  main.js for its escaping is a panel that will be written without any.
- **`src/app/hallphysics.js`** — the hall's thermal capacitance and current
  moisture, shared by the rate calculator and the inventory so the two can
  never disagree about the mass they act on.
- **`src/app/equipment-ui.js`** — the equipment panel and the all-halls
  overview, 530 lines. Re-rendering the rest of the app belongs to the entry
  point, so main.js injects those few callbacks at boot rather than being
  imported back into.

main.js is 4,507 lines; the import graph now points one way.

### Fixed

- `npm run typecheck` never looked at `src/app` or `src/ui`, so a broken
  import in either was caught only by the end-to-end tests — if at all. The
  extracted modules are now in scope, and the DOM and unit-string types they
  turned up are fixed rather than suppressed.

### Changed — cleanup and optimization pass

- **One walk of the inventory instead of seven.** The equipment panel asked
  totals, nameplate and the redundancy of each of five kinds as separate
  questions, each walking the whole list and each re-running the psychrometrics
  for every wetted-media unit. They all fall out of the same walk, so they now
  share it: a media unit costs one evaluation per render rather than a dozen.
- **Panels only rebuild when their markup changed.** These re-render on every
  slider movement, and most movements change nothing they display — dragging a
  Target slider does not move equipment outputs, which come from the Current
  point. Reassigning innerHTML threw away the DOM and its listeners for
  nothing.
- **Capacity conversions have one home.** Tons, BTU/hr, MBH, GPH, gal/day,
  pints/day, m³/hr and the rest lived in two copies — the inventory and the
  rate calculator — which is a correction waiting to be applied to one and not
  the other. Same for the CFM and cubic-foot conversions, which were inline
  literals beside helpers that already existed.
- The save-file writer stamps the format version from the constant the reader
  checks against, rather than a hardcoded copy of it.

### Added — equipment condition history

The inventory knew a machine's condition today but kept no memory of it, so
"HUM-1 has been fading since spring" was something an operator held in their
head or lost.

- Each unit now keeps its **dated condition readings** (the last twelve), and a
  row whose condition has fallen says how far and since when.
- **One reading per day.** An afternoon spent adjusting a number is one
  observation of one machine, not six, and reading a slope out of that would
  be inventing a decline.
- **Two readings minimum** before anything is drawn — a single number is a
  fact, not a trend.
- **Only falls are called out.** A machine serviced back to full is good news
  and does not need to shout.

### Added — the all-halls overview can see the plant

The overview was blind to the equipment: a hall with two CRAHs tagged out and
scaled humidifier media looked exactly like a healthy one. It is the surface
you scan, so it is where plant trouble belongs.

- Each row now flags **what is out of service and what is degraded** in that
  hall, and the summary counts halls with plant to look at.
- A hall that **cannot survive losing its biggest cooling machine** says so by
  name. Only the failing case is shown — "you can lose one" is not worth
  interrupting a scan for.
- Every hall is graded **at its own condition and pressure**. Wetted media
  makes less water into damper air and less again at altitude, so grading
  Denver's humidifiers with Goodyear's air would have been a quiet,
  plausible-looking lie.

### Fixed

- Typing an IT load updated its own readout but not the cooling rate derived
  from it, the redundancy verdict, or the hall's line in the overview.

### Changed — the inventory now drives the plan, instead of being copied into it

The inventory used to be a display. You could tag a CRAH out, watch the totals
drop, and the plan underneath would carry on using the rate that was applied
days ago — the twin and the planner disagreeing silently, which is the one
failure mode a twin exists to prevent.

- **"Drive the rates below from this inventory"** puts the hall in a live mode:
  cooling, warming, dehumidify, humidify and supply airflow are re-derived from
  the plant on every change. Tag a unit out, drop a condition, add a machine —
  the plan moves with it, with no button to remember.
- **Evaporative output moves with the room**, so a live humidify rate tracks
  the hall condition too, not just edits to the equipment list.
- **Derived rates are shown as outputs**, not empty fields waiting to be typed
  into, and clicking one says where the number comes from.
- **Handing the rates back restores what you typed.** The manual rates are set
  aside when the inventory takes over and put back when you take them back — a
  commissioning-observed °F/hr is a measurement someone made on site, and
  losing it to a mode toggle would be indefensible.
- **A hall's capability follows its plant**: list no humidifiers and the hall
  cannot humidify; add one and it can.
- Halls that predate the inventory are untouched — no inventory means typed
  rates, exactly as before.

### Added — air movement counted as plant, and the "lose one machine" question

- **Fans and air handlers are equipment too.** A new kind alongside cooling,
  heating, dehumidifiers and humidifiers, rated in CFM, m³/hr, m³/min or L/s,
  and derated individually — a loading filter bank, a slipping belt or one
  dead fan in an array all cost airflow, and none of them announce
  themselves. The totals show delivered airflow against nameplate plus air
  changes per hour, and "Apply inventory" now sets the hall's supply airflow
  from what the fans actually deliver rather than the design figure.
- **"Lose one machine — the biggest one that is running."** Every hall is
  built to some N+1 story, and the story is only true while the spare
  capacity is real: four CRAHs at 100 % is N+1, the same four with two at
  70 % may not be. Each kind now reports what the largest in-service machine
  is worth and what would remain without it — taking one machine out of a
  line item, not the whole line. A degraded 50-ton AHU stops being the worst
  thing that can fail once a healthy 30-ton CRAH outproduces it, which is a
  judgement nameplate figures get wrong.
- **Cooling gets graded.** With an IT load on file, the surviving cooling is
  reported as covering it or short of it by a stated number of kW.
- **A single machine is called a single point of failure**, not given a
  redundancy figure of zero that reads like an answer.

### Fixed

- The add-equipment button row could not wrap, so a sixth button was pushed
  outside the card and became unclickable.

### Added — equipment inventory: a hall is now made of countable units

The first step toward a digital twin. A hall used to be four numbers —
cooling, warming, dehumidify, humidify — which describe a capability without
describing the plant that produces it, leaving ordinary questions
unanswerable: *CRAH-3 is out, what can we still do? Two of four humidifiers
have scaled media, how much have we lost?*

- **List the units this hall actually has.** Cooling, heating, dehumidifiers
  and humidifiers, each with a tag, a quantity ("4 × 30 ton"), a capacity in
  whatever unit the schedule uses, and its own condition percentage.
- **Every unit degrades independently.** A unit's % is its condition against
  *its own* nameplate — fouled media, a tired compressor. Separately, a unit
  can be taken **out of service**, which is not a derate: it contributes
  nothing, and when it returns it brings back its own condition rather than a
  fictional 100 %.
- **Totals are always shown against nameplate** — "30.0 of 40.0 lb/hr (75 %)"
  is actionable in a way a bare number is not — with a banner counting what is
  offline or degraded.
- **Wetted-media humidifiers are computed, not rated**, using the evaporative
  physics: their capacity moves with the hall's live condition and pressure,
  so a drier room shows more output from the same equipment.
- **One button derives the hall's four rates from the inventory**, using the
  same thermal-mass conversion the rate calculator uses, so the two can never
  disagree. The manual rates remain for halls that have no inventory yet.

### Added — evaporative humidifier capacity, and the mineral scaling that erodes it

- **Wetted-media humidifiers are now computed, not typed.** A nameplate lb/hr
  is a fiction for evaporative media: the same unit puts out very different
  amounts of water depending on how thirsty the entering air is (~187 lb/hr at
  75 °F/20 % against ~108 lb/hr at 68 °F/45 %, same airflow and media). The
  Data Hall calculator now derives output from airflow across the media, the
  media's saturation effectiveness, and the hall's live condition and pressure,
  using the same validated psychrometrics as everything else.
- **Mineral scaling has a number now.** Saturation effectiveness is exactly
  what deposits destroy — they block wetted surface and channel air past it —
  so it is an operator-set parameter, lowered as media fouls. Enter a
  *measured* output instead and the app back-calculates the effectiveness you
  are really achieving and flags it against the clean figure, turning "the
  humidifier seems weak" into "we are at 62 % of a commissioned 90 %".
- The readout also states that evaporative humidification **cools** the air it
  humidifies, and by how much at the current condition — a load the plan
  should not be surprised by.

### Added — every hall keeps its own working point, and an all-halls overview

- **Each hall remembers the conditions you were working on in it.** Hall
  profiles stored the building — elevation, volume, plant rates — but the
  temperature and humidity you were planning were global, so switching to
  Hall 2 showed Hall 1's numbers and you re-typed them every time. The point
  now belongs to the hall, survives a reload, and rides along in a save file.
- **New "All halls" card**: one row per hall showing its site, elevation and
  site pressure, the move it is set up for, and whether that point is inside
  the active SLA — each judged **at its own pressure**, which is the only
  place the app shows that the same temperature and humidity is not the same
  dew point in Denver as in Goodyear. Rows flag halls with no plant rates
  entered, the summary counts anything outside contract while the card is
  collapsed, and tapping a row switches to that hall.

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
