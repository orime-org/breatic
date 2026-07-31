import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    css: true,
    // tests/smoke/ and tests/visual/ are Playwright suites (`pnpm test:smoke`
    // / `pnpm test:visual`); exclude both from vitest so the two runners do not
    // clash on `test()` globals.
    exclude: ['node_modules', 'dist', 'tests/smoke/**', 'tests/visual/**'],
    // See packages/core/vitest.config.ts for the 5s → 15s rationale.
    testTimeout: 15_000,
    // `pool: 'forks'` + `singleFork: true` — one process for the whole
    // package instead of one per file. Measured on a 12-core machine:
    // turbo runs ten packages at once and each package's vitest then opens
    // its own batch, which peaked at 37 processes and a load average of 26,
    // saturating the machine. The per-file processes were also paying the
    // same fixed cost over and over: setup 93.1s → 2.0s, building the jsdom
    // environment 232.7s → 0.48s, collecting files 66.4s → 4.3s. Wall clock
    // for this package went 52s → 37s, so this is faster as well as
    // cheaper. Isolation stays on: the control run with isolation disabled
    // was 76s with 105 failures, which is both slower and wrong.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      '@web': path.resolve(__dirname, './src'),
      // Mirror vite.config.mts so vitest can resolve `@locales/*.json`
      // imports from src/i18n/locale-bootstrap.ts (and any test that
      // transitively imports it, e.g. via TopBar → LangSwitcher).
      '@locales': path.resolve(__dirname, '../../locales'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
});
