// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Registering an account the way the product does it on this stack (#287).
 *
 * With no email backend, `POST /auth/register` creates the account and signs
 * it in. With one enabled, it only mails a six-digit code; the account exists
 * once `POST /auth/register/verify` is sent that code. The code is read from
 * the local Mailpit inbox (`MAILPIT_URL` in the repo-root `.env`), the same
 * place a developer reads it by hand.
 */

import { expect, type APIRequestContext } from 'playwright/test';

import { loadRootEnv } from '../../dev-ports.mjs';

const CODE_PATTERN = /\b(\d{6})\b/;
const POLL_EVERY_MS = 250;
const POLL_FOR_MS = 20_000;

interface MailpitSearch {
  messages?: { ID: string; Created: string }[];
}

interface MailpitMessage {
  Text?: string;
}

/**
 * The Mailpit inbox address from the repo-root `.env`.
 * @returns The inbox URL without a trailing slash.
 * @throws {Error} When email is enabled but no inbox is configured.
 */
function mailpitUrl(): string {
  const url = (loadRootEnv('development', __dirname).MAILPIT_URL ?? '').trim();
  if (url === '') {
    throw new Error(
      'Email is enabled on this stack, so signing up needs the mailed code, and MAILPIT_URL is empty. ' +
        'Start Mailpit (`docker compose up -d mailpit`), point SMTP_* at it and set MAILPIT_URL — see .env.dev.',
    );
  }
  return url.replace(/\/+$/, '');
}

/**
 * Wait for the newest sign-up code mailed to an address after `since`.
 * @param api - Any request context (Mailpit needs no cookies).
 * @param to - The address the code was mailed to.
 * @param since - Only mail that arrived at or after this moment counts.
 * @returns The six digits.
 * @throws {Error} When no such mail arrives within twenty seconds.
 */
export async function readSignupCode(
  api: APIRequestContext,
  to: string,
  since: Date,
): Promise<string> {
  const inbox = mailpitUrl();
  const deadline = Date.now() + POLL_FOR_MS;
  while (Date.now() < deadline) {
    const found = await api.get(`${inbox}/api/v1/search`, {
      params: { query: `to:"${to}"` },
    });
    const newest = ((await found.json()) as MailpitSearch).messages
      ?.filter((m) => new Date(m.Created) >= since)
      .sort((a, b) => b.Created.localeCompare(a.Created))[0];
    if (newest) {
      const message = (await (await api.get(`${inbox}/api/v1/message/${newest.ID}`)).json()) as MailpitMessage;
      const code = CODE_PATTERN.exec(message.Text ?? '')?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  throw new Error(`No sign-up code reached ${to} in Mailpit within ${POLL_FOR_MS / 1000}s.`);
}

/**
 * Create an account and leave `api` signed in as it, whichever way this
 * stack signs people up.
 * @param api - A request context aimed at the app; it keeps the cookies.
 * @param credentials - The address and password to register.
 * @returns Nothing; `api` carries the new session.
 * @throws {Error} When any step is refused.
 */
export async function registerAccount(
  api: APIRequestContext,
  credentials: { email: string; password: string },
): Promise<void> {
  const options = await api.get('/api/v1/auth/options');
  expect(options.ok(), `auth/options answered ${options.status()}`).toBe(true);
  const { emailVerification } = ((await options.json()) as { data: { emailVerification: boolean } }).data;

  const since = new Date(Date.now() - 1000);
  const registered = await api.post('/api/v1/auth/register', { data: credentials });
  const expected = emailVerification ? 202 : 201;
  expect(
    registered.status(),
    `register answered ${registered.status()}: ${(await registered.text()).slice(0, 200)}. ` +
      'A 429 is the ten-an-hour ceiling in config/rate-limits.yaml.',
  ).toBe(expected);
  if (!emailVerification) return;

  const code = await readSignupCode(api, credentials.email, since);
  const verified = await api.post('/api/v1/auth/register/verify', { data: { code } });
  expect(
    verified.status(),
    `register/verify answered ${verified.status()}: ${(await verified.text()).slice(0, 200)}`,
  ).toBe(201);
}
