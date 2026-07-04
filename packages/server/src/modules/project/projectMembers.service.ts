// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import { projectMembersRepo } from "@breatic/core";
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
 * @param projectId - Project UUID
 * @param targetUserId - Member whose role is changing
 * @param newRole - 'editor' or 'viewer'
 * @param actorUserId - Acting user (activity feed attribution); optional for legacy callers
 * @throws {NotFoundError} if no active member row matches
 * @throws {ConflictError} if the target is the owner (use
 *   transfer-owner, V1-deferred)
 */
export async function changeRole(
  projectId: string,
  targetUserId: string,
  newRole: Exclude<ProjectRole, "owner">,
  actorUserId?: string,
): Promise<void> {
  const current = await projectMembersRepo.getRole(projectId, targetUserId);
  if (current === null) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  if (current === "owner") {
    throw new ConflictError(t("server.error.conflict"));
  }
  const updated = await projectMembersRepo.updateRole(
    projectId,
    targetUserId,
    newRole,
  );
  if (!updated) {
    throw new NotFoundError(t("server.error.not_found"));
  }
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
 * The owner cannot be removed (V1: transfer-owner is the only way
 * to demote an owner, and that endpoint is deferred). Removing
 * yourself is allowed if you are not the owner.
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
  const current = await projectMembersRepo.getRole(projectId, targetUserId);
  if (current === null) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  if (current === "owner") {
    throw new ConflictError(t("server.error.conflict"));
  }
  const removed = await projectMembersRepo.softDelete(projectId, targetUserId);
  if (!removed) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  await publishMembersChanged(projectId, {
    affectedUserId: targetUserId,
    action: "remove",
  });
  await recordProjectActivity({
    projectId,
    actorUserId: actorUserId ?? null,
    type: "member:removed",
    payload: { previousRole: current, targetUserId },
  });
}
