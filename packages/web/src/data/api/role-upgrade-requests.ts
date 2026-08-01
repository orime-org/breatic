// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiDelete, apiGet, apiPatch, apiPost } from '@web/data/api/request';
import type { Notification } from '@web/data/api/notifications';

export interface SubmitRoleUpgradeBody {
  message?: string;
}

export interface DecideRoleUpgradeBody {
  decision: 'approved' | 'rejected';
  reason?: string;
}

/** What a viewer gets back after asking: the request, and the bell entry. */
export interface FiledRoleUpgradeRequest {
  requestId: string;
  notification: Notification;
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
   * The owner approves or rejects a request.
   *
   * Keyed on the REQUEST id, not the notification's. The request owns a row
   * with a status, a deadline and a uniqueness rule; the bell entry only
   * announces it, and the id for it rides in that entry's payload.
   * @param requestId - The `role_upgrade_requests` row being decided.
   * @param body - The decision and an optional reason.
   * @returns An acknowledgement once the decision is recorded.
   */
  decide(
    requestId: string,
    body: DecideRoleUpgradeBody,
  ): Promise<{ ok: true }> {
    return apiPatch<{ ok: true }, DecideRoleUpgradeBody>(
      `/role-upgrade-requests/${requestId}/decision`,
      body,
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
