/**
 * Vitest owns the physics suites in `test/*.test.js`.
 *
 * Playwright owns `test/e2e/**` — a different runner, needing a built artifact
 * and a browser — and is driven by playwright.config.js. Without the exclusion
 * vitest globs those files too and dies on `test.describe()`, which Playwright
 * only allows under its own runner. `dist/` is excluded because the built
 * bundle inlines the app's whole module graph and would be scanned twice.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
