// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The owner's client for inviting somebody to a project.
 *
 * Reading and answering an invitation used to live here too, mirroring a pair
 * on the studio side. Both pairs are gone: `decisions.ts` is the one client for
 * answering, whichever of the five kinds the request is.
 *
 * Plain async functions (the data layer stays React-free; the `useQuery` /
 * `useMutation` bindings live in the pages/components that consume these).
 * Every endpoint requires auth (the httpOnly session cookie rides along via
 * `withCredentials`).
 */

import { apiPost } from '@web/data/api/request';
import type { InvitableProjectRole } from '@breatic/shared';

/** Body for `POST /projects/:pid/invitations` — a registered email + role. */
export interface InviteProjectMemberBody {
  email: string;
  role: InvitableProjectRole;
}

export const projectInvitationsApi = {
  /**
   * `POST /api/v1/projects/:pid/invitations` — invite a registered user (by
   * email) to the project with an `editor` / `viewer` role. Owner-only; creates
   * a PENDING invite + an actionable bell notification (and best-effort an email
   * link). The invitee becomes a member only on confirm. Returns the
   * `/decision?token=` URL so the owner can copy it directly (the third
   * channel alongside the bell + email — all three funnel through the same
   * landing page). Rejects: `404` unregistered email, `409` already a member /
   * already invited, `403` not owner, `422` body.
   * @param projectId - The project to invite into.
   * @param body - The invitee's email + the granted role.
   * @returns The copyable `/decision?token=` invite URL.
   * @throws {ApiException} `404` / `409` / `403` / `422` per the endpoint.
   */
  inviteMember(
    projectId: string,
    body: InviteProjectMemberBody,
  ): Promise<{ inviteLink: string }> {
    return apiPost<{ inviteLink: string }, InviteProjectMemberBody>(
      `/projects/${projectId}/invitations`,
      body,
    );
  },
};
