// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade request service — viewer asks owner for editor rights.
 *
 * Three operations:
 *   - `request`: viewer creates a `role_upgrade_request` notification
 *     in the owner's inbox.
 *   - `approve`: owner decides → service updates `project_members.role`
 *     to 'editor' AND creates a `role_upgrade_approved` notification in
 *     the requester's inbox AND marks the original request as read.
 *   - `reject`: owner decides → service creates a
 *     `role_upgrade_rejected` notification in the requester's inbox
 *     AND marks the original request as read. No member-table change.
 *
 * Spec: access-permission design (2026-05-28) § 6.3.
 *
 * Authorization model (route layer enforces gates):
 *   - request: caller must be an active member of the project, role 'viewer'
 *   - approve / reject: caller must be the project owner
 *
 * Atomicity & once-only: approve / reject each run in a single db
 * transaction — the gate read, the mark-read CAS, the role bump, and the
 * outcome notification all share one transaction, so any failure rolls the
 * whole decision back. The mark-read CAS (UPDATE … WHERE read_at IS NULL) is
 * the serialization point: under concurrency only the first decision flips
 * read_at; the loser's UPDATE matches zero rows and aborts. A request is
 * therefore decided EXACTLY ONCE — never approved twice, never approved AND
 * rejected.
 */

import { db } from "@breatic/core";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { projectMembersRepo } from "@breatic/core";
import { NotFoundError, ForbiddenError, ValidationError } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import type { NotificationEntity } from "@breatic/shared";

interface RoleUpgradeRequestInput {
  ownerUserId: string;
  requesterUserId: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  message?: string | null;
}

/**
 * Viewer creates a role-upgrade request. Inserts a single
 * notification in the owner's inbox.
 * @param input - Owner, requester, project, and optional message for the request.
 * @returns the inserted notification (caller can echo the id back to
 *   the requester for client-side optimistic display).
 */
export async function request(
  input: RoleUpgradeRequestInput,
): Promise<NotificationEntity> {
  const requester = await resolveActorProfile(input.requesterUserId);
  return notificationService.createRoleUpgradeRequest({
    ownerUserId: input.ownerUserId,
    projectId: input.projectId,
    payload: {
      requesterUserId: input.requesterUserId,
      requesterName: requester.name,
      requesterHandle: requester.handle,
      projectName: input.projectName,
      projectSlug: input.projectSlug,
      requestedRole: "editor",
      message: input.message ?? null,
    },
  });
}

interface DecisionInput {
  notificationId: string;
  ownerUserId: string;
  projectName: string;
  projectSlug: string;
}

/**
 * Owner approves a viewer's role-upgrade request.
 *
 * Atomic: (1) bump member role view → edit, (2) create approved
 * notification for the requester, (3) mark the request notification
 * as read on the owner's side.
 * @param input - Notification id, owner id, and project name for the decision.
 * @throws {NotFoundError} if the request notification doesn't
 *   exist, was already decided (read), doesn't belong to
 *   `ownerUserId`, or the member role bump finds no matching row.
 * @throws {ValidationError} if the notification isn't a
 *   role-upgrade-request type (defense in depth — the route should
 *   already filter by id).
 */
export async function approve(input: DecisionInput): Promise<void> {
  let approvedActivity: { projectId: string; targetUserId: string } | null =
    null;
  await db.transaction(async (tx) => {
    const req = await loadAndGate(tx, input);
    // Serialization point: the mark-read CAS (UPDATE … WHERE read_at IS NULL)
    // flips the request to decided. Under concurrency the row lock makes a
    // losing decision's UPDATE match zero rows → won=false → abort, rolling
    // back the whole transaction. Runs BEFORE the role bump so the loser does
    // no work. A request is decided exactly once.
    const won = await notificationRepo.markRead(req.id, input.ownerUserId, tx);
    if (!won) {
      throw new NotFoundError(t("server.error.notFound"));
    }
    const requesterUserId = String(req.payload.requesterUserId);
    const ok = await projectMembersRepo.updateRole(
      String(req.projectId),
      requesterUserId,
      "editor",
      tx,
    );
    if (!ok) {
      throw new NotFoundError(t("server.error.notFound"));
    }
    const decider = await resolveActorProfile(input.ownerUserId);
    await notificationService.createRoleUpgradeApproved({
      requesterUserId,
      projectId: String(req.projectId),
      payload: {
        deciderName: decider.name,
        deciderHandle: decider.handle,
        projectName: input.projectName,
        projectSlug: input.projectSlug,
        newRole: "editor",
      },
      tx,
    });
    approvedActivity = {
      projectId: String(req.projectId),
      targetUserId: requesterUserId,
    };
  });
  // Activity row AFTER the role bump committed (best-effort audit;
  // the helper announces the live signal itself).
  if (approvedActivity !== null) {
    const approved = approvedActivity as {
      projectId: string;
      targetUserId: string;
    };
    await recordProjectActivity({
      projectId: approved.projectId,
      actorUserId: input.ownerUserId,
      type: "member:role-changed",
      payload: {
        role: "editor",
        previousRole: "viewer",
        targetUserId: approved.targetUserId,
      },
    });
  }
}

/**
 * Owner rejects a viewer's role-upgrade request.
 *
 * Atomic: (1) create rejected notification for the requester,
 * (2) mark the request notification as read on the owner's side.
 * @param input - Decision fields plus an optional rejection reason.
 * @throws {NotFoundError} if the request notification doesn't
 *   exist, was already decided (read), or doesn't belong to
 *   `ownerUserId`.
 */
export async function reject(
  input: DecisionInput & { reason?: string | null },
): Promise<void> {
  await db.transaction(async (tx) => {
    const req = await loadAndGate(tx, input);
    // Serialization point — see `approve`. The mark-read CAS decides the
    // request exactly once; a losing concurrent decision aborts here and
    // rolls back before the rejected notification is written.
    const won = await notificationRepo.markRead(req.id, input.ownerUserId, tx);
    if (!won) {
      throw new NotFoundError(t("server.error.notFound"));
    }
    const decider = await resolveActorProfile(input.ownerUserId);
    await notificationService.createRoleUpgradeRejected({
      requesterUserId: String(req.payload.requesterUserId),
      projectId: String(req.projectId),
      payload: {
        deciderName: decider.name,
        deciderHandle: decider.handle,
        projectName: input.projectName,
        projectSlug: input.projectSlug,
        reason: input.reason ?? null,
      },
      tx,
    });
  });
}

/**
 * Resolve a user's personal-studio display identity (name + slug = `@handle`)
 * for the bell payload. A user mid-onboarding (no personal studio) yields empty
 * strings; the bell renders the row without an actor link rather than crashing.
 * @param userId - The actor (requester / deciding owner) to resolve.
 * @returns The actor's display name + `@handle` (empty strings when unresolved).
 */
async function resolveActorProfile(
  userId: string,
): Promise<{ name: string; handle: string }> {
  const profiles = await studioService.getPersonalStudioProfilesByUserIds([
    userId,
  ]);
  const p = profiles.get(userId);
  return { name: p?.name ?? "", handle: p?.slug ?? "" };
}

interface LoadedRequest {
  id: string;
  projectId: string;
  payload: { requesterUserId: string };
}

/**
 * Load the request notification and enforce the decision gates:
 * it must exist, belong to the owner, be a role-upgrade-request type,
 * still be unread, and carry a valid requester id and project id.
 * @param tx - Active transaction handle; the read joins it so the gate sees
 *   a snapshot consistent with the rest of the decision.
 * @param input - Notification id and owner id identifying the request.
 * @returns The validated request id, project id, and requester id.
 * @throws {NotFoundError} if the notification is missing or already decided.
 * @throws {ForbiddenError} if the notification doesn't belong to the owner.
 * @throws {ValidationError} if the type, requester id, or project id is invalid.
 */
async function loadAndGate(
  tx: DbTx,
  input: DecisionInput,
): Promise<LoadedRequest> {
  const row = await notificationRepo.findById(input.notificationId, tx);
  if (!row) {
    throw new NotFoundError(t("server.error.notFound"));
  }
  if (row.userId !== input.ownerUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (row.type !== "access.role_upgrade_request") {
    throw new ValidationError(t("server.error.validation"));
  }
  if (row.readAt !== null) {
    // Already decided — second click on stale BellMenu state.
    throw new NotFoundError(t("server.error.notFound"));
  }
  const payload = row.payload as { requesterUserId?: unknown };
  if (typeof payload.requesterUserId !== "string") {
    throw new ValidationError(t("server.error.validation"));
  }
  if (row.projectId === null) {
    throw new ValidationError(t("server.error.validation"));
  }
  return {
    id: row.id,
    projectId: row.projectId,
    payload: { requesterUserId: payload.requesterUserId },
  };
}
