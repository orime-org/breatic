/**
 * Design-system visual regression — the third leg of the token-governance trio
 * (token single-source + `lint:no-raw-design-values` + this baseline). It
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
import { test, expect } from 'playwright/test';

const PAGES = [
  { name: 'login', path: '/login' },
  { name: 'register', path: '/register' },
  { name: 'primitives', path: '/dev/primitives' },
] as const;

const THEMES = ['light', 'dark'] as const;

for (const theme of THEMES) {
  for (const pg of PAGES) {
    test(`${pg.name} — ${theme}`, async ({ page }) => {
      // Pin the theme before the app boots — it reads `breatic.preferences`
      // from localStorage and applies `html[data-theme]` on mount.
      await page.addInitScript((t) => {
        window.localStorage.setItem(
          'breatic.preferences',
          JSON.stringify({ state: { theme: t }, version: 1 }),
        );
      }, theme);

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
