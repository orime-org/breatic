// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signing out of other devices closes what they have open (inner#1548).
 *
 * One account on two devices, both inside the same Project. Device one picks
 * "Sign out of other devices" in the account menu and confirms. Device two's
 * canvas loses its connection at once and offers to sign in again; reloading
 * takes it to the sign-in page. Device one stays signed in and connected.
 *
 * The account is made here: this ends every other session of the account,
 * and the shared smoke accounts' stored sessions are what the other cases
 * open with.
 */

import { expect, request, type APIRequestContext } from 'playwright/test';
import crypto from 'node:crypto';
import { test } from '../helpers/slot';

import { registerAccount } from '../helpers/signup';
import { signIn } from '../helpers/session';

/**
 * Credentials nobody else will hold.
 * @returns A fresh email and password.
 */
function freshCredentials(): { email: string; password: string } {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { email: `logout-others-${stamp}@example.test`, password: 'Sm0ke-Logout-Pw!' };
}

/**
 * Register an account with a personal studio and one canvas Project.
 * @param api - A request context that keeps the new session.
 * @param made - The credentials.
 * @returns The Project's id.
 */
async function accountWithProject(api: APIRequestContext, made: { email: string; password: string }): Promise<string> {
  await registerAccount(api, made);
  const slug = `logoutothers${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 1e4)}`;
  const studio = await api.post('/api/v1/auth/setup-studio', { data: { slug } });
  expect(studio.ok(), `setup-studio answered ${studio.status()}`).toBe(true);
  const listed = (await (await api.get('/api/v1/studios')).json()) as { data: { id: string; type: string }[] };
  const studioId = listed.data.find((s) => s.type === 'personal')!.id;
  const made2 = await api.post('/api/v1/projects', {
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    data: { studioId, name: 'Logout others', slug: `logout-others-${Date.now()}`, spaceType: 'canvas' },
  });
  expect(made2.ok(), `create project answered ${made2.status()}`).toBe(true);
  return ((await made2.json()) as { data: { id: string } }).data.id;
}

test.describe('sign out of other devices', () => {
  test('closes the other device and keeps this one', async ({ page, browser, baseURL }) => {
    const { hostname } = new URL(baseURL!);
    expect(
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname),
      'this case registers an account, so it runs against the local stack only',
    ).toBe(true);

    const api = await request.newContext({ baseURL });
    const made = freshCredentials();
    const projectId = await accountWithProject(api, made);

    // Device one: the session the registration opened.
    await page.context().clearCookies();
    await page.context().addCookies(await api.storageState().then((s) => s.cookies));
    await page.goto(`/project/${projectId}`);
    await expect(page.getByTestId('project-page')).toBeVisible({ timeout: 30_000 });

    // Device two: its own sign-in, so its own session.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, made.email, made.password);
    await otherPage.goto(`/project/${projectId}`);
    await expect(otherPage.getByTestId('project-page')).toBeVisible({ timeout: 30_000 });
    await expect(otherPage.locator('.react-flow')).toBeVisible({ timeout: 30_000 });
    await expect(otherPage.getByTestId('connection-banner-relogin')).toHaveCount(0);

    // Device one signs the others out from the account menu on a studio page.
    await page.goto('/studio');
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByTestId('account-menu').getByRole('menuitem', { name: 'Sign out of other devices' }).click();
    const dialog = page.getByTestId('logout-others-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Sign out of other devices' }).click();
    await expect(page.getByText('Signed out of your other devices')).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toBeHidden();

    // Device two: its canvas is refused at once and offers to sign in again.
    await expect(otherPage.getByTestId('connection-banner-relogin')).toBeVisible({ timeout: 5_000 });
    // Its next page load has no session left.
    await otherPage.reload();
    await otherPage.waitForURL(/\/login/, { timeout: 20_000 });

    // Device one: still signed in, and its canvas still connects.
    await page.goto(`/project/${projectId}`);
    await expect(page.locator('.react-flow')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('connection-banner-relogin')).toHaveCount(0);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(200);

    await other.close();
    await api.dispose();
  });
});
