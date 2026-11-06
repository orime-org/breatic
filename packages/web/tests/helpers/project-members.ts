// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { expect, type BrowserContext, type Page } from 'playwright/test';
import { dataOf } from './api';

/**
 * Read the real invitation notification addressed to this account and Project.
 * @param context - The invited account's authenticated browser context.
 * @param projectId - The Project named by the invitation.
 * @returns The delivered invitation decision token.
 * @throws {Error} When no invitation is delivered or its response is invalid.
 */
async function invitationToken(context: BrowserContext, projectId: string): Promise<string> {
  let token: string | undefined;
  await expect.poll(async () => {
    const bell = await dataOf<{ items: Array<{ type: string; payload: { projectId?: string; shareToken?: string } }> }>(
      await context.request.get('/api/v1/users/me/notifications'), 'read invitee notification',
    );
    token = bell.items.find((item) => item.type === 'project.invite_request' && item.payload.projectId === projectId)?.payload.shareToken;
    return typeof token === 'string' && token.length > 0;
  }).toBe(true);
  if (!token) throw new Error('No invitation token was delivered');
  return token;
}

/**
 * Send and accept a real Project invitation through its decision page.
 * @param owner - The Project owner's authenticated page.
 * @param invitee - The invited account's authenticated context.
 * @param projectId - The Project being shared.
 * @param email - The invited account's registered address.
 * @param role - Its granted Project role.
 * @returns The invitee's page after the invitation is accepted.
 * @throws {Error} When invitation delivery, acceptance or role verification fails.
 */
export async function inviteMember(owner: Page, invitee: BrowserContext, projectId: string, email: string, role: 'editor' | 'viewer'): Promise<Page> {
  await dataOf(await owner.request.post(`/api/v1/projects/${projectId}/invitations`, { data: { email, role } }), 'invite another account');
  const token = await invitationToken(invitee, projectId);
  const page = await invitee.newPage();
  await page.goto(`/decision?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole('heading', { name: 'You\'ve been invited to a Project', exact: true })).toBeVisible();
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/decisions/respond'
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await dataOf(await accepted, 'accept real Project invitation');
  expect(await dataOf<{ myRole: string }>(await invitee.request.get(`/api/v1/projects/${projectId}`), 'read granted role')).toMatchObject({ myRole: role });
  return page;
}

/**
 * Remove accepted membership and revoke this account's pending invitation.
 * @param page - The Project owner's authenticated page.
 * @param projectId - The Project this case shared.
 * @param memberId - The invited account's stable identity.
 * @throws {Error} When membership or invitation cleanup is refused.
 */
export async function cleanMembership(page: Page, projectId: string, memberId: string): Promise<void> {
  try {
    const members = await dataOf<Array<{ userId: string }>>(
      await page.request.get(`/api/v1/projects/${projectId}/members`), 'list members for cleanup',
    );
    if (members.some((member) => member.userId === memberId)) {
      await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/members/${memberId}`), 'remove invited member');
    }
  } finally {
    const pending = await dataOf<Array<{ invitationId: string; invitedUserId: string | null }>>(
      await page.request.get(`/api/v1/projects/${projectId}/invitations`), 'list pending invitations for cleanup',
    );
    for (const invitation of pending.filter((item) => item.invitedUserId === memberId)) {
      await dataOf(await page.request.delete(`/api/v1/projects/${projectId}/invitations/${invitation.invitationId}`), 'revoke unused invitation');
    }
  }
}
