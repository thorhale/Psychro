# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The service-worker cache key and the in-app footer stamp both derive from the
`version` field in `package.json` plus the git SHA, so bumping the version is
what rolls an update out to installed apps.

## [Unreleased]

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

### Merged with `main`

`main` had evolved independently. Both deploy models are now supported rather
than one replacing the other, and both test suites survive:

- **The repo root stays directly servable.** GitHub Pages publishes this repo
  raw, so `index.html` and its ES modules must work with no build step. The
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
  of Ch. 1 Eq. 30's constant specific heats: max 0.461 → 0.437 kJ/kg.
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
