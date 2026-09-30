// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Registering an account through the API (#287).
 *
 * With no email backend, `POST /auth/register` creates the account and signs
 * it in. With one enabled, it only mails a six-digit code to a real inbox,
 * which the suite cannot read, so registering is refused here with a message
 * saying which stack to run it on.
 */

import { expect, type APIRequestContext } from 'playwright/test';

/**
 * Whether this stack signs people up with a mailed code.
 * @param api - A request context aimed at the app.
 * @returns `true` when an email backend is enabled.
 */
export async function emailVerification(api: APIRequestContext): Promise<boolean> {
  const res = await api.get('/api/v1/auth/options');
  expect(res.ok(), `auth/options answered ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: { emailVerification: boolean } }).data.emailVerification;
}

/**
 * Create an account and leave `api` signed in as it.
 * @param api - A request context aimed at the app; it keeps the cookies.
 * @param credentials - The address and password to register.
 * @returns Nothing; `api` carries the new session.
 * @throws {Error} When the stack mails a sign-up code, or registering is refused.
 */
export async function registerAccount(
  api: APIRequestContext,
  credentials: { email: string; password: string },
): Promise<void> {
  if (await emailVerification(api)) {
    throw new Error(
      'This stack has an email backend, so a new account needs the code mailed to a real inbox. ' +
        'Run the cases that register accounts on a stack with EMAIL_BACKEND=disabled.',
    );
  }
  const registered = await api.post('/api/v1/auth/register', { data: credentials });
  expect(
    registered.status(),
    `register answered ${registered.status()}: ${(await registered.text()).slice(0, 200)}. ` +
      'A 429 is the ten-an-hour ceiling in config/rate-limits.yaml.',
  ).toBe(201);
}
