// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project members service — invite / change-role / remove with
 * permission and invariant enforcement.
 *
 * The service layer sits between Hono routes and the repo. Routes
 * have already enforced `requireRole('owner')` for write operations,
 * so the service only verifies invariants that are intrinsic to the
 * member graph itself (no double-owner, owner cannot be removed,
 * cannot demote owner without transfer).
 *
 * v10 §7.2.5 mandates that every member-state change publish a Redis
 * pub/sub event so collab can broadcast invalidation to connected
 * clients. The Redis bus is wired in PR-C; for V1 we expose the
 * publish-call site (commented as TODO) so PR-C is a single
 * line-replacement, and we never silently drop a notification.
 */

import { db, logger, projectMembersRepo } from "@breatic/core";
import { publishMembersChanged } from "@breatic/core";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { ConflictError, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import type { ProjectMember, ProjectRole } from "@breatic/shared";

/**
 * List active members of a project (caller has already checked access).
 * @param projectId - Project UUID
 * @returns The project's active member records
 */
export async function list(projectId: string): Promise<ProjectMember[]> {
  return projectMembersRepo.listByProjectId(projectId);
}

/**
 * List a project's eligible owner-transfer recipients — active project members
 * (`editor` / `viewer`) who are ALSO active non-guest members of the project's
 * studio (ADR D3, 2026-07-08). The transfer route gates the caller as the
 * `owner`; the frontend recipient picker renders exactly this set (merged with
 * display profiles). Keeping the two-layer eligibility here means the picker can
 * never offer a recipient the transfer would reject.
 * @param projectId - Project UUID
 * @returns The eligible recipients' user ids + their current project role
 */
export async function listTransferCandidates(
  projectId: string,
): Promise<Array<{ userId: string; role: Exclude<ProjectRole, "owner"> }>> {
  return projectMembersRepo.listTransferCandidates(projectId);
}

/**
 * Get the owner's user id for a project (used by notification
 * dispatch — e.g. access request created → mail owner).
 * @param projectId - Project UUID
 * @returns Owner's user UUID, or null if the project has no owner
 *   (should not happen — every project gets an owner row in the
 *   same tx as project creation)
 */
export async function getOwner(projectId: string): Promise<string | null> {
  return projectMembersRepo.getOwner(projectId);
}

/**
 * Change a member's role (editor ↔ viewer; owner cannot be PATCH'd).
 *
 * The role check and the write share one transaction, and the check takes a
 * row lock — see {@link remove} for why an unlocked check here is not a check
 * at all.
 * @param projectId - Project UUID
 * @param targetUserId - Member whose role is changing
 * @param newRole - 'editor' or 'viewer'
 * @param actorUserId - Acting user (activity feed attribution); optional for legacy callers
 * @throws {NotFoundError} if no active member row matches
 * @throws {ConflictError} if the target is the owner (use transfer-owner)
 */
export async function changeRole(
  projectId: string,
  targetUserId: string,
  newRole: Exclude<ProjectRole, "owner">,
  actorUserId?: string,
): Promise<void> {
  const current = await db.transaction(async (tx) => {
    const role = await projectMembersRepo.lockMemberRole(
      projectId,
      targetUserId,
      tx,
    );
    if (role === null) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (role === "owner") {
      throw new ConflictError(t("server.error.conflict"));
    }
    const updated = await projectMembersRepo.updateRole(
      projectId,
      targetUserId,
      newRole,
      tx,
    );
    if (!updated) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    return role;
  });
  await publishMembersChanged(projectId, {
    affectedUserId: targetUserId,
    action: "update",
    newRole,
  });
  await recordProjectActivity({
    projectId,
    actorUserId: actorUserId ?? null,
    type: "member:role-changed",
    payload: { role: newRole, previousRole: current, targetUserId },
  });
}

/**
 * Remove a member from a project (soft delete).
 *
 * The owner cannot be removed (ownership changes hands only via
 * transfer-owner). Removing yourself is allowed if you are not the owner.
 *
 * The role check and the soft delete share one transaction, and the check
 * takes a row lock. Read outside a transaction, "you are not the owner" is a
 * claim about the past: an owner transfer confirming in the gap promotes this
 * very row, and the delete — which matches on `deleted_at IS NULL` alone —
 * then takes the project's only owner with it. The one-owner partial unique
 * index cannot save us, because it forbids two owners, not zero.
 * @param projectId - Project UUID
 * @param targetUserId - Member being removed
 * @param actorUserId - Acting user (activity feed attribution); optional for legacy callers
 * @throws {NotFoundError} if no active member row matches
 * @throws {ConflictError} if the target is the owner
 */
export async function remove(
  projectId: string,
  targetUserId: string,
  actorUserId?: string,
): Promise<void> {
  const current = await db.transaction(async (tx) => {
    const role = await projectMembersRepo.lockMemberRole(
      projectId,
      targetUserId,
      tx,
    );
    if (role === null) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    if (role === "owner") {
      throw new ConflictError(t("server.error.conflict"));
    }
    const removed = await projectMembersRepo.softDelete(
      projectId,
      targetUserId,
      tx,
    );
    if (!removed) {
      throw new NotFoundError(t("server.error.not_found"));
    }
    return role;
  });
  try {
    await publishMembersChanged(projectId, {
      affectedUserId: targetUserId,
      action: "remove",
    });
  } catch (err) {
    // The row is already gone. Failing the request here would tell the
    // caller the removal did not happen when it did.
    logger.error({ err, projectId, targetUserId }, "project_member_removed_publish_failed");
  }
  await recordProjectActivity({
    projectId,
    actorUserId: actorUserId ?? null,
    type: "member:removed",
    payload: { previousRole: current, targetUserId },
  });
}

/**
 * Leave a project of one's own accord.
 *
 * An archived project freezes its membership, and the owner has to hand the
 * project over first; both are refused with their own sentence. The owner
 * check here reads outside the lock only to pick that sentence — the locked
 * check inside {@link remove} is what keeps a transfer landing in between
 * from taking the project's only owner with it.
 * @param projectId - Project UUID
 * @param userId - The member leaving
 * @throws {NotFoundError} if the caller is not an active member
 * @throws {ConflictError} if the project is archived, or the caller owns it
 */
export async function leave(projectId: string, userId: string): Promise<void> {
  const access = await projectMembersRepo.getAccess(projectId, userId);
  if (access === null) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  if (access.archived) {
    throw new ConflictError(t("server.project.archived"));
  }
  if (access.role === "owner") {
    throw new ConflictError(t("server.project.leave_owner"));
  }
  await remove(projectId, userId, userId);
}
