// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signing up and recovering a password through the real pages (#287).
 *
 * The stack decides the way: with an email backend a sign-up waits for the
 * code mailed to the address and recovery is by email only; without one the
 * account is created at once, a recovery code is shown, and recovery is by
 * that code only. Each case asks the server which way this stack is set up
 * and walks that way. The mailed code goes to a real inbox, so entering the
 * right one is checked by hand with a real address.
 */

import { expect, test, type Page } from 'playwright/test';

import { emailVerification } from '../helpers/signup';

test.use({ storageState: { cookies: [], origins: [] } });

/** An address and password nobody else will hold. */
function freshCredentials(): { email: string; password: string } {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { email: `signup-code-${stamp}@example.test`, password: 'Sm0ke-Signup-Pw!' };
}

/**
 * Fill the sign-up form and send it.
 * @param page - The page on /register.
 * @param email - The address.
 * @param password - The password.
 */
async function submitSignup(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('signing up takes the way this stack is set up, and the code step survives a reload', async ({ page }) => {
  const { email, password } = freshCredentials();
  const withCode = await emailVerification(page.request);
  await page.goto('/register');
  await submitSignup(page, email, password);

  if (!withCode) {
    await expect(page.getByLabel(/I have saved this recovery code/i)).toBeVisible();
    return;
  }

  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();

  // A reload inside the resend wait loses the page, not the sign-up: sending
  // the form again returns to the code step without mailing another code.
  await page.reload();
  await submitSignup(page, email, password);
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();

  // One in a million that this is the mailed code.
  await page.getByLabel('Verification code').pressSequentially('000000');
  await expect(page.getByText('That code is incorrect.')).toBeVisible();
  await expect(page.getByLabel('Verification code')).toHaveValue('');
});

test('the forgot-password page offers only the way back in that works here', async ({ page }) => {
  const withCode = await emailVerification(page.request);
  await page.goto('/forgot-password');

  if (withCode) {
    await expect(page.getByRole('button', { name: 'Email me a reset link' })).toBeVisible();
    await expect(page.getByText(/recovery code/i)).toHaveCount(0);
  } else {
    await expect(page.getByRole('button', { name: 'Use recovery code' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a reset link' })).toHaveCount(0);
  }
});
