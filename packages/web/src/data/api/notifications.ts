import { apiGet, apiPatch, apiPost } from '@/data/api/request';

/**
 * Notification types — must match the SQL CHECK constraint on
 * `notifications.type`. See
 * breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 7.
 */
export type NotificationType =
  | 'access.role_upgrade_request'
  | 'access.role_upgrade_approved'
  | 'access.role_upgrade_rejected'
  | 'access.member_joined';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  /** Type-specific JSON; see spec for shape per type. */
  payload: Record<string, unknown>;
  projectId: string | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export const notificationsApi = {
  /**
   * List the caller's notifications. `unreadOnly=true` (default)
   * returns only unread items (BellMenu opens with this). Pass
   * `false` for the full history view.
   */
  list(unreadOnly = true) {
    const qs = unreadOnly ? '?unread=true' : '?unread=false';
    return apiGet<{ data: Notification[] }>(`/users/me/notifications${qs}`);
  },

  /** Unread count — drives the red-dot badge on the bell icon. */
  count() {
    return apiGet<{ data: { count: number } }>(
      `/users/me/notifications/count`,
    );
  },

  /** Mark a single notification as read. */
  markRead(id: string) {
    return apiPatch<{ data: { ok: true } }, undefined>(
      `/users/me/notifications/${id}/read`,
      undefined,
    );
  },

  /** Mark every unread notification as read. */
  markAllRead() {
    return apiPost<{ data: { count: number } }, undefined>(
      `/users/me/notifications/read-all`,
      undefined,
    );
  },
};
