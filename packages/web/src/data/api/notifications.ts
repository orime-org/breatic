// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, apiPatch, apiPost } from '@web/data/api/request';

/**
 * Notification types — must match the backend `NotificationType` union
 * (`notification.repo.ts`). The `access.*` types are project access-permission
 * (spec 2026-05-28 § 7); the `studio.*` types are studio member / transfer /
 * invite notifications; the `project.*` types are the project invite-confirm
 * handshake (#1337). `studio.transfer_request` and `studio.invite_request` are
 * the inline-actionable types (confirm / cancel + a TTL). `project.invite_request`
 * is actionable too, but it diverges from studio: the bell row LINKS OUT to the
 * `/project-invite?token=` landing page (its payload carries that `token`) rather
 * than confirming inline. The rest are informational (read-on-click).
 */
export type NotificationType =
  | 'access.role_upgrade_request'
  | 'access.role_upgrade_approved'
  | 'access.role_upgrade_rejected'
  | 'studio.transfer_request'
  | 'studio.transfer_approved'
  | 'studio.invite_request'
  | 'studio.invite_accepted'
  | 'project.invite_request'
  | 'project.invite_accepted';

/** Action on an actionable notification (e.g. a studio transfer request). */
export type NotificationAction = 'confirm' | 'cancel';

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  /** Type-specific JSON; see spec for shape per type. */
  payload: Record<string, unknown>;
  projectId: string | null;
  readAt: string | null;
  /** Actionable-notification TTL (slice 3); `null` = no expiry. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export const notificationsApi = {
  /**
   * List the caller's notifications. `unreadOnly=true` (default)
   * returns only unread items (BellMenu opens with this). Pass
   * `false` for the full history view.
   * @param unreadOnly - When true (default), return only unread notifications.
   * @returns The caller's notifications.
   */
  list(unreadOnly = true): Promise<Notification[]> {
    const qs = unreadOnly ? '?unread=true' : '?unread=false';
    return apiGet<Notification[]>(`/users/me/notifications${qs}`);
  },

  /**
   * Unread count — drives the red-dot badge on the bell icon.
   * @returns The number of unread notifications for the caller.
   */
  count(): Promise<{ count: number }> {
    return apiGet<{ count: number }>('/users/me/notifications/count');
  },

  /**
   * Mark a single notification as read.
   * @param id - The notification to mark as read.
   * @returns An acknowledgement once the notification is marked read.
   */
  markRead(id: string): Promise<{ ok: true }> {
    return apiPatch<{ ok: true }, undefined>(
      `/users/me/notifications/${id}/read`,
      undefined,
    );
  },

  /**
   * Mark every unread notification as read.
   * @returns The number of notifications that were marked read.
   */
  markAllRead(): Promise<{ count: number }> {
    return apiPost<{ count: number }, undefined>(
      '/users/me/notifications/read-all',
      undefined,
    );
  },

  /**
   * Act on an actionable notification (`confirm` / `cancel`). For a
   * `studio.transfer_request` this routes to the transfer-admin handshake
   * (confirm = accept admin, cancel = decline). The server gates on the
   * caller owning the notification; a missing / already-decided / expired
   * request collapses to a `404` / `409` `ApiException`.
   * @param id - The actionable notification to respond to.
   * @param action - `confirm` to accept, `cancel` to decline.
   * @returns An acknowledgement once the action is recorded.
   */
  respondAction(
    id: string,
    action: NotificationAction,
  ): Promise<{ ok: true }> {
    return apiPost<{ ok: true }, { action: NotificationAction }>(
      `/users/me/notifications/${id}/action`,
      { action },
    );
  },
};
