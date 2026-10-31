// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio invite-confirmation handshake service.
 *
 * An admin invites an existing account or an unregistered mailbox. The shared
 * invitation service arbitrates recipients under the target lock and settles
 * mail delivery. Account invitations receive a bell notification immediately;
 * mailbox invitations receive signup mail and become account invitations,
 * with a notification, after matching email verification. The original row
 * and share token survive that conversion. Membership starts only on confirm.
 *
 * Four operations:
 *   - `createInvite`: delegates creation, recipient arbitration, notification
 *     and mail settlement to the shared invitation service. Duplicate live
 *     invitations for the same recipient are rejected across both forms.
 *   - `confirmInvite`: the invitee accepts. In ONE tx: take the studio's row
 *     (refusing if it has been soft-deleted), the accept CAS (the
 *     serialization point — concurrent confirms apply EXACTLY ONCE), the member
 *     ceiling behind that lock, then upsert the membership, mark the bell
 *     notification read, and notify the inviting admin via
 *     `studio.invite_accepted`.
 *   - `declineInvite`: the invitee declines (membership untouched).
 *   - `revokeInvite`: the admin cancels a pending invite in their studio.
 *
 * Authorization (route layer enforces gates):
 *   - createInvite / revokeInvite: caller is the studio admin (`requireStudioRole('admin')`)
 *   - confirm / decline: caller owns the invite (the `invited_user_id` CAS guard)
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as invitesRepo from "@server/modules/studio/studioInvitations.repo.js";
import { createInvitation } from "@server/modules/invitation/invitation.service.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { db, getLimitsForStudio, trackServerEvent } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

/** Roles an admin may invite a user as — admin is granted via transfer only. */
type InvitableRole = "maintainer" | "guest";

/**
 * Invite an account or mailbox to a Studio through recipient arbitration.
 * @param slug - The Studio administered by the inviter.
 * @param inviterUserId - The acting administrator.
 * @param email - Recipient mailbox.
 * @param role - Granted membership role.
 * @param origin - Trusted frontend origin for invitation links.
 * @returns The committed invitation and its recipient delivery state.
 * @throws {NotFoundError} When the target or invitation is closed.
 * @throws {ConflictError} When duplicate, full, already a member or undelivered.
 * @throws {Error} When persistence fails.
 */
export async function createInvite(
  slug: string, inviterUserId: string, email: string, role: InvitableRole, origin?: string,
): Promise<{
  invitationId: string;
  inviteeUserId: string | null;
  inviteeEmail: string;
  studioName: string;
  inviterName: string;
  role: InvitableRole;
  pendingSignup: boolean;
}> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  const result = await createInvitation("studio", studio.id, inviterUserId, email, role, origin);
  trackServerEvent("member_invited", {
    userId: inviterUserId,
    insertId: `invite:${result.invitationId}`,
    properties: { studio_id: studio.id, scope: "studio", role, invitation_id: result.invitationId },
  });
  return {
    invitationId: result.invitationId, inviteeUserId: result.inviteeUserId, inviteeEmail: result.inviteeEmail,
    studioName: result.targetName, inviterName: result.inviterName, role, pendingSignup: result.pendingSignup,
  };
}

/**
 * The invitee confirms an invite — atomically turns the pending invite into a
 * real membership.
 *
 * In one transaction: (1) read which studio this invite points at, unlocked;
 * (2) take that studio's row, then ask separately whether it is still live and
 * refuse if not — the lock only serialises, it does not filter `deleted_at`;
 * (3) the accept CAS (`UPDATE … WHERE status='pending' AND invited_user_id =
 * receiver AND not expired`) — the serialization point, so concurrent confirms
 * (bell + email link, or a double click) apply EXACTLY ONCE; (4) the studio's
 * member ceiling, read and counted behind the lock taken in (2), so two
 * simultaneous confirms cannot both take the last seat; (5) upsert the
 * `studio_members` row (reviving a previously-kicked one); (6) mark the bell
 * notification read; (7) notify the inviting admin via
 * `studio.invite_accepted`.
 * @param invitationId - The `studio_invitations` row id
 * @param receiverUserId - The invitee confirming (must own the invite)
 * @throws {NotFoundError} the invite is missing, already decided, expired, not
 *   owned by `receiverUserId`, or its studio has been soft-deleted
 * @throws {ConflictError} the studio is at its member ceiling, or the user is
 *   somehow already an active member
 */
export async function confirmInvite(
  invitationId: string,
  receiverUserId: string,
): Promise<void> {
  const accepted = await acceptInTransaction(invitationId, receiverUserId);
  trackServerEvent("invitation_accepted", {
    userId: receiverUserId,
    insertId: `invite-accepted:${invitationId}`,
    properties: { studio_id: accepted.studioId, scope: "studio", role: accepted.role, invitation_id: invitationId },
  });
}

/**
 * The transaction behind {@link confirmInvite}.
 * @param invitationId - The `studio_invitations` row id
 * @param receiverUserId - The invitee confirming
 * @returns The accepted invite
 */
async function acceptInTransaction(
  invitationId: string,
  receiverUserId: string,
): Promise<{ studioId: string; role: string }> {
  return db.transaction(async (tx) => {
    // Which studio this invite is for, read WITHOUT a lock. The id is only
    // reachable through the invitation row, and the row lock below has to come
    // before the accept CAS, so it has to be read first. Safe: an invitation's
    // `studio_id` never changes, and whether this invite may still be accepted
    // is decided by the CAS, not by this read.
    const targetStudioId = await invitesRepo.getTargetStudioId(invitationId, tx);
    if (targetStudioId === null) {
      throw new NotFoundError(t("server.error.not_found"));
    }

    // Taken BEFORE the CAS, matching the order the project side has to use
    // against `archiveProject` (`projects` first, its invitations second).
    // Nothing sweeps studio invitations under the studio row, so here the
    // order costs nothing and prevents nothing; it keeps the two sides
    // identical, so a future sweep that takes the `studios` row first finds
    // this path already on the safe side of that cycle.
    //
    // This lock only serialises — it deliberately does not filter `deleted_at`
    // — so liveness is a separate question, asked right after.
    await studioRepo.lockStudio(targetStudioId, tx);
    if ((await studioRepo.getById(targetStudioId, tx)) === null) {
      // The studio went away while this invite sat in the bell. Accepting now
      // would leave a live member row on something nobody can open, which is
      // the orphan every project-scoped path takes its lock to prevent. Nothing
      // in the product soft-deletes a studio; the integration case reaches this
      // branch by doing it in SQL.
      throw new NotFoundError(t("server.error.not_found"));
    }

    // Serialization point: only the first confirm flips status to accepted;
    // a losing/expired/wrong-user attempt matches zero rows → null → abort.
    const accepted = await invitesRepo.acceptIfPending(
      invitationId,
      receiverUserId,
      tx,
    );
    if (!accepted) throw new NotFoundError(t("server.error.not_found"));

    // The REAL gate. Between sending and accepting the studio may have filled
    // up, and unlike the invite-time hint this one runs behind the row lock
    // above, so two simultaneous confirms cannot both see the same last seat.
    const { studio_members: memberLimit } = await getLimitsForStudio(
      accepted.studioId,
      tx,
    );
    const memberCount =
      (await studioRepo.countMembersByStudioIds([accepted.studioId], tx)).get(
        accepted.studioId,
      ) ?? 0;
    if (memberCount >= memberLimit) {
      // Different sentence from the invite-time one: the person reading this
      // is the invitee, who holds neither the tier nor any way to raise it.
      throw new ConflictError(
        t("server.studio.member_limit_reached_for_invitee"),
      );
    }

    const inserted = await studioMembersRepo.upsertMember(
      accepted.studioId,
      accepted.invitedUserId,
      accepted.role,
      accepted.invitedBy,
      tx,
    );
    if (!inserted) throw new ConflictError(t("server.studio.already_member"));

    let studioName = "";
    let studioId = "";
    if (accepted.notificationId) {
      const notif = await notificationRepo.findById(accepted.notificationId, tx);
      const payload = (notif?.payload ?? {}) as {
        studioName?: unknown;
        studioId?: unknown;
      };
      if (typeof payload.studioName === "string") studioName = payload.studioName;
      if (typeof payload.studioId === "string") studioId = payload.studioId;
      await notificationRepo.markRead(accepted.notificationId, receiverUserId, tx);
    }

    const profiles = await studioRepo.getPersonalProfilesByCreators(
      [accepted.invitedUserId],
      tx,
    );
    const invitee = profiles.get(accepted.invitedUserId);
    await notificationService.createStudioInviteAccepted({
      userId: accepted.invitedBy,
      payload: {
        studioId,
        studioName,
        inviteeUserId: accepted.invitedUserId,
        inviteeName: invitee?.name ?? "",
      },
      tx,
    });
    return { studioId: accepted.studioId, role: accepted.role };
  });
}

/**
 * The invitee declines an invite — marks it declined; membership untouched.
 *
 * In one transaction: the decline CAS (own LIVE pending → declined), then mark
 * the bell notification read. Idempotent on a second click: a missing /
 * already-decided / not-owned invite collapses to NotFound.
 * @param invitationId - The `studio_invitations` row id
 * @param receiverUserId - The invitee declining (must own the invite)
 * @throws {NotFoundError} the invite is missing, already decided, or not owned
 */
export async function declineInvite(
  invitationId: string,
  receiverUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const declined = await invitesRepo.declineIfPending(
      invitationId,
      receiverUserId,
      tx,
    );
    if (!declined) throw new NotFoundError(t("server.error.not_found"));
    if (declined.notificationId) {
      await notificationRepo.markRead(
        declined.notificationId,
        receiverUserId,
        tx,
      );
    }
  });
}

/**
 * The admin revokes (cancels) a pending invite in their studio.
 *
 * Resolves the studio by slug (the `studio_id` guard ensures the admin can only
 * revoke invites belonging to the studio they administer), then in one tx the
 * revoke CAS + marks the invitee's bell notification read (so the bell entry
 * disappears for them too).
 * @param slug - The admin's studio URL handle
 * @param invitationId - The `studio_invitations` row id to revoke
 * @throws {NotFoundError} studio not found, or no matching LIVE pending invite
 */
export async function revokeInvite(
  slug: string,
  invitationId: string,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  await db.transaction(async (tx) => {
    await studioRepo.lockStudio(studio.id, tx);
    if (!await studioRepo.getById(studio.id, tx)) throw new NotFoundError(t("server.error.not_found"));
    const revoked = await invitesRepo.revokeIfPending(
      invitationId,
      studio.id,
      tx,
    );
    if (!revoked) throw new NotFoundError(t("server.error.not_found"));
    if (revoked.notificationId && revoked.invitedUserId) {
      await notificationRepo.markRead(
        revoked.notificationId,
        revoked.invitedUserId,
        tx,
      );
    }
  });
}





