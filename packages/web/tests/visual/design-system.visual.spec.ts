/**
 * Design-system visual regression — the third leg of the token-governance trio
 * (token single-source + `breatic/no-raw-design-values` + this baseline). It
 * freezes the migrated design system as a screenshot baseline so any future
 * visual drift is caught automatically, not by eye.
 *
 * Targets the no-auth routes that exercise the design system end to end:
 *   - /dev/primitives   the component gallery (every primitive)
 *   - /login /register  the real auth-module pages
 * in both light and dark themes. The authed studio / project surfaces compose
 * these same locked components + tokens, so they are covered transitively
 * (and verified by the human smoke pass).
 *
 * Runs against the external dev server (http://localhost:8000, `pnpm dev`):
 *   pnpm test:visual          compare against the committed baseline
 *   pnpm test:visual:update   regenerate the baseline (after an INTENDED change)
 */
import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

const PAGES = [
  { name: 'login', path: '/login' },
  { name: 'register', path: '/register' },
  { name: 'primitives', path: '/dev/primitives' },
] as const;

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const pg of PAGES) {
    test(`${pg.name} — ${theme}`, async ({ page }) => {
      // Pin the theme before the app boots — it reads `breatic.theme`
      // from localStorage and applies `html[data-theme]` on mount.
      await page.addInitScript((t) => {
        window.localStorage.setItem('breatic.theme', t);
      }, theme);

      // Only this machine is reached. Google's sign-in script comes from the
      // public internet and the button it draws depends on whether it
      // arrived; refused, the login page always shows its failure line.
      await page.route(
        (url) => url.hostname !== 'localhost' && url.hostname !== '127.0.0.1',
        (route) => route.abort(),
      );
      await page.goto(pg.path);
      await page.waitForLoadState('networkidle', { timeout: 20_000 });
      // Wait for web fonts (self-hosted Inter) so glyph rendering is stable.
      await page.evaluate(() => document.fonts.ready);

      await expect(page).toHaveScreenshot(`${pg.name}-${theme}.png`, {
        fullPage: true,
      });
    });
  }
}
