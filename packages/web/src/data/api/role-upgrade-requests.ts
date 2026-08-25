// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { apiDelete, apiGet, apiPost } from '@web/data/api/request';

export interface SubmitRoleUpgradeBody {
  message?: string;
}

/**
 * What a viewer gets back after asking: the id of the request they filed.
 *
 * Not the bell entry the server also wrote — that one is the owner's, and its
 * payload carries the token that answers this request.
 */
export interface FiledRoleUpgradeRequest {
  requestId: string;
}

/** The caller's own outstanding request on a project. */
export interface LiveRoleUpgradeRequest {
  id: string;
  /** ISO instant; the request stops being answerable after it. */
  expiresAt: string;
}

export const roleUpgradeRequestsApi = {
  /**
   * Viewer asks the owner for the editor role. The server gates on
   * `requireRole('viewer')` — editors and owners get 403, since editor is
   * already the highest non-owner role.
   * @param projectId - Project the viewer wants edit access to.
   * @param body - Optional message included with the request.
   * @returns The new request's id and the bell entry announcing it.
   */
  submit(
    projectId: string,
    body: SubmitRoleUpgradeBody,
  ): Promise<FiledRoleUpgradeRequest> {
    return apiPost<FiledRoleUpgradeRequest, SubmitRoleUpgradeBody>(
      `/projects/${projectId}/role-upgrade-requests`,
      body,
    );
  },

  /**
   * The caller's own live request on a project, or null.
   *
   * "Live" means pending AND not past its deadline. The two are different
   * questions: the uniqueness index deliberately ignores the deadline, so a
   * request that died on day eight is still `pending` — showing it would put a
   * cancel button on something already over.
   * @param projectId - Project being viewed.
   * @returns Their live request, or null when they have none.
   */
  mine(projectId: string): Promise<LiveRoleUpgradeRequest | null> {
    return apiGet<LiveRoleUpgradeRequest | null>(
      `/projects/${projectId}/role-upgrade-requests/mine`,
    );
  },

  /**
   * The requester withdraws their own request, freeing the slot at once.
   *
   * Without this a viewer is held hostage by their own unanswered ask: one
   * live request per person per project, and only time releases it.
   * @param requestId - The `role_upgrade_requests` row being withdrawn.
   * @returns An acknowledgement once it is withdrawn.
   */
  cancel(requestId: string): Promise<{ ok: true }> {
    return apiDelete<{ ok: true }>(`/role-upgrade-requests/${requestId}`);
  },
};
