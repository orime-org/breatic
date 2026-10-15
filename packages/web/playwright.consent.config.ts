/**
 * Playwright config for the consent suite (inner#1442): what the app sends to
 * analytics and advertising services, checked against two builds of the web
 * app at once.
 *
 * The analytics code is switched on at build time, so the suite builds the app
 * twice and serves each build with `vite preview`: once without the vendor
 * variables, as a self-hosted copy ships, and once with test values. The
 * `consent-no-vendors` project runs the cases tagged `@no-vendors` against the
 * first; the `consent` project runs every other case against the second.
 * Both previews proxy `/api` to the backend as the dev server does.
 *
 * The backend is the one already running locally (`pnpm dev`); in CI the
 * suite starts it from its build.
 */
import path from 'node:path';

import { defineConfig, devices } from 'playwright/test';
import { loadRootEnv, resolveDevPort } from './dev-ports.mjs';
import { NO_VENDOR_BUILD_ENV, NO_VENDORS_TAG, VENDOR_BUILD_ENV } from './tests/consent/vendors';

const devPort = resolveDevPort('production', __dirname);
/** The two previews sit just above the dev server's port, so worktrees that offset it stay apart. */
const NO_VENDORS_PORT = devPort + 10;
const VENDORS_PORT = devPort + 11;
const healthPort = loadRootEnv('production', __dirname).SERVER_HEALTH_PORT ?? '3001';

/**
 * Build the app with these variables and serve the build.
 * @param name - Where the build goes, under playwright/.consent.
 * @param port - The port the preview binds.
 * @param vendors - The vendor variables for this build.
 * @returns The web server entry.
 */
function preview(name: string, port: number, vendors: Record<string, string>) {
  // Absolute: vite resolves a relative outDir against its root, which is src/.
  const outDir = path.resolve(__dirname, 'playwright/.consent', name);
  return {
    command: `pnpm exec vite build --outDir ${outDir} --emptyOutDir && pnpm exec vite preview --outDir ${outDir} --port ${String(port)} --strictPort`,
    url: `http://localhost:${String(port)}/login`,
    // Each run builds from the current source.
    reuseExistingServer: false,
    timeout: 300_000,
    // Source maps are uploaded only from release builds.
    env: { ...process.env, ...vendors, VITE_SENTRY_AUTH_TOKEN: '', BROWSER: 'none' } as Record<string, string>,
  };
}

const chrome = { ...devices['Desktop Chrome'] };

export default defineConfig({
  testDir: './tests',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Setup makes one pair of accounts per worker, and sign-in is rate limited per address.
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${String(VENDORS_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node packages/server/dist/index.js',
      cwd: '../..',
      url: `http://localhost:${healthPort}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    preview('no-vendors', NO_VENDORS_PORT, NO_VENDOR_BUILD_ENV),
    preview('vendors', VENDORS_PORT, VENDOR_BUILD_ENV),
  ],
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/, teardown: 'teardown', use: chrome },
    { name: 'teardown', testMatch: /.*\.teardown\.ts/, use: chrome },
    {
      name: 'consent-no-vendors',
      testDir: './tests/consent',
      grep: new RegExp(NO_VENDORS_TAG),
      dependencies: ['setup'],
      use: { ...chrome, baseURL: `http://localhost:${String(NO_VENDORS_PORT)}` },
    },
    {
      name: 'consent',
      testDir: './tests/consent',
      grepInvert: new RegExp(NO_VENDORS_TAG),
      dependencies: ['setup'],
      use: chrome,
    },
  ],
});
