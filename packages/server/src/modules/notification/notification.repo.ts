/**
 * Notifications repository — `notifications` table CRUD.
 *
 * Per-user inbox for role-upgrade requests / approvals / member-joined
 * events. PG is the source of truth; collab broadcasts a stateless
 * invalidate signal so attached clients refetch via REST (~150ms total
 * delay, per `2026-05-09-permissions.md` § 7.2.5 pattern).
 *
 * Why PG (not Yjs meta doc):
 *   - per-user private (Yjs doc is shared across all project members)
 *   - cross-project (Yjs is per-project; Bell aggregates everywhere)
 *   - offline catchup (Yjs only syncs while ws is connected)
 *
 * See spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 7.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import { notifications } from "@breatic/core";
import type { Notification, NewNotification } from "@breatic/core";
import type { DbTx } from "@server/modules/conversation/conversation.repo.js";

/**
 * Allowed notification types. Mirrors the SQL CHECK constraint on
 * `notifications.type`.
 */
export type NotificationType =
  | "access.role_upgrade_request"
  | "access.role_upgrade_approved"
  | "access.role_upgrade_rejected"
  | "access.member_joined";

export type { Notification, NewNotification };
export type { DbTx } from "@server/modules/conversation/conversation.repo.js";

/**
 * Create a notification row.
 *
 * Caller is the per-type service constructor (e.g.
 * `createRoleUpgradeRequest`) — see {@link notification.service}.
 *
 * @param tx - optional drizzle transaction; threaded so caller can
 *   bundle the INSERT with related writes (e.g. project_members
 *   role bump + 2 notifications in one TX).
 */
export async function create(
  input: NewNotification,
  tx?: DbTx,
): Promise<Notification> {
  const handle = tx ?? db;
  const rows = await handle.insert(notifications).values(input).returning();
  const row = rows[0];
  if (!row) {
    throw new Error("notificationRepo.create: insert returned no row");
  }
  return row;
}

/**
 * List unread notifications for a user, newest first.
 *
 * Hot path for BellMenu — the `notifications_user_unread_idx` index
 * covers this WHERE clause.
 */
export async function listUnreadByUser(
  userId: string,
  limit = 50,
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/**
 * List all (read + unread) notifications for a user, newest first.
 * Used by the "see all" view when the user wants to scroll history.
 */
export async function listAllByUser(
  userId: string,
  limit = 100,
): Promise<Notification[]> {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.deletedAt),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/**
 * Mark a single notification as read. The `userId` guard prevents
 * one user from marking another's notification (defense in depth on
 * top of the route-layer auth).
 *
 * @returns true if a row was updated (i.e. the notification was
 *   unread and owned by `userId`); false otherwise.
 */
export async function markRead(
  id: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

/**
 * Mark all of a user's unread notifications as read.
 *
 * @returns count of rows updated.
 */
export async function markAllRead(userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Count unread notifications for a user — drives the red-dot badge.
 */
export async function countUnread(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.deletedAt),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * Find a notification by id (no user gate — caller is the service
 * layer which already authenticated the user). Returns null on
 * miss or soft-deleted.
 */
export async function findById(id: string): Promise<Notification | null> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), isNull(notifications.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
