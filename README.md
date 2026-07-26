# Stream Hall Environment Planner

A phone-installable psychrometric tool (ASHRAE TC 9.9) for planning
temperature and humidity moves in data center halls while staying within
SLA envelopes.

This folder is a complete installable web app: `index.html`, `manifest.webmanifest`,
`sw.js` (offline cache), and two icons. Host these five files anywhere and the tool
installs to phones like a native app — Stream icon, fullscreen, works offline.

## Run locally (development)

No build step — it's a single static app.

- **Quick check:** open `index.html` directly in a browser.
- **Full check** (installing, offline mode, and the service worker all require
  an `http(s)` origin, not `file://`): serve the folder with any static server,
  e.g.

  ```
  python3 -m http.server 8080
  ```

  then visit `http://localhost:8080/`.

## Fastest free hosting: GitHub Pages (~10 minutes, once)

1. Create a free account at github.com (skip if you have one).
2. New repository → name it `psychro` → Public → Create.
3. "Uploading an existing file" → drag all 5 files from this folder → Commit.
4. Repo Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save.
5. Wait ~2 minutes. Your app is live at:  `https://YOURUSERNAME.github.io/psychro/`

## Installing on a phone (you and coworkers)

**Android (Chrome):** open the link → Chrome shows an "Install app" prompt
(or menu ⋮ → *Add to Home screen* → *Install*). Icon appears on the home screen;
launches fullscreen; works with no signal after the first load.

**iPhone (Safari):** open the link → Share button → *Add to Home Screen*.

Share the link with coworkers — each person installs it the same way in ~5 seconds.

## Updating the tool later

Replace `index.html` in the repo and bump the version suffix in `sw.js`'s
`CACHE` constant (currently `sdc-psychro-v14` → next would be `sdc-psychro-v15`).
Installed phones pick up the new version on their next online launch.

## Accuracy

The psychrometric core is validated against **CoolProp 8.0.0** (IAPWS-95 water,
IAPWS-06 ice, ASHRAE RP-1485 moist air) on a 1,521-point grid spanning
0–45 °C, 1–100 % RH and 22–124 kPa. Over 65–125 kPa, where every real site sits:

| Property | Max error vs CoolProp |
|---|---|
| saturation pressure | 0.0071 % (water) · exact (ice) |
| humidity ratio `W` | 0.0041 % |
| dew point | 0.0012 °C |
| wet bulb | 0.0155 °C (within the ASHRAE A1–A4 envelope) |
| enthalpy | 0.011 kJ/kg |
| specific volume | 0.0062 % |

Saturation pressure evaluates the IAPWS reference equations directly rather than
the ASHRAE Eq. 5/6 correlations to them. Enthalpy, specific volume and the
enhancement factor are real-gas, fitted to CoolProp. The app also runs 42
self-tests on every load — tap the badge in the footer to see the table.

`validation/` holds the scripts that derive every fitted coefficient and
reproduce every number above, plus the committed reference data. See
[`validation/README.md`](validation/README.md). It is **development-only** — the
deployed app is still just the five files listed at the top, and the validation
folder does not need to be hosted.

## Notes

- Saved scenarios and custom cities live on each person's own device (browser
  storage). Use the in-app **Export scenarios** button to hand someone a setup file.
- No data leaves the phone — the app makes zero network calls after install.

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
