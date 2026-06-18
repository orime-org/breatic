// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project invitation REST client (invite-confirm handshake, 2026-06-18, #1337)
 * — the direct mirror of the studio invite client (`studios.ts`
 * `getInvitation` / `respondInvitation` / `inviteMember`).
 *
 * Plain async functions (the data layer stays React-free; the `useQuery` /
 * `useMutation` bindings live in the pages/components that consume these).
 * Every endpoint requires auth (the httpOnly session cookie rides along via
 * `withCredentials`).
 */

import { apiGet, apiPost } from '@web/data/api/request';
import type {
  InvitableProjectRole,
  ProjectInvitationLandingView,
} from '@breatic/shared';

/** Body for `POST /projects/:pid/invitations` — a registered email + role. */
export interface InviteProjectMemberBody {
  email: string;
  role: InvitableProjectRole;
}

export const projectInvitationsApi = {
  /**
   * `GET /api/v1/project-invitations/:token` — the landing-page view for an
   * email invite link (project + inviter names, role, `expired`, `isInvitee`).
   * Auth-only. Does NOT consume the token (the invitee reads it before acting).
   * Rejects with `404` when the token / invite is gone.
   * @param token - The one-time token from the invite link.
   * @returns The invitation landing view.
   * @throws {ApiException} `404` when the token / invite is gone.
   */
  getInvitation(token: string): Promise<ProjectInvitationLandingView> {
    return apiGet<ProjectInvitationLandingView>(
      `/project-invitations/${token}`,
    );
  },
  /**
   * `POST /api/v1/project-invitations/respond` — confirm or decline an invite
   * from the email link; consumes the one-time token. Returns the project id +
   * slug for the post-confirm redirect.
   * @param token - The one-time token from the invite link.
   * @param action - `confirm` to accept (and join), `decline` to refuse.
   * @returns The project id + slug to redirect to on confirm.
   * @throws {ApiException} `404` token / invite gone, already decided, expired,
   *   or the caller is not the invitee.
   */
  respondInvitation(
    token: string,
    action: 'confirm' | 'decline',
  ): Promise<{ projectId: string; projectSlug: string }> {
    return apiPost<
      { projectId: string; projectSlug: string },
      { token: string; action: 'confirm' | 'decline' }
    >('/project-invitations/respond', { token, action });
  },
  /**
   * `POST /api/v1/projects/:pid/invitations` — invite a registered user (by
   * email) to the project with an `editor` / `viewer` role. Owner-only; creates
   * a PENDING invite + an actionable bell notification (and best-effort an email
   * link). The invitee becomes a member only on confirm. Rejects: `404`
   * unregistered email, `409` already a member / already invited, `403` not
   * owner, `422` body.
   * @param projectId - The project to invite into.
   * @param body - The invitee's email + the granted role.
   * @returns Once the invite has been created.
   * @throws {ApiException} `404` / `409` / `403` / `422` per the endpoint.
   */
  inviteMember(
    projectId: string,
    body: InviteProjectMemberBody,
  ): Promise<{ ok: true }> {
    return apiPost<{ ok: true }, InviteProjectMemberBody>(
      `/projects/${projectId}/invitations`,
      body,
    );
  },
};
