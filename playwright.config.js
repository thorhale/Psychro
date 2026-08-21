/**
 * End-to-end configuration — one server, two artifacts.
 *
 * The app is handed to people in two forms and they have drifted apart before:
 *
 *   `raw`   — the repo root served as static files: real ES modules, real
 *             manifest, real service worker, no bundler in the path. This is
 *             how local preview and any build-less static host run the app.
 *   `built` — `dist/index.html`, the single self-contained file produced by
 *             `npm run build`, where every module is inlined.
 *
 * Both are served by ONE static server rooted at the repo, because `dist/` is a
 * subdirectory of it — so `built` is just a different baseURL, not a second
 * webServer that could drift in its own configuration. `artifacts.spec.js`
 * additionally opens `StreamHallPlanner.html` over `file://` to prove the
 * shareable download works with no server at all.
 *
 * `app.spec.js` runs under BOTH projects: the behaviour contract is the same
 * whichever artifact you were handed, and asserting it twice is what keeps them
 * from diverging. Visual goldens are pinned against `built` only — one artifact
 * is enough to catch a chart regression, and the two render identically anyway.
 *
 * Vitest owns `test/*.test.js` (physics); Playwright owns `test/e2e`.
 */
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = 4173;
const ROOT = `http://127.0.0.1:${PORT}`;

/**
 * Chromium resolution, in priority order: an explicit CHROMIUM_PATH, the build
 * pinned in this sandbox image, then whatever `npx playwright install` put in
 * place. CI takes the last branch.
 */
const PINNED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const executablePath =
  process.env.CHROMIUM_PATH || (existsSync(PINNED_CHROMIUM) ? PINNED_CHROMIUM : undefined);
const launchOptions = executablePath ? { executablePath } : {};

/** Fixed viewport and DPR 1 so screenshots are comparable across machines. */
const chromium = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  launchOptions,
  trace: 'retain-on-failure',
  screenshot: 'only-on-failure',
  // Installability is part of what we assert, so workers must actually run.
  serviceWorkers: 'allow',
};

export default defineConfig({
  testDir: './test/e2e',
  // The physics already has 111 unit tests; these are slower and
  // order-independent, so run them in parallel — but keep CI single-worker so
  // screenshot rendering is stable.
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  // Goldens are keyed by platform only, NOT by project: the chart must look the
  // same in every artifact, so a single set of images is the stricter contract.
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-{platform}{ext}',
  expect: {
    timeout: 7_000,
    toHaveScreenshot: {
      // Anti-aliasing and font hinting differ slightly between runs; 1 % of
      // pixels absorbs that without hiding a real visual regression.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  projects: [
    {
      name: 'raw',
      testMatch: ['app.spec.js', 'artifacts.spec.js', 'cdu.spec.js', 'launcher.spec.js'],
      use: { ...chromium, baseURL: `${ROOT}/` },
    },
    {
      name: 'built',
      // perf budgets run against the DEPLOYED artifact — the thing an
      // operator actually loads — and only there, so they are measured once.
      testMatch: ['app.spec.js', 'visual.spec.js', 'perf.spec.js', 'cdu.spec.js', 'launcher.spec.js'],
      use: { ...chromium, baseURL: `${ROOT}/dist/` },
    },
  ],
  webServer: {
    // `-c-1` disables caching: a stale 304 would let a rebuilt dist/ be tested
    // as its predecessor, which is the one failure this suite must never have.
    command: `npx --yes http-server . -p ${PORT} -c-1 --silent`,
    url: `${ROOT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
