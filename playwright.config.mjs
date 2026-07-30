/**
 * Playwright config for the end-to-end regression suite.
 *
 * Serves the repo root as a static site so the tests exercise the app exactly
 * as GitHub Pages does — raw ES modules, real manifest, real service worker.
 * Vitest owns `test/*.test.js` (physics); Playwright owns `test/e2e`.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    // Service workers must run: installability is part of what we assert.
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CI installs its own browser; sandboxes and dev machines that already
        // have one can point at it with CHROMIUM_PATH instead of re-downloading.
        ...(process.env.CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `npx --yes http-server . -p ${PORT} -c-1 --silent`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
