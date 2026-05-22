import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    css: true,
    // tests/smoke/ is the Playwright e2e suite (`pnpm test:smoke`); exclude
    // it from vitest so the two runners do not clash on `test()` globals.
    exclude: ['node_modules', 'dist', 'tests/smoke/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
