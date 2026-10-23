// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { emailVerification, readSignupCode, readSignupInvitationLink } from '../helpers/signup';
import { liveModuleUrl } from '../helpers/live-module';

/** An invitation recipient created for one smoke case. */
function recipient(): { email: string; password: string; slug: string } {
  const tag = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  return { email: `invited-${tag}@example.test`, password: 'Sm0ke-Invite-Pw!', slug: `invited-${tag}` };
}

/** Submit an invitation through the real Project share popover. */
async function invite(page: Page, email: string): Promise<Awaited<ReturnType<Page['waitForResponse']>>> {
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByTestId('share-invite-input').fill(email);
  const response = page.waitForResponse((answer) => answer.request().method() === 'POST' && /\/projects\/[^/]+\/invitations$/.test(new URL(answer.url()).pathname));
  await page.getByTestId('share-send-invite').click();
  return response;
}

/**
 * Read the invitation preview from the Query client mounted on this page.
 * @param page - The recipient's registration page.
 * @param moduleUrl - The versioned URL of its already loaded provider module.
 * @param token - The invitation being previewed.
 * @returns The state consumed by the registration page.
 * @throws {Error} When the live module cannot be read.
 */
async function invitationPreviewState(page: Page, moduleUrl: string, token: string): Promise<string | undefined> {
  return page.evaluate(async ({ url, invitationToken }) => {
    const { queryClient } = await import(url) as typeof import('@web/app/providers/QueryClientProvider');
    return queryClient.getQueryData<{ state: string }>(['auth', 'invitation', invitationToken])?.state;
  }, { url: moduleUrl, invitationToken: token });
}

test('an unregistered invitation follows the deployment mail mode and joins after verified registration', async ({ page, browser, baseURL }) => {
  const person = recipient();
  const projectId = smokeProjectId();
  await openSmokeProject(page);
  const enabled = await emailVerification(page.request);
  const invitedSince = new Date(Date.now() - 1000);
  const answer = await invite(page, person.email);
  if (!enabled) {
    expect(answer.status()).toBe(404);
    await expect(page.getByRole('alert')).toBeVisible();
    const pending = await dataOf<{ email: string }[]>(await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations');
    expect(pending.filter((row) => row.email === person.email)).toEqual([]);
    return;
  }
  expect(answer.status()).toBe(201);
  expect(((await answer.json()) as { data: { pendingSignup: boolean } }).data.pendingSignup).toBe(true);
  const invitationLink = await readSignupInvitationLink(page.request, person.email, invitedSince);
  const token = new URL(invitationLink).searchParams.get('invite');
  expect(token).toMatch(/^[a-zA-Z0-9_-]+$/);

  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  let joinedUserId: string | null = null;
  try {
    const recipientPage = await context.newPage();
    await recipientPage.goto(invitationLink);
    await expect(recipientPage.getByLabel('Email', { exact: true })).toHaveValue(person.email);
    await recipientPage.getByLabel('Password', { exact: true }).fill(person.password);
    const codeSince = new Date(Date.now() - 1000);
    await recipientPage.getByRole('button', { name: 'Create account' }).click();
    const code = await readSignupCode(context.request, person.email, codeSince);
    await recipientPage.getByLabel('Verification code').pressSequentially(code);
    await expect(recipientPage).toHaveURL(/\/choose-slug\?next=/);
    expect(new URL(recipientPage.url()).searchParams.get('next')).toBe(`/decision?token=${token}`);
    await recipientPage.getByLabel('Slug', { exact: true }).fill(person.slug);
    await recipientPage.getByRole('button', { name: 'Continue' }).click();
    await expect(recipientPage).toHaveURL(new RegExp(`/decision\\?token=${token}$`));
    await expect(recipientPage.getByRole('heading', { name: 'You\'ve been invited to a Project' })).toBeVisible();
    const me = await dataOf<{ id: string }>(await context.request.get('/api/v1/auth/me'), 'registered invitee');
    const before = await dataOf<{ userId: string; role: string }[]>(await page.request.get(`/api/v1/projects/${projectId}/members`), 'members before confirmation');
    expect(before.filter((member) => member.userId === me.id)).toEqual([]);
    const confirm = recipientPage.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/decisions/respond');
    await recipientPage.getByRole('button', { name: 'Accept', exact: true }).click();
    expect((await confirm).ok()).toBe(true);
    joinedUserId = me.id;
    await expect.poll(async () => {
      const members = await dataOf<{ userId: string; role: string }[]>(await page.request.get(`/api/v1/projects/${projectId}/members`), 'members after confirmation');
      return members.filter((member) => member.userId === me.id).map((member) => member.role);
    }).toEqual(['viewer']);
  } finally {
    try {
      if (joinedUserId !== null) {
        await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/members/${joinedUserId}`), 'remove smoke invitee');
      }
    } finally {
      await context.close();
    }
  }
});

test('the Project share list shows and revokes its email invitation', async ({ page }) => {
  const person = recipient();
  const projectId = smokeProjectId();
  await openSmokeProject(page);
  const enabled = await emailVerification(page.request);
  const answer = await invite(page, person.email);
  if (!enabled) {
    expect(answer.status()).toBe(404);
    await expect(page.getByRole('alert')).toBeVisible();
    return;
  }
  expect(answer.status()).toBe(201);
  await expect(page.getByTestId('share-popover')).toHaveCount(0);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const email = page.getByText(person.email, { exact: true });
  await expect(email).toBeVisible();
  const pending = await dataOf<{ invitationId: string; email: string; awaitingSignup: boolean }[]>(
    await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations');
  const created = pending.find((row) => row.email === person.email);
  expect(created?.awaitingSignup).toBe(true);
  if (!created) throw new Error('The created invitation is missing from its pending list.');
  const row = page.getByTestId(`share-invitation-${created.invitationId}`);
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(email).toHaveCount(0);
  const after = await dataOf<{ invitationId: string }[]>(await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations after revoke');
  expect(after.filter((invitation) => invitation.invitationId === created.invitationId)).toEqual([]);
});

test('a submitted registration email survives invitation revocation and reconnect', async ({ page, browser, baseURL }) => {
  const person = recipient();
  const projectId = smokeProjectId();
  await openSmokeProject(page);
  const enabled = await emailVerification(page.request);
  const invitedSince = new Date(Date.now() - 1000);
  const answer = await invite(page, person.email);
  if (!enabled) {
    expect(answer.status()).toBe(404);
    await expect(page.getByRole('alert')).toBeVisible();
    const pending = await dataOf<{ email: string }[]>(await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations');
    expect(pending.filter((row) => row.email === person.email)).toEqual([]);
    return;
  }
  expect(answer.status()).toBe(201);
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const pending = await dataOf<{ invitationId: string; email: string }[]>(
      await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations');
    const created = pending.find((row) => row.email === person.email);
    if (!created) throw new Error('The created invitation is missing from its pending list.');
    const invitationLink = await readSignupInvitationLink(page.request, person.email, invitedSince);
    const token = new URL(invitationLink).searchParams.get('invite');
    if (!token) throw new Error('The invitation email has no token.');
    const recipientPage = await context.newPage();
    await recipientPage.goto(invitationLink);
    await expect(recipientPage.getByLabel('Email', { exact: true })).toHaveValue(person.email);
    const providerUrl = await liveModuleUrl(recipientPage, 'app/providers/QueryClientProvider.tsx');
    await expect.poll(() => invitationPreviewState(recipientPage, providerUrl, token)).toBe('open');
    await recipientPage.getByLabel('Password', { exact: true }).fill(person.password);
    const registering = recipientPage.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/auth/register');
    await recipientPage.getByRole('button', { name: 'Create account', exact: true }).click();
    expect((await registering).status()).toBe(202);
    await expect(recipientPage.getByLabel('Verification code')).toBeVisible();
    await expect(recipientPage.getByText(`We sent a 6-digit code to ${person.email}`, { exact: true })).toBeVisible();
    await expect(page.getByTestId('share-popover')).toHaveCount(0);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const revoking = page.waitForResponse((response) => response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/invitations/${created.invitationId}`);
    await page.getByTestId(`share-invitation-${created.invitationId}`).getByRole('button', { name: 'Revoke', exact: true }).click();
    expect((await revoking).ok()).toBe(true);

    // QueryClientProvider keeps previews fresh for 30 seconds before reconnect can refetch them.
    await recipientPage.waitForTimeout(31_000);
    await context.setOffline(true);
    await expect.poll(() => recipientPage.evaluate(() => navigator.onLine)).toBe(false);
    const refreshing = recipientPage.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/auth/invitation' && new URL(response.url()).searchParams.get('token') === token);
    await context.setOffline(false);
    await expect.poll(() => recipientPage.evaluate(() => navigator.onLine)).toBe(true);
    const refreshed = await refreshing;
    expect(refreshed.ok()).toBe(true);
    expect(((await refreshed.json()) as { data: { state: string } }).data.state).toBe('closed');
    await expect.poll(() => invitationPreviewState(recipientPage, providerUrl, token)).toBe('closed');
    await expect(recipientPage.getByText(`We sent a 6-digit code to ${person.email}`, { exact: true })).toBeVisible();
    await recipientPage.getByRole('button', { name: 'Use a different email', exact: true }).click();
    await expect(recipientPage.getByText('This invitation is no longer available.', { exact: true })).toBeVisible();
    await expect(recipientPage.getByLabel('Email', { exact: true })).toHaveValue(person.email);
  } finally {
    try {
      const remaining = await dataOf<{ invitationId: string; email: string }[]>(
        await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'pending invitations after registration check');
      const own = remaining.find((row) => row.email === person.email);
      if (own) {
        await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/invitations/${own.invitationId}`), 'revoke registration-check invitation');
      }
    } finally {
      await context.close();
    }
  }
});
