// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A referred sign-up, from the promoter's link to a discounted checkout
 * (inner#1868 §14).
 *
 * The promoter is made by scripts: an account through
 * `scripts/seed-smoke-account.ts`, then an approved application and code
 * through `scripts/seed-smoke-promoter.ts`, because applications open only
 * once the promoter terms are published, which no local stack does. The
 * referred account is made through the real sign-up page, since the code is
 * bound at sign-up and an existing account cannot exercise it.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

import { emailVerification, readSignupCode } from '../helpers/signup';

test.use({ storageState: { cookies: [], origins: [] } });

/** The repository root, where the seed scripts run from. */
const REPO_ROOT = resolve(__dirname, '../../../..');

/**
 * Run a seed script with JSON on stdin and parse the JSON it prints.
 * @param script - The script, relative to the repository root.
 * @param input - What to send it.
 * @returns What it printed.
 * @throws {Error} When the script fails, with what it printed.
 */
function seed<T>(script: string, input: unknown): T {
  try {
    const out = execFileSync(
      'pnpm',
      ['exec', 'tsx', '--tsconfig', 'packages/server/tsconfig.json', script],
      { cwd: REPO_ROOT, input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.parse(out.trim().split('\n').at(-1) ?? '') as T;
  } catch (err) {
    const said = (err as { stderr?: string }).stderr?.trim() ?? String(err);
    throw new Error(`${script} failed: ${said.slice(-400)}`);
  }
}

test('a referred sign-up sees its first-period discount in the panel and at checkout @needs-payments', async ({
  page,
  baseURL,
}) => {
  const { hostname } = new URL(baseURL!);
  expect(
    ['localhost', '127.0.0.1', '[::1]'].includes(hostname),
    'this case creates accounts and a promoter, so it runs against the local stack only',
  ).toBe(true);
  expect(
    await emailVerification(page.request),
    'this case walks the mailed-code sign-up; start the stack with `pnpm dev:mailpit`',
  ).toBe(true);

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { userId } = seed<{ userId: string }>('scripts/seed-smoke-account.ts', {
    email: `promoter-${stamp}@example.test`,
    password: 'Sm0ke-Promoter-Pw!',
  });
  const { code } = seed<{ code: string }>('scripts/seed-smoke-promoter.ts', {
    userId,
    code: `SMK${Date.now().toString(36).toUpperCase()}`,
  });

  // The promoter's link fills the field; the account is bound when it is made.
  const email = `referred-${stamp}@example.test`;
  await page.goto(`/register?ref=${code}`);
  await expect(page.getByLabel('Referral code')).toHaveValue(code);
  const since = new Date(Date.now() - 1000);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Sm0ke-Referred-Pw!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Verification code').pressSequentially(await readSignupCode(page.request, email, since));
  await page.waitForURL('**/choose-slug');
  const studio = await page.request.post('/api/v1/auth/setup-studio', {
    data: { slug: `referred${Math.floor(Date.now() / 1000)}` },
  });
  expect(studio.ok(), `setup-studio answered ${studio.status()}: ${(await studio.text()).slice(0, 200)}`).toBe(true);

  // `config/membership.yaml` gives every local account the self-hosted tier,
  // which offers no plans; the panel is told the account is on the free tier
  // so it draws the card the checkout starts from.
  await page.route('**/api/v1/account/membership', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data: Record<string, unknown> };
    await route.fulfill({ response, json: { ...body, data: { ...body.data, tier: 'base' } } });
  });
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByTestId('account-menu').getByRole('menuitem', { name: 'Membership' }).click();
  await expect(page.getByText(`Referral code ${code}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('20% off first period')).toBeVisible();

  // The Stripe sandbox page names the coupon the server attached.
  await page.getByTestId('membership-choose-pro').click();
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 30_000 });
  await expect(page.getByText('Referral: 20% off first period')).toBeVisible({ timeout: 30_000 });
});
