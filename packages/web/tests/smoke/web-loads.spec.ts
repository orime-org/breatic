/**
 * Web entry smoke — verifies the app boots without console errors
 * after F1 (Yjs schema v13 audit fields + edge.isPrimary).
 *
 * Scope is intentionally narrow: navigate to root, wait for React to
 * mount, capture all console errors / page errors. Anything thrown
 * during boot would surface here even without an authenticated session.
 *
 * The deeper "create node, inspect Yjs" path requires auth + a real
 * project — that's covered by the round-trip script in /tmp/f1-smoke.mjs
 * and by the human smoke checklist in PR #52.
 */
import { test, expect } from 'playwright/test';

test('app boots without console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('/');
  // Vite/React mount + initial render. Use a generous wait because
  // dev mode pre-bundles deps lazily and the first navigation can be slow.
  await page.waitForLoadState('networkidle', { timeout: 20_000 });

  // Filter known noise: react-devtools nag, sourcemap 404s in dev,
  // beacon/health-check 401 etc. Keep this list conservative — anything
  // novel should fail the test so a human looks at it.
  const ignoredPatterns = [
    /Download the React DevTools/,
    /Failed to load resource:.*sourcemap/i,
    /WebSocket connection to .*1234.* failed/i, // Hocuspocus before auth
    /401/,
    /403/,
  ];
  const realConsoleErrors = consoleErrors.filter(
    (e) => !ignoredPatterns.some((p) => p.test(e)),
  );

  expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(
    realConsoleErrors,
    `Unexpected console errors:\n${realConsoleErrors.join('\n')}`,
  ).toEqual([]);
});
