# Stream Hall Environment Planner

A phone-installable psychrometric tool (ASHRAE TC 9.9) for planning temperature
and humidity moves in data center halls while staying within SLA envelopes.

The physics core is validated point-by-point against
[CoolProp](https://coolprop.org) (ASHRAE RP-1485 real-gas model) — worst-case
humidity-ratio deviation across the whole operating envelope is 0.0013 %. See
[`docs/coolprop-comparison.md`](docs/coolprop-comparison.md) for the full
comparison and measured accuracy table, regenerated in CI on every push.

## Layout

```
index.html            app shell (markup + styles) — served raw by GitHub Pages
manifest.webmanifest  PWA assets, unhashed at the root so raw serving and the
icon-*.png            service-worker precache list both resolve them
sw.js                 offline cache; its key is stamped per build
StreamHallPlanner.html  committed single-file build — the app's own download
src/core/             tested physics: psychro, derive, envelopes, planner, domain, units
src/config/           site catalog + branding
src/state/            save-file schema + storage migration (v4/v3/v1)
src/app/              UI wiring, chart, self-test, PWA plumbing
src/ui/ src/lib/      toasts/dialogs, error log
src/platform/         storage / share / file / haptics adapters (web + Capacitor)
test/                 Vitest suites + committed CoolProp reference grid
test/e2e/             Playwright specs + committed chart goldens
scripts/              accuracy analyzer, coefficient fitters, bundle verifier
android/ ios/         Capacitor projects (wrap the same dist/)
docs/store/           listing copy, privacy answers, signing guide
blockworld/           independent bonus voxel game (untouched by the build)
```

## Develop

```bash
npm ci
npm run dev            # live-reload dev server
npm test               # 309 tests: oracle, invariants, consistency, assets, schema, platform
npm run lint
npm run typecheck
npm run analyze        # per-property accuracy table vs CoolProp
npm run build
npm run verify:bundle  # 46 artifact-integrity checks
npm run e2e            # 184 Playwright tests across all three artifacts
```

`npm run e2e` deliberately tests shipped artifacts, never the dev server. It
runs two Playwright projects against one static server rooted at the repo:
`raw` (the repo root served without a build) and `built`
(`dist/index.html`), plus `StreamHallPlanner.html` opened over `file://`. The
behaviour suite runs under both projects, so the artifacts cannot drift apart
without failing. Use `npm run test:e2e` to build the artifacts first, or
`npm run e2e` on its own if they are already current.

## Build & deploy

```bash
npm run build      # → dist/
```

`dist/` keeps the original drop-anywhere story: `index.html` is a **single
self-contained file** (all JS/CSS inlined), alongside `sw.js`,
`manifest.webmanifest`, and the icons. Host the folder on any static host.

Merges to `main` deploy to GitHub Pages automatically, behind the full gate —
lint, typecheck, every test, the accuracy report, bundle verification and E2E all
have to pass before anything publishes, and the job deploys the exact artifact it
verified rather than rebuilding. One-time setup by a repo admin:

> Settings → Pages → Source: **GitHub Actions**

To publish by hand instead, copy the contents of `dist/` to wherever you serve
from; the app is live at `https://YOURUSERNAME.github.io/psychro/`.

The service-worker cache name is stamped from the package version + git SHA at
build time, so **updates roll out automatically** — no more manual cache-version
bumps. Users with the app open get a "new version ready — reload" toast.

## Installing on a phone

**Android (Chrome):** open the link → "Install app" prompt (or ⋮ → *Add to Home
screen*). Launches fullscreen, works with no signal after the first load.

**iPhone (Safari):** open the link → Share → *Add to Home Screen*.

## Native apps (iOS + Android)

`android/` and `ios/` are committed Capacitor projects that wrap the same
`dist/` the web app deploys — there is one build artifact, not two.

```bash
npm run build && npx cap sync   # push web assets into both projects
npx cap open android            # Android Studio
npx cap open ios                # Xcode (macOS only)
```

Platform differences live entirely behind `src/platform/`, chosen at runtime by
bridge detection, so no UI code imports a Capacitor package. Storage is a
write-through cache: reads stay synchronous from localStorage, writes mirror to
Capacitor Preferences, and boot restores localStorage from Preferences — which is
what survives iOS evicting WebView storage from an app left unused.

Both projects build today without credentials; CI produces an unsigned Android
debug APK and compiles the iOS project with signing disabled. Everything needed
to ship to the stores — listing copy, both privacy questionnaires, signing steps
and secrets — is in [`docs/store/`](docs/store/).

## Swapping the branding

Naming and colours live in one file, `src/config/brand.js`, and the palette is
**sampled from the artwork** rather than typed beside it:

```bash
# drop new logo files into assets/, then
npm run brand:sample              # report what the images contain
npm run brand:sample -- --write   # rewrite the palette in src/config/brand.js
```

The sampler decodes the PNGs (hand-rolled on `node:zlib` — no dependencies),
finds the dominant saturated colour of the mark, and derives the shades plus an
interactive accent from its hue. The accent's saturation and lightness are
fixed rather than sampled, so a logo in any hue still yields something legible
on the dark interface.

Text is swapped by editing `BRAND` in the same file; the markup carries
readable defaults tagged `data-brand="…"` which `applyBrand()` replaces at
boot. `test/brand.test.js` fails if any module starts hardcoding a palette hex
again — which is exactly what made the previous branding config inert.

## Data & privacy

Saved scenarios, halls, SLAs, and custom sites live on each person's own device
(browser storage). Use the in-app **save file** buttons to export/share a
workspace; imports are schema-validated and merge without overwriting local
data. The app makes zero network calls after install.

If device storage is full, the app warns loudly instead of silently dropping
writes — export a save file when you see that warning.

## Validation

- **CI on every push**: lint, typecheck, 309 tests (CoolProp oracle, physical
  invariants over seeded-random states, cross-surface consistency, asset layout,
  storage migration, platform adapters), the accuracy report, 46 bundle-integrity
  checks, and 184 Playwright tests covering all three artifacts — the raw-served
  module tree, the deployed single-file `dist/`, and `StreamHallPlanner.html`
  opened over `file://` — including an offline boot and five chart goldens.
- **In-app**: the footer self-test badge re-runs a 39-case validation from the
  shipped code on every load — tap it for the full table. It runs the same core
  CI validates, so what the badge asserts is what that build computes.
- To regenerate the oracle grid after changing the domain:
  `pip install CoolProp && npm run reference`.
- Contribution rules, including the accuracy contract for `src/core/` changes,
  are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

**This is a planning aid, not a control system.** Verify moves against site
instrumentation before acting.

---

## ⛏️ BlockWorld — bonus creative building game

`blockworld/` is a self-contained Minecraft-style creative building game that
ships alongside this app but is completely independent of it. Fly or walk around
a blocky world, break and place blocks from a palette of 22 materials, and — the
twist — open the **📘 Building Suggestions** menu to follow Lego-style,
step-by-step instructions: glowing "ghost" blocks show exactly where each block
goes, one layer at a time, until you complete the build.

- **Play it:** open `blockworld/index.html` (serve over http, e.g.
  `python3 -m http.server` then visit `/blockworld/`).
- **Controls:** `WASD` move, mouse look, left-click break, right-click place,
  `1`–`9` / wheel to pick blocks, `E` for all blocks, double-tap `Space` (or `F`)
  to fly, `B` for build ideas.
- **Built-in tests:** append `?selftest` to the URL to run the engine's
  self-checks (shown in the browser console and the tab title).
- Uses a vendored copy of [three.js](https://threejs.org) (`blockworld/three.module.min.js`,
  MIT) so it works fully offline, like the rest of this repo. It has its own save
  slot in browser storage and never touches the planner's data.
