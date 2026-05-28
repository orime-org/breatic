import { apiPatch, apiPost } from '@/data/api/request';
import type { Notification } from '@/data/api/notifications';

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
   */
  submit(projectId: string, body: SubmitRoleUpgradeBody) {
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
   */
  decide(notificationId: string, body: DecideRoleUpgradeBody) {
    return apiPatch<{ data: { ok: true } }, DecideRoleUpgradeBody>(
      `/role-upgrade-requests/${notificationId}/decision`,
      body,
    );
  },
};
