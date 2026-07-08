// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 *   - `confirmInvite`: the invitee accepts. In ONE tx: the accept CAS (the
 *     serialization point — concurrent confirms apply EXACTLY ONCE), then
 *     upsert the membership, mark the bell notification read, and notify the
 *     inviting admin via `studio.invite_accepted`.
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
import { getStudioMemberCap } from "@server/config/limits.js";
import { randomBytes } from "node:crypto";
import { db, env, getRedis } from "@breatic/core";
import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import type { InvitationLandingView } from "@breatic/shared";

/** Roles an admin may invite a user as — admin is granted via transfer only. */
type InvitableRole = "maintainer" | "guest";

/** Days a pending invite stays actionable before it self-voids. */
const INVITE_TTL_DAYS = 7;

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
 *   here (the `/studio-invite?token=` link is built from it). Omit to skip it.
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

  // Soft member cap (config/limits.yaml). Fail EARLY at invite time for a
  // good UX. The real guard is in confirmInvite — the studio may fill up
  // between sending and accepting. Counts active members (admin included).
  const memberCount =
    (await studioRepo.countMembersByStudioIds([studio.id])).get(studio.id) ?? 0;
  if (memberCount >= getStudioMemberCap()) {
    throw new ConflictError(t("server.studio.member_limit_reached"));
  }

  const profiles = await studioRepo.getPersonalProfilesByCreators([
    inviterUserId,
  ]);
  const inviter = profiles.get(inviterUserId);
  const inviterName = inviter?.name ?? "";
  const inviterHandle = inviter?.slug ?? "";
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  let invitationId = "";
  try {
    await db.transaction(async (tx) => {
      invitationId = await invitesRepo.createPending({
        studioId: studio.id,
        invitedUserId: invitee.id,
        role,
        invitedBy: inviterUserId,
        expiresAt,
        tx,
      });
      const notif = await notificationService.createStudioInviteRequest({
        userId: invitee.id,
        payload: {
          invitationId,
          studioId: studio.id,
          studioName: studio.name,
          studioSlug: studio.slug,
          inviterName,
          inviterHandle,
          role,
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
    const token = await issueInviteToken(invitationId);
    await sendBestEffortMail(
      buildStudioInvitationMail({
        inviteeEmail: email,
        inviterName,
        studioName: studio.name,
        role,
        inviteLink: `${origin}/studio-invite?token=${token}`,
      }),
      { userId: inviterUserId, subject: "studio_invite" },
    );
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
 * In one transaction: (1) the accept CAS (`UPDATE … WHERE status='pending' AND
 * invited_user_id = receiver AND not expired`) — the serialization point, so
 * concurrent confirms (bell + email link, or a double click) apply EXACTLY
 * ONCE; (2) upsert the `studio_members` row (reviving a previously-kicked one);
 * (3) mark the bell notification read; (4) notify the inviting admin via
 * `studio.invite_accepted`.
 * @param invitationId - The `studio_invitations` row id
 * @param receiverUserId - The invitee confirming (must own the invite)
 * @throws {NotFoundError} the invite is missing, already decided, expired, or
 *   not owned by `receiverUserId`
 * @throws {ConflictError} the user is somehow already an active member
 */
export async function confirmInvite(
  invitationId: string,
  receiverUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Serialization point: only the first confirm flips status to accepted;
    // a losing/expired/wrong-user attempt matches zero rows → null → abort.
    const accepted = await invitesRepo.acceptIfPending(
      invitationId,
      receiverUserId,
      tx,
    );
    if (!accepted) throw new NotFoundError(t("server.error.not_found"));

    // Soft member cap — the REAL guard: between sending and accepting, the
    // studio may have filled up (other confirms). Counts committed active
    // members (a 1-off race under simultaneous confirms is acceptable for a
    // soft business cap; concurrency isn't a data-integrity invariant here).
    const memberCount =
      (await studioRepo.countMembersByStudioIds([accepted.studioId])).get(
        accepted.studioId,
      ) ?? 0;
    if (memberCount >= getStudioMemberCap()) {
      throw new ConflictError(t("server.studio.member_limit_reached"));
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
    let studioSlug = "";
    if (accepted.notificationId) {
      const notif = await notificationRepo.findById(accepted.notificationId, tx);
      const payload = (notif?.payload ?? {}) as {
        studioName?: unknown;
        studioSlug?: unknown;
      };
      if (typeof payload.studioName === "string") studioName = payload.studioName;
      if (typeof payload.studioSlug === "string") studioSlug = payload.studioSlug;
      await notificationRepo.markRead(accepted.notificationId, receiverUserId, tx);
    }

    const profiles = await studioRepo.getPersonalProfilesByCreators([
      accepted.invitedUserId,
    ]);
    const invitee = profiles.get(accepted.invitedUserId);
    await notificationService.createStudioInviteAccepted({
      userId: accepted.invitedBy,
      payload: {
        studioName,
        studioSlug,
        inviteeName: invitee?.name ?? "",
        inviteeHandle: invitee?.slug ?? "",
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

/** TTL of the email-link token — matches the invite's 7-day window. */
const INVITE_TOKEN_TTL_SECONDS = INVITE_TTL_DAYS * 24 * 60 * 60;

/**
 * Issue a one-time email-link token for an invite (mirrors the email-verify
 * token): a 64-hex random token stored in Redis (`{env}:studio-invite:{token}`
 * → invitationId) with the invite's 7-day TTL. The route embeds it in the
 * `/studio-invite?token=` link.
 * @param invitationId - The invitation the token resolves to
 * @returns The 64-char hex token to embed in the invite link
 */
export async function issueInviteToken(invitationId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await getRedis().set(
    `${env.ENV}:studio-invite:${token}`,
    invitationId,
    "EX",
    INVITE_TOKEN_TTL_SECONDS,
  );
  return token;
}

/**
 * Resolve an email-link token to its invitation id WITHOUT consuming it — the
 * landing page reads the invite summary first; the token is deleted only once
 * the invitee acts (via {@link consumeInviteToken}).
 * @param token - The one-time token from the invite link
 * @returns The invitation id, or null if the token is missing / expired
 */
export async function peekInviteToken(token: string): Promise<string | null> {
  return getRedis().get(`${env.ENV}:studio-invite:${token}`);
}

/**
 * Consume (delete) an email-link token after the invitee has acted on it, so
 * the link is single-use.
 * @param token - The one-time token to delete
 */
export async function consumeInviteToken(token: string): Promise<void> {
  await getRedis().del(`${env.ENV}:studio-invite:${token}`);
}

/**
 * Resolve an email-link token to the landing-page view (without consuming it).
 *
 * The `/studio-invite` page renders this before the invitee acts: studio +
 * inviter names, granted role, an `expired` flag, and `isInvitee` (true only
 * when the logged-in user is the invitee — gates the confirm button). No
 * invitation / invitee id leaks out.
 * @param token - The one-time token from the invite link
 * @param viewerUserId - The logged-in user (sets `isInvitee`)
 * @returns The landing view, or null if the token / invite is gone
 */
export async function getInviteForLanding(
  token: string,
  viewerUserId: string,
): Promise<InvitationLandingView | null> {
  const invitationId = await peekInviteToken(token);
  if (!invitationId) return null;
  const row = await invitesRepo.findLandingById(invitationId);
  if (!row) return null;
  return {
    studioName: row.studioName,
    studioSlug: row.studioSlug,
    inviterName: row.inviterName,
    role: row.role,
    expired: row.expiresAt.getTime() <= Date.now(),
    isInvitee: row.invitedUserId === viewerUserId,
  };
}

/**
 * Respond to an invite from the email-link page — confirm or decline, then
 * consume the one-time token (single-use). The `userId` flows into the same CAS
 * guard as the bell path, so only the invitee can confirm/decline their own
 * invite. Returns the studio slug so the page can redirect on confirm.
 * @param token - The one-time token from the invite link
 * @param action - 'confirm' (accept + become a member) or 'decline'
 * @param userId - The logged-in user acting (must be the invitee)
 * @returns `{ studioSlug }` for the post-confirm redirect
 * @throws {NotFoundError} token / invite missing, already decided, expired, or
 *   not owned by `userId`
 */
export async function respondToInvite(
  token: string,
  action: "confirm" | "decline",
  userId: string,
): Promise<{ studioSlug: string }> {
  const invitationId = await peekInviteToken(token);
  if (!invitationId) throw new NotFoundError(t("server.error.not_found"));
  const landing = await invitesRepo.findLandingById(invitationId);
  if (!landing) throw new NotFoundError(t("server.error.not_found"));
  if (action === "confirm") {
    await confirmInvite(invitationId, userId);
  } else {
    await declineInvite(invitationId, userId);
  }
  await consumeInviteToken(token);
  return { studioSlug: landing.studioSlug };
}
