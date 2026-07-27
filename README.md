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
index.html            app shell (markup + styles)
src/core/             tested physics: psychro, envelopes, planner, domain guards, units
src/config/           site catalog + branding
src/state/            save-file schema, validation, migrations
src/app/              UI wiring, chart, self-test, PWA plumbing
src/ui/ src/lib/      toasts/dialogs, error log
src/platform/         storage / share / file adapters (Capacitor-ready seam)
test/                 Vitest suite + committed CoolProp reference grid
scripts/              accuracy analyzer + coefficient fitters
blockworld/           independent bonus voxel game (untouched by the build)
```

## Develop

```bash
npm ci
npm run dev        # live-reload dev server
npm test           # 52 tests incl. 3,898-point CoolProp oracle
npm run lint
npm run typecheck
npm run analyze    # per-property accuracy table vs CoolProp
```

## Build & deploy

```bash
npm run build      # → dist/
```

`dist/` keeps the original drop-anywhere story: `index.html` is a **single
self-contained file** (all JS/CSS inlined), alongside `sw.js`,
`manifest.webmanifest`, and the icons. Host the folder on any static host —
GitHub Pages works as before:

1. Repo Settings → Pages → deploy from branch, folder `/ (root)` of a branch
   containing the *built* files (or use an Actions deploy of `dist/`).
2. Your app is live at `https://YOURUSERNAME.github.io/psychro/`.

The service-worker cache name is stamped from the package version + git SHA at
build time, so **updates roll out automatically** — no more manual cache-version
bumps. Users with the app open get a "new version ready — reload" toast.

## Installing on a phone

**Android (Chrome):** open the link → "Install app" prompt (or ⋮ → *Add to Home
screen*). Launches fullscreen, works with no signal after the first load.

**iPhone (Safari):** open the link → Share → *Add to Home Screen*.

The `src/platform/` adapter layer is the seam for the next step — wrapping the
app with Capacitor for real App Store / Play Store distribution. The web
implementations (localStorage, Web Share, blob download) swap for
`@capacitor/preferences`, `@capacitor/share`, `@capacitor/filesystem` behind the
same function signatures, with no UI changes.

## Data & privacy

Saved scenarios, halls, SLAs, and custom sites live on each person's own device
(browser storage). Use the in-app **save file** buttons to export/share a
workspace; imports are schema-validated and merge without overwriting local
data. The app makes zero network calls after install.

If device storage is full, the app warns loudly instead of silently dropping
writes — export a save file when you see that warning.

## Validation

- CI (GitHub Actions): lint, typecheck, unit tests, CoolProp oracle grid,
  accuracy report, and a build sanity check on every push.
- In-app: the footer self-test badge re-runs a 30-case validation from the
  shipped code on every load — tap it for the full table.
- To regenerate the oracle grid after changing the domain:
  `pip install CoolProp && npm run reference`.

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
