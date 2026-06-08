// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  requestedRole: "editor"; // currently only editor upgrade is supported
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
  newRole?: "editor";
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
  role: "editor" | "viewer";
}

// ── Constructors ────────────────────────────────────────────────────

/**
 * Create a notification for the owner that a viewer wants editor
 * access. Returns the inserted row so the caller can return its id
 * to the requester (or surface it in the broadcast).
 * @param input - Owner inbox, project scope, payload, and optional transaction
 * @param input.ownerUserId - Project owner who receives the request in their inbox
 * @param input.projectId - Project the upgrade is requested for
 * @param input.payload - Requester, project name, requested role, and message
 * @param input.tx - Optional transaction to bundle with the role-bump write
 * @returns The inserted `access.role_upgrade_request` notification
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
 * @param input - Requester inbox, project scope, payload, and optional transaction
 * @param input.requesterUserId - Viewer who receives the approval in their inbox
 * @param input.projectId - Project the upgrade was approved for
 * @param input.payload - Project name and the newly granted role
 * @param input.tx - Optional transaction to bundle with the role-bump write
 * @returns The inserted `access.role_upgrade_approved` notification
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
 * @param input - Requester inbox, project scope, payload, and optional transaction
 * @param input.requesterUserId - Viewer who receives the rejection in their inbox
 * @param input.projectId - Project the upgrade was rejected for
 * @param input.payload - Project name and optional rejection reason
 * @param input.tx - Optional transaction to bundle with related writes
 * @returns The inserted `access.role_upgrade_rejected` notification
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
 * @param input - Owner inbox, project scope, payload, and optional transaction
 * @param input.ownerUserId - Project owner who receives the join notice in their inbox
 * @param input.projectId - Project the new member joined
 * @param input.payload - New member, project name, and the role they joined with
 * @param input.tx - Optional transaction to bundle with the member insert
 * @returns The inserted `access.member_joined` notification
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

/**
 * Studio member-invited payload — an admin added the user to a studio.
 * Stored on the `studio.member_invited` notification in the invitee's inbox
 * (informational; the invite already took effect).
 */
export interface StudioMemberInvitedPayload {
  studioName: string;
  inviterName: string;
  role: "creator" | "member";
}

/**
 * Studio transfer-request payload — an admin asks the user to take over as
 * admin. Stored on the actionable `studio.transfer_request` notification
 * (confirm/cancel; expires after a TTL).
 */
export interface StudioTransferRequestPayload {
  fromUserId: string;
  studioName: string;
}

/**
 * Studio transfer-approved payload — the recipient accepted; stored on the
 * `studio.transfer_approved` notification in the OLD admin's inbox.
 */
export interface StudioTransferApprovedPayload {
  studioName: string;
}

/**
 * Notify a user they were added to a studio (slice 3) — informational, no
 * action and no TTL (studio invites take effect immediately).
 * @param input - Invitee inbox, payload, and optional transaction
 * @param input.userId - The invitee who receives the notice in their inbox
 * @param input.payload - Studio name, inviter name, and granted role
 * @param input.tx - Optional transaction to bundle with the membership insert
 * @returns The inserted `studio.member_invited` notification
 */
export async function createStudioMemberInvited(input: {
  userId: string;
  payload: StudioMemberInvitedPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.userId,
      type: "studio.member_invited",
      payload: input.payload as unknown as Record<string, unknown>,
    },
    input.tx,
  );
}

/**
 * Notify a user that an admin wants to transfer studio admin to them
 * (slice 3) — actionable (confirm/cancel), expires after the given TTL.
 * @param input - Recipient inbox, payload, expiry, and optional transaction
 * @param input.userId - The proposed new admin who receives the request
 * @param input.payload - The initiating admin's user id and the studio name
 * @param input.expiresAt - When the request times out (7 days from creation)
 * @param input.tx - Optional transaction to bundle with related writes
 * @returns The inserted `studio.transfer_request` notification
 */
export async function createStudioTransferRequest(input: {
  userId: string;
  payload: StudioTransferRequestPayload;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.userId,
      type: "studio.transfer_request",
      payload: input.payload as unknown as Record<string, unknown>,
      expiresAt: input.expiresAt,
    },
    input.tx,
  );
}

/**
 * Notify the OLD admin that the transfer they initiated was accepted
 * (slice 3).
 * @param input - Old-admin inbox, payload, and optional transaction
 * @param input.userId - The former admin who receives the confirmation
 * @param input.payload - The studio name
 * @param input.tx - Optional transaction to bundle with the role swap
 * @returns The inserted `studio.transfer_approved` notification
 */
export async function createStudioTransferApproved(input: {
  userId: string;
  payload: StudioTransferApprovedPayload;
  tx?: DbTx;
}): Promise<NotificationEntity> {
  return notificationRepo.create(
    {
      userId: input.userId,
      type: "studio.transfer_approved",
      payload: input.payload as unknown as Record<string, unknown>,
    },
    input.tx,
  );
}

// ── Read APIs ───────────────────────────────────────────────────────

/**
 * Fetch a single notification by id (no user gate — callers in the
 * application layer have already authenticated the user).
 *
 * Thin pass-through to the notification repository so route handlers
 * reach the data layer through the service (prohibition #1).
 * @param id - Notification UUID
 * @returns The notification entity, or null if not found / soft-deleted
 */
export async function getById(id: string): Promise<NotificationEntity | null> {
  return notificationRepo.findById(id);
}

/**
 * List a user's unread notifications, newest first.
 * BellMenu pulls this on open + on stateless invalidate signal.
 * @param userId - Inbox owner whose unread notifications to fetch
 * @returns The user's unread notifications, newest first
 */
export async function listUnread(userId: string): Promise<NotificationEntity[]> {
  return notificationRepo.listUnreadByUser(userId);
}

/**
 * List all of a user's notifications (read + unread) — history view.
 * @param userId - Inbox owner whose full history to fetch
 * @returns The user's read and unread notifications, newest first
 */
export async function listAll(userId: string): Promise<NotificationEntity[]> {
  return notificationRepo.listAllByUser(userId);
}

/**
 * Unread count — drives the red-dot badge on the bell icon.
 * @param userId - Inbox owner whose unread notifications to count
 * @returns Number of unread notifications
 */
export async function countUnread(userId: string): Promise<number> {
  return notificationRepo.countUnread(userId);
}

// ── Mutations ───────────────────────────────────────────────────────

/**
 * Mark a single notification as read.
 * @param id - Notification UUID to mark read
 * @param userId - Owner guard; only this user's row may be marked
 * @throws {NotFoundError} if the notification doesn't exist,
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
 * @param userId - Inbox owner whose unread notifications to clear
 * @returns Count of notifications marked read (0 if none were unread)
 */
export async function markAllRead(userId: string): Promise<number> {
  return notificationRepo.markAllRead(userId);
}
