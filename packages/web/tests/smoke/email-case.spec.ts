// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One mailbox is one account through the real pages (#288): an address typed
 * in another case signs in to the account it names, and cannot open a second
 * account for the same mailbox.
 */

import { expect, test } from 'playwright/test';

import { registerAccount } from '../helpers/signup';

test.use({ storageState: { cookies: [], origins: [] } });

const PASSWORD = 'Sm0ke-Case-Pw!';

/** A lower-case address nobody else holds, and the way a reader might type it. */
function freshAddress(): { stored: string; typed: string } {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const stored = `email-case-${stamp}@example.test`;
  return { stored, typed: stored.toUpperCase() };
}

test('an address typed in another case signs in to the account it names', async ({ page, playwright, baseURL }) => {
  const { stored, typed } = freshAddress();
  const api = await playwright.request.newContext({ baseURL });
  await registerAccount(api, { email: stored, password: PASSWORD });
  await api.dispose();

  await page.goto('/login');
  await page.getByLabel('Email').fill(typed);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/(studio|choose-slug)(\/|$|\?)/);
});

test('an address typed in another case cannot open a second account', async ({ page, playwright, baseURL }) => {
  const { stored, typed } = freshAddress();
  const api = await playwright.request.newContext({ baseURL });
  await registerAccount(api, { email: stored, password: PASSWORD });
  await api.dispose();

  await page.goto('/register');
  await page.getByLabel('Email').fill(typed);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByText('Email already registered')).toBeVisible();
  await expect(page).toHaveURL(/\/register/);
});
