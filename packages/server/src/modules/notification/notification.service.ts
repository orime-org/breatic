/**
 * Notification service — type-safe constructors + mark-read + listing.
 *
 * Each notification kind has its own constructor so the payload shape
 * stays disciplined at the point of creation (the underlying PG
 * `notifications` table stores payload as opaque jsonb).
 *
 * Caller-pattern: server routes (and the role-upgrade approve / reject
 * service) call these to insert; React Query on the frontend pulls via
 * `listUnread` / `markRead`.
 *
 * The collab stateless invalidate broadcast (Yjs `project-{pid}/meta`
 * doc) is wired in Phase 7 — these constructors stay focused on PG
 * writes here; the route layer (application boundary) is responsible
 * for triggering the broadcast post-commit.
 *
 * Spec: breatic-inner/engineering/specs/2026-05-28-access-permission-design.md § 7.
 */

import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import type { DbTx } from "@server/modules/notification/notification.repo.js";
import type { NotificationEntity } from "@breatic/shared";

export type { NotificationEntity };

/**
 * Role-upgrade request payload — viewer asked owner for editor role.
 * Stored on the `access.role_upgrade_request` notification that lives
 * in the owner's inbox.
 */
export interface RoleUpgradeRequestPayload {
  requesterUserId: string;
  projectName: string;
  requestedRole: "edit"; // currently only edit upgrade is supported
  message: string | null;
}

/**
 * Role-upgrade decision payload — owner approved or rejected the
 * viewer's request. Stored on `access.role_upgrade_approved` /
 * `access.role_upgrade_rejected` notifications in the requester's
 * inbox.
 */
export interface RoleUpgradeDecisionPayload {
  projectName: string;
  newRole?: "edit";
  reason?: string | null;
}

/**
 * Member-joined payload — someone consumed a link and joined the
 * project. Stored on `access.member_joined` notifications in the
 * owner's inbox.
 */
export interface MemberJoinedPayload {
  newMemberUserId: string;
  projectName: string;
  role: "edit" | "view";
}

// ── Constructors ────────────────────────────────────────────────────

/**
 * Create a notification for the owner that a viewer wants editor
 * access. Returns the inserted row so the caller can return its id
 * to the requester (or surface it in the broadcast).
 */
export async function createRoleUpgradeRequest(input: {
  ownerUserId: string;
  projectId: string;
  payload: RoleUpgradeRequestPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.ownerUserId,
      type: "access.role_upgrade_request",
      payload: input.payload as unknown as Record<string, unknown>,
      projectId: input.projectId,
    },
    input.tx,
  );
}

/**
 * Create a notification for the requester that their upgrade was
 * approved by the owner.
 */
export async function createRoleUpgradeApproved(input: {
  requesterUserId: string;
  projectId: string;
  payload: RoleUpgradeDecisionPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.requesterUserId,
      type: "access.role_upgrade_approved",
      payload: input.payload as unknown as Record<string, unknown>,
      projectId: input.projectId,
    },
    input.tx,
  );
}

/**
 * Create a notification for the requester that their upgrade was
 * rejected by the owner.
 */
export async function createRoleUpgradeRejected(input: {
  requesterUserId: string;
  projectId: string;
  payload: RoleUpgradeDecisionPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.requesterUserId,
      type: "access.role_upgrade_rejected",
      payload: input.payload as unknown as Record<string, unknown>,
      projectId: input.projectId,
    },
    input.tx,
  );
}

/**
 * Create a notification for the owner that a new member joined via
 * consume link.
 */
export async function createMemberJoined(input: {
  ownerUserId: string;
  projectId: string;
  payload: MemberJoinedPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.ownerUserId,
      type: "access.member_joined",
      payload: input.payload as unknown as Record<string, unknown>,
      projectId: input.projectId,
    },
    input.tx,
  );
}

// ── Read APIs ───────────────────────────────────────────────────────

/**
 * List a user's unread notifications, newest first.
 * BellMenu pulls this on open + on stateless invalidate signal.
 */
export async function listUnread(userId: string): Promise<NotificationEntity[]> {
  return notificationRepo.listUnreadByUser(userId);
}

/**
 * List all of a user's notifications (read + unread) — history view.
 */
export async function listAll(userId: string): Promise<NotificationEntity[]> {
  return notificationRepo.listAllByUser(userId);
}

/**
 * Unread count — drives the red-dot badge on the bell icon.
 */
export async function countUnread(userId: string): Promise<number> {
  return notificationRepo.countUnread(userId);
}

// ── Mutations ───────────────────────────────────────────────────────

/**
 * Mark a single notification as read.
 *
 * @throws {@link NotFoundError} if the notification doesn't exist,
 *   is already read, or doesn't belong to `userId` (the repo guards
 *   userId match defense-in-depth).
 */
export async function markRead(id: string, userId: string): Promise<void> {
  const ok = await notificationRepo.markRead(id, userId);
  if (!ok) {
    throw new NotFoundError(t("server.error.notFound"));
  }
}

/**
 * Mark all of a user's unread notifications as read. Idempotent —
 * returns the count of rows updated (0 if nothing was unread).
 */
export async function markAllRead(userId: string): Promise<number> {
  return notificationRepo.markAllRead(userId);
}
