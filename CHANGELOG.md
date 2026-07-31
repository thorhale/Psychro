# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The service-worker cache key and the in-app footer stamp both derive from the
`version` field in `package.json` plus the git SHA, so bumping the version is
what rolls an update out to installed apps.

## [Unreleased]

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
