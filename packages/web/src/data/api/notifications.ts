// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { apiGet, apiPatch, apiPost } from '@web/data/api/request';

/**
 * Notification types — must match the SQL CHECK constraint on
 * `notifications.type`. See the access-permission design spec
 * (2026-05-28) § 7.
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
   * @param unreadOnly - When true (default), return only unread notifications.
   * @returns The caller's notifications.
   */
  list(unreadOnly = true): Promise<{ data: Notification[] }> {
    const qs = unreadOnly ? '?unread=true' : '?unread=false';
    return apiGet<{ data: Notification[] }>(`/users/me/notifications${qs}`);
  },

  /**
   * Unread count — drives the red-dot badge on the bell icon.
   * @returns The number of unread notifications for the caller.
   */
  count(): Promise<{ data: { count: number } }> {
    return apiGet<{ data: { count: number } }>(
      '/users/me/notifications/count',
    );
  },

  /**
   * Mark a single notification as read.
   * @param id - The notification to mark as read.
   * @returns An acknowledgement once the notification is marked read.
   */
  markRead(id: string): Promise<{ data: { ok: true } }> {
    return apiPatch<{ data: { ok: true } }, undefined>(
      `/users/me/notifications/${id}/read`,
      undefined,
    );
  },

  /**
   * Mark every unread notification as read.
   * @returns The number of notifications that were marked read.
   */
  markAllRead(): Promise<{ data: { count: number } }> {
    return apiPost<{ data: { count: number } }, undefined>(
      '/users/me/notifications/read-all',
      undefined,
    );
  },
};
