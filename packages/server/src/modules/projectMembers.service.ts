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

import * as projectMembersRepo from "@server/modules/projectMembers.repo.js";
import { publishMembersChanged } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import type { ProjectMember, ProjectRole } from "@breatic/shared";

/** List active members of a project (caller has already checked access). */
export async function list(projectId: string): Promise<ProjectMember[]> {
  return projectMembersRepo.listByProjectId(projectId);
}

/**
 * Get the owner's user id for a project (used by notification
 * dispatch — e.g. access request created → mail owner).
 *
 * @param projectId - Project UUID
 * @returns Owner's user UUID, or null if the project has no owner
 *   (should not happen — every project gets an owner row in the
 *   same tx as project creation)
 */
export async function getOwner(projectId: string): Promise<string | null> {
  return projectMembersRepo.getOwner(projectId);
}

/**
 * Invite a user to a project (or revive a previously-removed member).
 *
 * Constraints:
 *   - role must be `'edit'` or `'view'` (owner promotion is the
 *     transfer-owner endpoint, V1-deferred — route layer Zod also
 *     enforces this).
 *   - inviting the existing active owner is rejected as Conflict.
 *
 * @param projectId - Project UUID
 * @param targetUserId - User being invited
 * @param role - 'edit' or 'view'
 * @param inviterId - The owner performing the invite
 * @throws {@link ConflictError} if the target is already the owner
 */
export async function invite(
  projectId: string,
  targetUserId: string,
  role: Exclude<ProjectRole, "owner">,
  inviterId: string,
): Promise<void> {
  const existing = await projectMembersRepo.getRole(projectId, targetUserId);
  if (existing === "owner") {
    throw new ConflictError(t("server.error.conflict"));
  }
  await projectMembersRepo.upsertMember(projectId, targetUserId, role, inviterId);
  await publishMembersChanged(projectId, {
    affectedUserId: targetUserId,
    action: "invite",
    newRole: role,
  });
}

/**
 * Change a member's role (edit ↔ view; owner cannot be PATCH'd).
 *
 * @param projectId - Project UUID
 * @param targetUserId - Member whose role is changing
 * @param newRole - 'edit' or 'view'
 * @throws {@link NotFoundError} if no active member row matches
 * @throws {@link ConflictError} if the target is the owner (use
 *   transfer-owner, V1-deferred)
 */
export async function changeRole(
  projectId: string,
  targetUserId: string,
  newRole: Exclude<ProjectRole, "owner">,
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
}

/**
 * Remove a member from a project (soft delete).
 *
 * The owner cannot be removed (V1: transfer-owner is the only way
 * to demote an owner, and that endpoint is deferred). Removing
 * yourself is allowed if you are not the owner.
 *
 * @param projectId - Project UUID
 * @param targetUserId - Member being removed
 * @throws {@link NotFoundError} if no active member row matches
 * @throws {@link ConflictError} if the target is the owner
 */
export async function remove(
  projectId: string,
  targetUserId: string,
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
}
