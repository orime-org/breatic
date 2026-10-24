// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Owner's client for creating, listing and revoking project invitations.
 * The recipient answers their invitation through the decisions client.
 *
 * Plain async functions (the data layer stays React-free; the `useQuery` /
 * `useMutation` bindings live in the pages/components that consume these).
 * Every endpoint requires auth (the httpOnly session cookie rides along via
 * `withCredentials`).
 */

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';
import type { InvitableProjectRole, PendingProjectInvitationSummary } from '@breatic/shared';

/** Body for `POST /projects/:pid/invitations` — the recipient email and role. */
export interface InviteProjectMemberBody {
  email: string;
  role: InvitableProjectRole;
}

export const projectInvitationsApi = {
  /**
   * Invite an email address with an editor or viewer role. Registered accounts
   * receive an ordinary invitation; other recipients receive registration mail.
   * The recipient becomes a member after confirming their invitation.
   * @param projectId - The project to invite into.
   * @param body - The invitee's email + the granted role.
   * @returns Whether the created invitation is awaiting registration.
   * @throws {ApiException} `404` / `409` / `403` / `422` per the endpoint.
   */
  async inviteMember(
    projectId: string,
    body: InviteProjectMemberBody,
  ): Promise<{ ok: true; pendingSignup: boolean }> {
    return apiPost<{ ok: true; pendingSignup: boolean }, InviteProjectMemberBody>(
      `/projects/${projectId}/invitations`,
      body,
    );
  },
  /**
   * Read the project's live pending invitations for its Owner.
   * @param projectId - The project whose invitations to list.
   * @returns The current pending recipients.
   * @throws {ApiException} When the request fails.
   */
  listPending(projectId: string): Promise<PendingProjectInvitationSummary[]> {
    return apiGet<PendingProjectInvitationSummary[]>(`/projects/${projectId}/invitations`);
  },
  /**
   * Revoke one pending invitation in the Owner's project.
   * @param projectId - The project containing the invitation.
   * @param invitationId - The invitation to revoke.
   * @returns The committed revocation result.
   * @throws {ApiException} When the invitation cannot be revoked.
   */
  revoke(projectId: string, invitationId: string): Promise<{ ok: true }> {
    return apiDelete<{ ok: true }>(`/projects/${projectId}/invitations/${invitationId}`);
  },
};
