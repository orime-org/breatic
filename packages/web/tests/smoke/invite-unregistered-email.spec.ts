// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { emailVerification, readSignupCode, readSignupInvitationLink } from '../helpers/signup';

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
