/**
 * Vitest owns the physics suites in `test/*.test.js`.
 *
 * Playwright owns `test/e2e/*.spec.mjs` and is driven by playwright.config.mjs.
 * Without this exclusion vitest globs those files too and dies on
 * `test.describe()`, which Playwright only allows under its own runner.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    exclude: ['test/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
