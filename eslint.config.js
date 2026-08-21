import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: [
      'src/**/*.js',
      'test/**/*.js',
      'scripts/**/*.mjs',
      // Config and E2E files are Node-side; they need the Node globals too.
      '*.config.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The UI code renders trusted, locally-generated strings into innerHTML by
      // design (no network, no third-party content) — but keep eval-family off.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      'blockworld/',
      // Imported byte-for-byte from thorhale/cdu-sim and deliberately not
      // reformatted: it is one self-contained ES5 file that is its own source
      // and its own build output. Its quality gate is its own invariant sweep,
      // `npm run validate:cdu`, which CI runs — not this config's `no-var`.
      'cdu/',
      'psychro-demo.html',
      // Native projects hold a COPY of the built web assets plus Capacitor's own
      // generated bridge files. Both are build output, not source.
      'android/',
      'ios/',
      'playwright-report/',
      'test-results/',
      // The shareable single file is generated: every module inlined into one
      // <script>. Linting it lints the same source twice.
      'StreamHallPlanner.html',
    ],
  },
];
