// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member management service (slice 3) — invite / remove / change-role.
 *
 * The auth + data-integrity critical path for team studios. Membership writes go
 * through `studioMembersRepo` (domain); a kick fans out to `projectMembersRepo`
 * (core) to revoke project access + reassign owned projects, all in one tx.
 * Admin grant/demote is NOT here — that goes through transfer-admin (a
 * two-step handshake; see studioTransfer.service). Route-layer
 * `requireStudioRole('admin')` gates who may call these; the service still
 * enforces the data invariants (personal studio, sole admin, already-member).
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { db, projectMembersRepo } from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

/** Roles an admin may grant by invite or change-role; admin is excluded. */
type GrantableRole = "creator" | "member";

/**
 * Invite a registered user into a studio — takes effect immediately (slice 3:
 * no accept step), and drops an informational notification in their inbox.
 *
 * Resolves the studio by slug, refuses personal studios, looks the invitee up
 * by email (unregistered → NotFound, surfaced to the admin as "email not registered"),
 * then in one tx upserts the membership (revives a previously-kicked row) and
 * writes the notification. An upsert that hits an already-active member
 * returns false → ConflictError (no silent role overwrite).
 * @param slug - The studio's URL handle
 * @param inviterUserId - The acting admin (becomes `addedBy`; name in payload)
 * @param email - The invitee's email; must belong to a registered user
 * @param role - The granted studio role (creator | member; never admin)
 * @throws {NotFoundError} studio not found, or no user with that email
 * @throws {ForbiddenError} the studio is personal (cannot have invited members)
 * @throws {ConflictError} the user is already an active member
 */
export async function inviteMember(
  slug: string,
  inviterUserId: string,
  email: string,
  role: GrantableRole,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  const invitee = await usersRepo.getUserByEmail(email);
  if (!invitee) throw new NotFoundError(t("server.studio.email_not_registered"));
  const names = await studioRepo.getPersonalNamesByCreators([inviterUserId]);
  const inviterName = names.get(inviterUserId) ?? "";

  await db.transaction(async (tx) => {
    const inserted = await studioMembersRepo.upsertMember(
      studio.id,
      invitee.id,
      role,
      inviterUserId,
      tx,
    );
    if (!inserted) throw new ConflictError(t("server.studio.already_member"));
    await notificationService.createStudioMemberInvited({
      userId: invitee.id,
      payload: { studioName: studio.name, inviterName, role },
      tx,
    });
  });
}

/**
 * Remove (kick) a member from a studio — one atomic transaction that revokes
 * their access across ALL the studio's projects AND transfers every project
 * they own to the acting admin.
 *
 * Refuses personal studios and the sole admin (admin must transfer first).
 * Order matters: the owned-project list is read BEFORE the soft-delete (else
 * the rows are already gone), then access is cleared, then each owned project
 * is reassigned to `actorUserId` (the kicked owner's row is already
 * soft-deleted in the same tx, so the one-owner partial unique is satisfied).
 * Only `role` is touched — `created_by_user_id` / `added_by` audit fields are
 * never rewritten. Credits are NOT touched (user decision 2026-06-08).
 * @param slug - The studio's URL handle
 * @param targetUserId - The member being removed
 * @param actorUserId - The acting admin who inherits the target's owned projects
 * @throws {NotFoundError} studio not found, or target is not a member
 * @throws {ForbiddenError} the studio is personal
 * @throws {ConflictError} the target is the sole admin (transfer admin first)
 */
export async function removeMember(
  slug: string,
  targetUserId: string,
  actorUserId: string,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  const role = await studioMembersRepo.getRole(studio.id, targetUserId);
  if (!role) throw new NotFoundError(t("server.error.not_found"));
  if (role === "admin") {
    throw new ConflictError(t("server.studio.remove_last_admin"));
  }

  await db.transaction(async (tx) => {
    const owned = await projectMembersRepo.listOwnedProjectsInStudio(
      studio.id,
      targetUserId,
      tx,
    );
    await projectMembersRepo.softDeleteAllInStudioForUser(studio.id, targetUserId, tx);
    for (const projectId of owned) {
      await projectMembersRepo.materializeOwner(projectId, actorUserId, tx);
    }
    await studioMembersRepo.softDelete(studio.id, targetUserId, tx);
  });
}

/**
 * Change an existing member's role (creator ↔ member) — admin grant/demote is
 * NOT here (that goes through transfer-admin).
 *
 * Refuses personal studios, a non-member (NotFound), and any attempt to change
 * the admin's role (Conflict — the admin demotes only by transferring).
 * @param slug - The studio's URL handle
 * @param targetUserId - The member whose role changes
 * @param role - The new role (creator | member)
 * @throws {NotFoundError} studio not found, or target is not a member
 * @throws {ForbiddenError} the studio is personal
 * @throws {ConflictError} the target is the admin (demote via transfer)
 */
export async function updateMemberRole(
  slug: string,
  targetUserId: string,
  role: GrantableRole,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  const current = await studioMembersRepo.getRole(studio.id, targetUserId);
  if (!current) throw new NotFoundError(t("server.error.not_found"));
  if (current === "admin") {
    throw new ConflictError(t("server.studio.cannot_change_admin_role"));
  }
  const ok = await studioMembersRepo.updateRole(studio.id, targetUserId, role);
  if (!ok) throw new NotFoundError(t("server.error.not_found"));
}
