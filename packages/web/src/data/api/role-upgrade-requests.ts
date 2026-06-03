// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiPatch, apiPost } from '@web/data/api/request';
import type { Notification } from '@web/data/api/notifications';

export interface SubmitRoleUpgradeBody {
  message?: string;
}

export interface DecideRoleUpgradeBody {
  decision: 'approved' | 'rejected';
  reason?: string;
}

export const roleUpgradeRequestsApi = {
  /**
   * Viewer asks owner for editor role. Server gates on
   * `requireRole('view')` — editors / owners get 403 because they
   * don't need to upgrade (editor is the highest non-owner role).
   *
   * Returns the freshly-created notification row that landed in the
   * owner's inbox, so the client can optimistically mark the action
   * complete + show a "sent" toast.
   * @param projectId - Project the viewer wants edit access to.
   * @param body - Optional message included with the upgrade request.
   * @returns The created request notification placed in the owner's inbox.
   */
  submit(projectId: string, body: SubmitRoleUpgradeBody): Promise<{ data: Notification }> {
    return apiPost<{ data: Notification }, SubmitRoleUpgradeBody>(
      `/projects/${projectId}/role-upgrade-requests`,
      body,
    );
  },

  /**
   * Owner approves or rejects a pending upgrade request. The
   * `notificationId` is the id of the original request notification
   * (the request lives in the notifications table; there's no
   * separate request relation — see spec § 7).
   *
   * Server gates on the notification's `userId` matching the caller
   * (defense in depth — only the owner can act on their own inbox).
   * @param notificationId - Id of the original request notification to decide on.
   * @param body - The decision (approved / rejected) and an optional reason.
   * @returns An acknowledgement once the decision is recorded.
   */
  decide(notificationId: string, body: DecideRoleUpgradeBody): Promise<{ data: { ok: true } }> {
    return apiPatch<{ data: { ok: true } }, DecideRoleUpgradeBody>(
      `/role-upgrade-requests/${notificationId}/decision`,
      body,
    );
  },
};
