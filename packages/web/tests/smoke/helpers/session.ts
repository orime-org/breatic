// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signing the smoke account in, once for the whole run.
 *
 * Twenty-seven of the twenty-nine specs under `tests/smoke/` need a signed-in
 * browser, and each used to fill the login form itself. Logging in is rate limited — `config/rate-limits`
 * allows five per minute and the limiter keys on the caller's IP address, so
 * every spec in the run draws on one bucket. Twenty-seven specs each spending a
 * login means the suite runs permanently against that ceiling: whichever spec
 * happens to land in a crowded minute is answered "Too many requests" at its
 * login form and fails somewhere that says nothing about what it was testing.
 *
 * So the run signs in once and keeps the cookies. Playwright gives each spec a
 * fresh context, and a fresh context has no cookies; handing it the ones from
 * the first login puts it on the same server-side session, which is what
 * `storageState` does for a suite that has a single account. The config runs
 * one worker, so this module is one instance for the whole run.
 *
 * Cookies are kept per account: a suite with a second account spends one login
 * for each, not one per spec.
 */
import { expect, type BrowserContext, type Page } from 'playwright/test';

/** One cookie, as the browser context hands it over and takes it back. */
type StoredCookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];

/** The cookies each address was last signed in with, for the life of the run. */
const sessions = new Map<string, StoredCookie[]>();

/**
 * Fill the login form and wait for the app to take over.
 * @param page - The page to sign in.
 * @param email - The account's address.
 * @param password - That account's password.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function fillLoginForm(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await expect(page.locator('#login-email')).toBeVisible({ timeout: 20_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  // Read the answer to the sign-in itself. The refusal this module exists to
  // avoid arrives as a 429, and waiting on the URL alone turns it into a
  // navigation timeout that says nothing about why the page stayed put.
  const [answer] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/login'), {
      timeout: 20_000,
    }),
    page.locator('form button[type="submit"]').click(),
  ]);
  if (!answer.ok()) {
    const said = await answer.text().catch(() => '');
    throw new Error(`sign-in refused (${answer.status()}): ${said.slice(0, 200)}`);
  }
  await page.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
}

/**
 * Sign a page in, spending a login only when there is no live session to reuse.
 *
 * Replayed cookies are checked rather than trusted: a session dies when
 * somebody signs out, when the server restarts its store, or when it expires.
 * The server is the one that knows, so it is the one asked, and a session it
 * has forgotten costs a real login — a suite that signs out still works and
 * simply pays for it once.
 * @param page - A page whose context has not been signed in yet.
 * @param email - The account's address.
 * @param password - That account's password.
 * @throws {Error} When the server refuses the sign-in, or the app never leaves
 *   the login route.
 */
export async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const kept = sessions.get(email);
  if (kept !== undefined) {
    await page.context().addCookies(kept);
    // Ask the server whether the session is still its own, rather than reading
    // the URL after a navigation: `goto` resolves on `load`, while the app
    // decides where an unauthenticated visitor belongs once `/auth/me` has
    // answered, which is later. The URL at that moment is always the one asked
    // for, so a session the server has forgotten reads as a live one.
    const live = await page.request
      .get('/api/v1/auth/me')
      .then((r) => r.ok())
      .catch(() => false);
    if (live) return;
    sessions.delete(email);
  }
  await fillLoginForm(page, email, password);
  sessions.set(email, await page.context().cookies());
}

/**
 * Sign out through the account menu, the way a person does.
 *
 * Signing out invalidates the session server-side, so the cookies kept for
 * this address are dead from here on and are dropped: leaving them would hand
 * the next spec a session the server has already forgotten.
 * @param page - The signed-in page.
 * @param email - The address being signed out, whose cookies are dropped.
 * @throws {Error} When the sign-out never reaches the login route.
 */
export async function signOut(page: Page, email: string): Promise<void> {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Account' }).click();
  const menu = page.locator('[data-testid="account-menu"]');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu
    .getByRole('menuitem', { name: /sign out|登出|退出|로그아웃|ログアウト/i })
    .click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
  sessions.delete(email);
}
