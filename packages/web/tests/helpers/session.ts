// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Changing who is signed in, in a browser that is already signed in.
 *
 * No case needs this to get started: setup signs both accounts in once and the
 * config hands every project the cookies, so a page opens signed in. What is
 * left is the one question that can only be asked by swapping accounts inside
 * one browser — whether one account's stored strip reaches the next account's
 * — and that cannot be answered by building a second context, because the
 * storage under test belongs to the first one.
 *
 * Every spec used to fill this form itself, and logging in is rate limited to
 * five a minute keyed on the caller's address, so a suite of twenty-seven
 * specs ran permanently against that ceiling and whichever one landed in a
 * crowded minute was answered "Too many requests" at its login form.
 */
import { expect, type Page } from 'playwright/test';

/**
 * Sign in through the login form, the way a person does.
 * @param page - The page to sign in.
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
  await page.goto('/login');
  await expect(page.locator('#login-email')).toBeVisible({ timeout: 20_000 });
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill(password);
  // Read the answer to the sign-in itself. A refusal arrives as a status code,
  // and waiting on the URL alone turns it into a navigation timeout that says
  // nothing about why the page stayed put.
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
 * Sign out through the account menu, the way a person does.
 * @param page - The signed-in page.
 * @throws {Error} When the sign-out never reaches the login route.
 */
export async function signOut(page: Page): Promise<void> {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Account' }).click();
  const menu = page.locator('[data-testid="account-menu"]');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByTestId('account-menu-sign-out').click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });
}
