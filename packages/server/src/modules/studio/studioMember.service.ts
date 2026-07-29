// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio member management service — remove / change-role.
 *
 * The auth + data-integrity critical path for team studios. Membership writes go
 * through `studioMembersRepo` (domain); a kick fans out to `projectMembersRepo`
 * (core) to revoke project access + reassign owned projects, all in one tx.
 * Inviting now goes through the invite-confirm handshake (studioInvite.service,
 * 2026-06-14); admin grant/demote goes through transfer-admin
 * (studioTransfer.service). Route-layer `requireStudioRole('admin')` gates who
 * may call these; the service still enforces the data invariants (personal
 * studio, sole admin).
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { db, projectMembersRepo } from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

/** Roles an admin may grant by change-role; admin is excluded. */
type GrantableRole = "maintainer" | "guest";

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
): Promise<void> {
  await detachMember(slug, targetUserId, "kick");
}

/**
 * Leave a studio of one's own accord — one atomic transaction that revokes the
 * departing member's access across ALL the studio's projects AND hands every
 * project they own to the studio's admin.
 *
 * Not the mirror image of {@link removeMember}: the actor IS the departing
 * member, so there is no third party to inherit their projects. The inheritor
 * is resolved from the studio's admin instead — see {@link detachMember}.
 *
 * Refuses personal studios (you cannot leave yourself) and the sole admin
 * (they must transfer the studio first).
 * @param slug - The studio's URL handle
 * @param userId - The member choosing to leave
 * @throws {NotFoundError} studio not found, or the user is not a member
 * @throws {ForbiddenError} the studio is personal
 * @throws {ConflictError} the user is the sole admin (transfer first)
 * @throws {AppError} the studio has no active admin (corrupt data)
 */
export async function leaveStudio(slug: string, userId: string): Promise<void> {
  await detachMember(slug, userId, "leave");
}

/**
 * The shared body of {@link removeMember} and {@link leaveStudio}.
 *
 * Both detach one member and hand their owned projects to the studio's admin;
 * they differ only in which error a same-admin target produces. Keeping one
 * implementation means "who inherits" is defined in exactly one place — the
 * kick path used to pass the acting admin, which happened to be equivalent
 * only because the route gate guaranteed the actor was the admin, and which
 * had no answer at all once members could leave on their own.
 *
 * Ordering inside the transaction is load-bearing:
 *   1. lock the ADMIN row first, then the target's — the transfer path takes
 *      them in that order (demote outgoing, promote incoming), so grabbing
 *      them the other way round deadlocks whenever the target happens to be
 *      a transfer's recipient
 *   2. read the owned-project list BEFORE the soft delete, or the rows are
 *      already gone
 *   3. soft-delete the target's project rows BEFORE handing them over —
 *      `materializeOwner` upserts and clears `deleted_at`, so the one-owner
 *      partial unique index rejects the handover while the leaver still holds
 *      an owner row
 * @param slug - The studio's URL handle
 * @param targetUserId - The member being detached
 * @param mode - `kick` (an admin removes someone) or `leave` (self-service)
 * @throws {NotFoundError} studio not found, or the target is not a member
 * @throws {ForbiddenError} the studio is personal
 * @throws {ConflictError} the target is the sole admin
 * @throws {AppError} the studio has no active admin (corrupt data)
 */
async function detachMember(
  slug: string,
  targetUserId: string,
  mode: "kick" | "leave",
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }

  await db.transaction(async (tx) => {
    // Locks first, in the order documented above. Both reads are inside the
    // transaction so a concurrent transfer cannot commit between the check
    // and the write — the interleaving that would otherwise soft-delete a
    // freshly promoted admin and leave the studio with none.
    const adminUserId = await studioMembersRepo.lockAdminUserId(studio.id, tx);
    const role = await studioMembersRepo.lockMemberRole(studio.id, targetUserId, tx);

    if (!role) throw new NotFoundError(t("server.error.not_found"));
    if (role === "admin") {
      throw new ConflictError(
        mode === "leave"
          ? t("server.studio.leave_last_admin")
          : t("server.studio.remove_last_admin"),
      );
    }
    if (adminUserId === null) {
      // No admin to inherit. Aborting keeps the damage where it is; carrying
      // on would add ownerless projects to an already-broken studio.
      throw new ConflictError(t("server.error.conflict"));
    }

    const owned = await projectMembersRepo.listOwnedProjectsInStudio(
      studio.id,
      targetUserId,
      tx,
    );
    await projectMembersRepo.softDeleteAllInStudioForUser(studio.id, targetUserId, tx);
    for (const projectId of owned) {
      await projectMembersRepo.materializeOwner(projectId, adminUserId, tx);
    }
    await studioMembersRepo.softDelete(studio.id, targetUserId, tx);
  });
}

/**
 * Change an existing member's role (maintainer ↔ guest) — admin grant/demote is
 * NOT here (that goes through transfer-admin).
 *
 * Refuses personal studios, a non-member (NotFound), and any attempt to change
 * the admin's role (Conflict — the admin demotes only by transferring).
 * @param slug - The studio's URL handle
 * @param targetUserId - The member whose role changes
 * @param role - The new role (maintainer | guest)
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
