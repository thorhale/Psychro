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

## Notes

- Saved scenarios and custom cities live on each person's own device (browser
  storage). Use the in-app **Export scenarios** button to hand someone a setup file.
- No data leaves the phone — the app makes zero network calls after install.
