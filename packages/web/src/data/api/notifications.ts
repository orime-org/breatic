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
 * `/decision?token=` landing page (its payload carries that token) rather
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
  | 'project.invite_accepted'
  | 'project.transfer_request'
  | 'project.transfer_approved';

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

/**
 * What an id in a notification payload currently points at.
 *
 * Resolved by the server at read time, never stored in the notification. A
 * stored slug is a snapshot of a name that can change hands — and for a
 * personal studio the slug IS the user's `@handle`, so a released one can end up
 * naming a completely different person.
 */
export interface NotificationRef {
  slug: string;
  name: string;
  /**
   * The target is soft-deleted: name it, but do not link to it.
   *
   * Soft delete is deactivation, not erasure — a notification is a record of
   * something that happened, and "someone invited you to something" is not a
   * usable record. Erasure is a separate path that anonymises the data itself.
   */
  deleted: boolean;
}

/**
 * A page of notifications plus what their ids resolve to right now.
 *
 * An id absent from its map means the target is gone; render it as plain text
 * rather than a link that goes nowhere.
 */
export interface NotificationResolved {
  users: Record<string, NotificationRef>;
  studios: Record<string, NotificationRef>;
  projects: Record<string, NotificationRef>;
}

export interface NotificationListView {
  items: Notification[];
  resolved: NotificationResolved;
}

/** A resolved map with nothing in it — for callers with no page loaded yet. */
export const EMPTY_RESOLVED: NotificationResolved = {
  users: {},
  studios: {},
  projects: {},
};

export const notificationsApi = {
  /**
   * List the caller's notifications. `unreadOnly=true` (default)
   * returns only unread items (BellMenu opens with this). Pass
   * `false` for the full history view.
   * @param unreadOnly - When true (default), return only unread notifications.
   * @returns The caller's notifications.
   */
  list(unreadOnly = true): Promise<NotificationListView> {
    const qs = unreadOnly ? '?unread=true' : '?unread=false';
    return apiGet<NotificationListView>(`/users/me/notifications${qs}`);
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
};
