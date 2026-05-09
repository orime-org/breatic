/**
 * Playwright config — minimal headless smoke for the web app.
 *
 * Smoke tests target the running dev server at http://localhost:8000
 * (managed externally — `pnpm dev` from the repo root). The config
 * doesn't spawn a webServer because dev is part of the developer
 * loop, not the test loop, and overlapping vite instances would
 * fight over ports.
 */
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
