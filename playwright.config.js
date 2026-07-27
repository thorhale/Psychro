import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * E2E runs against the BUILT artifact, never the dev server.
 *
 * The thing that ships is `dist/index.html` — a single self-contained file with
 * every module inlined. Testing the dev server would exercise a different asset
 * graph and would not catch a bundling or service-worker regression, which is
 * most of what these tests exist for.
 *
 * Chromium is pre-installed in this environment at PLAYWRIGHT_BROWSERS_PATH; CI
 * installs it explicitly. `executablePath` is only set when that pinned build is
 * present, so a normal `npx playwright install` also works.
 */

const PINNED_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const launchOptions = existsSync(PINNED_CHROMIUM) ? { executablePath: PINNED_CHROMIUM } : {};

export default defineConfig({
  testDir: './test/e2e',
  // The physics is already covered by 111 unit tests; these are slower and
  // order-independent, so run them in parallel but keep CI single-worker for
  // stable screenshot rendering.
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: {
    timeout: 7_000,
    toHaveScreenshot: {
      // Anti-aliasing and font hinting differ slightly between runs; 1 % of
      // pixels absorbs that without hiding a real visual regression.
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Fixed viewport and DPR 1 so screenshots are comparable across machines.
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    launchOptions,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
