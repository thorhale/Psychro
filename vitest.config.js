import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright owns test/e2e (different runner, needs a built dist/ and a
    // browser); Vitest owns everything else.
    include: ['test/**/*.test.js'],
    exclude: ['test/e2e/**', 'node_modules/**'],
  },
});
