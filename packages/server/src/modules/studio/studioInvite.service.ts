// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio invite-confirmation handshake service (2026-06-14).
 *
 * Replaces the slice-3 "invite takes effect immediately" path: an admin's
 * invite now creates a PENDING `studio_invitations` row + an actionable bell
 * notification; the invitee becomes a real `studio_members` row only when they
 * confirm (via the bell or the email link). This mirrors the transfer-admin
 * handshake, but the source of truth is the `studio_invitations` row (so admins
 * can see "invited (pending)" in the Members tab), not the notification.
 *
 * Four operations:
 *   - `createInvite`: admin invites a registered user. Validates, then in ONE
 *     tx creates the pending row + the `studio.invite_request` notification +
 *     links them, then sends the optional invite email (best-effort, when an
 *     origin is given). A second LIVE pending for the same (studio, invitee)
 *     hits the partial unique → ConflictError.
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
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as invitesRepo from "@server/modules/studio/studioInvitations.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import { buildStudioInvitationMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db, getLimitsForStudio } from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import { decisionLink } from "@server/utils/decision-link.js";
import {
  getDecisionWindowMs,
} from "@server/config/limits.js";

/** Roles an admin may invite a user as — admin is granted via transfer only. */
type InvitableRole = "maintainer" | "guest";

/**
 * Invite a registered user into a studio — creates a PENDING invite (it does
 * NOT take effect until the invitee confirms) plus the actionable bell
 * notification, atomically.
 *
 * Resolves the studio by slug, refuses personal studios, looks the invitee up
 * by email (unregistered → NotFound), and refuses re-inviting an already-active
 * member, then sends the optional invite email here (best-effort) when an
 * `origin` is given. The `studio_invitations_one_pending` partial unique maps a
 * duplicate LIVE pending to a ConflictError.
 * @param slug - The studio's URL handle
 * @param inviterUserId - The acting admin (becomes `invitedBy`; name in payload)
 * @param email - The invitee's email; must belong to a registered user
 * @param role - The granted studio role (maintainer | guest; never admin)
 * @param origin - Request Origin; when set, the best-effort invite email is sent
 *   here (the `/decision?token=` link is built from it). Omit to skip it.
 * @returns The new invitation id, the invitee's id + email, and the studio /
 *   inviter names + role
 * @throws {NotFoundError} studio not found, or no user with that email
 * @throws {ForbiddenError} the studio is personal (cannot have invited members)
 * @throws {ConflictError} the user is already an active member, or already has
 *   a live pending invite to this studio
 */
export async function createInvite(
  slug: string,
  inviterUserId: string,
  email: string,
  role: InvitableRole,
  origin?: string,
): Promise<{
  invitationId: string;
  inviteeUserId: string;
  inviteeEmail: string;
  studioName: string;
  inviterName: string;
  role: InvitableRole;
}> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  const invitee = await usersRepo.getUserByEmail(email);
  if (!invitee) throw new NotFoundError(t("server.studio.email_not_registered"));
  const existingRole = await studioMembersRepo.getRole(studio.id, invitee.id);
  if (existingRole) throw new ConflictError(t("server.studio.already_member"));

  // The member ceiling of whoever currently administers this studio. Failing
  // EARLY here is for the admin's benefit — they learn there is no room before
  // an email goes out. It is NOT the gate: the studio can fill up between
  // sending and accepting, which is what the check in `confirmInvite` is for,
  // and only that one runs behind a row lock. Counts active members, the admin
  // among them.
  const { studio_members: memberLimit } = await getLimitsForStudio(studio.id);
  const memberCount =
    (await studioRepo.countMembersByStudioIds([studio.id])).get(studio.id) ?? 0;
  if (memberCount >= memberLimit) {
    throw new ConflictError(
      t("server.studio.member_limit_reached", { limit: memberLimit }),
    );
  }

  const profiles = await studioRepo.getPersonalProfilesByCreators([
    inviterUserId,
  ]);
  const inviter = profiles.get(inviterUserId);
  const inviterName = inviter?.name ?? "";
  const expiresAt = new Date(Date.now() + getDecisionWindowMs());

  let invitationId = "";
  // The bell row builds its link from this, same as the email.
  let shareToken = "";
  try {
    await db.transaction(async (tx) => {
      // Reap any expired-but-still-'pending' invite for this (studio, invitee)
      // first: the one-pending partial unique index ignores expiry (a partial
      // predicate can't reference now()), so a timed-out invite would otherwise
      // trip it and reject the re-invite with a spurious "already invited"
      // (#1769). Same transaction → freeing the slot and taking it are atomic.
      await invitesRepo.expireStalePending(studio.id, invitee.id, tx);
      ({ id: invitationId, shareToken } = await invitesRepo.createPending({
        studioId: studio.id,
        invitedUserId: invitee.id,
        role,
        invitedBy: inviterUserId,
        expiresAt,
        tx,
      }));
      const notif = await notificationService.createStudioInviteRequest({
        userId: invitee.id,
        payload: {
          invitationId,
          studioId: studio.id,
          studioName: studio.name,
          inviterUserId,
          inviterName,
          role,
          shareToken,
        },
        expiresAt,
        tx,
      });
      await invitesRepo.attachNotification(invitationId, notif.id, tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.studio.already_invited"));
    }
    throw err;
  }

  // Best-effort invite email — the bell notification is the always-delivered
  // path; this only fires when an SMTP backend is configured and the caller
  // passed an origin. A send failure must NOT fail the request.
  if (origin) {
    await sendBestEffortMail(async () => {
      return buildStudioInvitationMail({
        inviteeEmail: email,
        inviterName,
        studioName: studio.name,
        role,
        inviteLink: decisionLink(origin, shareToken),
      });
    }, { userId: inviterUserId, subject: "studio_invite" });
  }

  return {
    invitationId,
    inviteeUserId: invitee.id,
    inviteeEmail: email,
    studioName: studio.name,
    inviterName,
    role,
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
  await db.transaction(async (tx) => {
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
    // against `deleteProject` (`projects` first, its invitations second). There
    // is no studio-delete cascade to deadlock with YET — studio deletion is not
    // built (#26) — so today this order costs nothing and prevents nothing.
    // Keeping the two sides identical is the point: whoever builds #26 will
    // take the `studios` row first, as every cascade here does, and this path
    // is then already on the safe side of that cycle rather than needing to be
    // found and changed. `createInvite` above is NOT: it writes
    // `studio_invitations` without taking the studio row at all, so #26 has to
    // look at it as well (the project side had exactly this shape and it was a
    // real cycle — see `invite-lock-order.integration.test.ts`).
    //
    // This lock only serialises — it deliberately does not filter `deleted_at`
    // — so liveness is a separate question, asked right after.
    await studioRepo.lockStudio(targetStudioId, tx);
    if ((await studioRepo.getById(targetStudioId, tx)) === null) {
      // The studio went away while this invite sat in the bell. Accepting now
      // would leave a live member row on something nobody can open, which is
      // the orphan every project-scoped path takes its lock to prevent. Nothing
      // in the product soft-deletes a studio yet (#26); the integration case
      // reaches this branch by doing it in SQL.
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
    const revoked = await invitesRepo.revokeIfPending(
      invitationId,
      studio.id,
      tx,
    );
    if (!revoked) throw new NotFoundError(t("server.error.not_found"));
    if (revoked.notificationId) {
      await notificationRepo.markRead(
        revoked.notificationId,
        revoked.invitedUserId,
        tx,
      );
    }
  });
}





