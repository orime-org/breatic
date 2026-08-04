// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project invite-confirmation handshake service (2026-06-18, #1337).
 *
 * The direct mirror of the studio invite service for the project membership
 * layer. Replaces the old `share_links` model (a link consumer joined on click,
 * with no decline state and no invitee-side handshake): an owner's invite now
 * creates a PENDING `project_invitations` row + an actionable bell notification;
 * the invitee becomes a real `project_members` row only when they confirm (via
 * the bell or the email link). The source of truth is the `project_invitations`
 * row (so the owner can see "invited (pending)"), not the notification.
 *
 * Five operations:
 *   - `createInvite`: owner invites a registered user. Validates, then in ONE
 *     tx creates the pending row + the `project.invite_request` notification +
 *     links them. Returns the invitee + invitation id so the route layer can
 *     send the (optional) email. A second LIVE pending for the same
 *     (project, invitee) hits the partial unique → ConflictError.
 *   - `confirmInvite`: the invitee accepts. In ONE tx: the accept CAS (the
 *     serialization point — concurrent confirms apply EXACTLY ONCE), then
 *     upsert the membership, mark the bell notification read, and notify the
 *     inviting owner via `project.invite_accepted`.
 *   - `declineInvite`: the invitee declines (membership untouched).
 *   - `respondToInvite`: the email-link path — peek token → confirm/decline →
 *     consume token.
 *   - `revokeInvite`: the owner cancels a pending invite in their project.
 *
 * Authorization (route layer enforces gates):
 *   - createInvite / revokeInvite: caller is the project owner
 *     (`requireRole('owner')`)
 *   - confirm / decline: caller owns the invite (the `invited_user_id` CAS guard)
 */

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as invitesRepo from "@server/modules/project-invite/projectInvitations.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import { getProjectCollaboratorCap } from "@server/config/limits.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { buildProjectInvitationMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { projectMembersRepo } from "@breatic/core";
import { type ProjectRole, t } from "@breatic/shared";
import { decisionLink } from "@server/utils/decision-link.js";
import type {
  InvitableProjectRole,
  PendingProjectInvitationSummary,
} from "@breatic/shared";
import {
  deferredRequestExpiry,
  getDeferredRequestTtlDays,
} from "@server/config/limits.js";

/**
 * Invite a registered user into a project — creates a PENDING invite (it does
 * NOT take effect until the invitee confirms) plus the actionable bell
 * notification, atomically.
 *
 * Resolves the project by id, looks the invitee up by email (unregistered →
 * NotFound), and refuses re-inviting a user who already has an active
 * `project_members` row (owner / editor / viewer). Mints the one-time email-link
 * token here — the project invite diverges from studio in that ALL three channels
 * (the owner's copyable URL, the bell, the email) funnel through the SAME
 * `/decision?token=` landing page, so the token is shared: it is returned
 * to the caller (route surfaces the copyable URL) AND embedded in
 * the notification payload (so the bell can build the same link). The token
 * lives in Redis (not the PG tx) — a tx rollback simply leaves an orphan token
 * that self-expires in 7 days. The `project_invitations_one_pending` partial
 * unique maps a duplicate LIVE pending to a ConflictError.
 * @param projectId - The project the user is being invited into
 * @param inviterUserId - The acting owner (becomes `invitedBy`; name in payload)
 * @param email - The invitee's email; must belong to a registered user
 * @param role - The granted project role (editor | viewer; never owner)
 * @param origin - Request Origin; when set, the best-effort invite email is sent
 *   here (link built from the shared token). Omit to skip it.
 * @returns The new invitation id + email-link token, the invitee's id + email,
 *   and the project / inviter names + role (so the route can compose the
 *   copyable invite URL)
 * @throws {NotFoundError} project not found, or no user with that email
 * @throws {ConflictError} the user already has access to the project, or already
 *   has a live pending invite to it
 */
export async function createInvite(
  projectId: string,
  inviterUserId: string,
  email: string,
  role: InvitableProjectRole,
  origin?: string,
): Promise<{
  invitationId: string;
  shareToken: string;
  inviteeUserId: string;
  inviteeEmail: string;
  projectName: string;
  inviterName: string;
  role: InvitableProjectRole;
}> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  const invitee = await usersRepo.getUserByEmail(email);
  if (!invitee) throw new NotFoundError(t("server.project.email_not_registered"));
  const existingRole = await projectMembersRepo.getRole(projectId, invitee.id);
  if (existingRole) throw new ConflictError(t("server.project.already_member"));

  // Soft collaborator cap (config/limits.yaml). Counts EXPLICITLY invited
  // members (`added_by IS NOT NULL`); the creator-owner and auto-materialized
  // baseline viewers are exempt, so open-baseline viewing is never blocked.
  // Fail EARLY here; the real guard is in confirmInvite.
  const collaboratorCount = await projectMembersRepo.countExplicitMembers(projectId);
  if (collaboratorCount >= getProjectCollaboratorCap()) {
    throw new ConflictError(t("server.project.collaborator_limit_reached"));
  }

  const profiles = await studioRepo.getPersonalProfilesByCreators([
    inviterUserId,
  ]);
  const inviter = profiles.get(inviterUserId);
  const inviterName = inviter?.name ?? "";
  const expiresAt = deferredRequestExpiry();

  let invitationId = "";
  // The bell row builds its link from this, same as the email.
  let shareToken = "";
  try {
    await db.transaction(async (tx) => {
      // Reap any expired-but-still-'pending' invite for this (project, invitee)
      // first: the one-pending partial unique index ignores expiry (a partial
      // predicate can't reference now()), so a timed-out invite would otherwise
      // trip it and reject the re-invite with a spurious "already invited"
      // (#1769). Same transaction → freeing the slot and taking it are atomic.
      await invitesRepo.expireStalePending(projectId, invitee.id, tx);
            // Locks the project for the length of this transaction and refuses if it
      // is already gone. Same window the request tables have: without the lock
      // the insert commits after the delete cascade has swept this table,
      // leaving a live pending invite on a dead project — and `confirmInvite`
      // never checks project liveness, so the invitee could still accept and
      // land an active member row on something nobody can open.
      if (!(await projectRepo.lockLiveProject(projectId, tx))) {
        throw new NotFoundError(t("server.error.not_found"));
      }
      ({ id: invitationId, shareToken } = await invitesRepo.createPending({
        projectId,
        invitedUserId: invitee.id,
        role,
        invitedBy: inviterUserId,
        expiresAt,
        tx,
      }));
      const notif = await notificationService.createProjectInviteRequest({
        userId: invitee.id,
        projectId,
        payload: {
          invitationId,
          projectId,
          projectName: project.name,
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
      throw new ConflictError(t("server.project.already_invited"));
    }
    throw err;
  }

  // Best-effort invite email — the bell notification is the always-delivered
  // path; this only fires when an SMTP backend is configured and the caller
  // passed an origin. A send failure must NOT fail the request.
  if (origin) {
    // The token was already minted in the tx above (it is also returned to the
    // route for the copyable URL), so this factory only builds the mail.
    await sendBestEffortMail(
      async () =>
        buildProjectInvitationMail({
          inviteeEmail: email,
          inviterName,
          projectName: project.name,
          role,
          inviteLink: decisionLink(origin, shareToken),
          windowDays: getDeferredRequestTtlDays(),
        }),
      { userId: inviterUserId, subject: "project_invite" },
    );
  }

  return {
    invitationId,
    shareToken,
    inviteeUserId: invitee.id,
    inviteeEmail: email,
    projectName: project.name,
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
 * ONCE; (2) upsert the `project_members` row (reviving a previously-removed
 * one); (3) mark the bell notification read; (4) notify the inviting owner via
 * `project.invite_accepted`.
 * @param invitationId - The `project_invitations` row id
 * @param receiverUserId - The invitee confirming (must own the invite)
 * @throws {NotFoundError} the invite is missing, already decided, expired, or
 *   not owned by `receiverUserId`
 */
export async function confirmInvite(
  invitationId: string,
  receiverUserId: string,
): Promise<void> {
  let joinedActivity: { projectId: string; role: ProjectRole } | null = null;
  await db.transaction(async (tx) => {
    // Serialization point: only the first confirm flips status to accepted;
    // a losing/expired/wrong-user attempt matches zero rows → null → abort.
    const accepted = await invitesRepo.acceptIfPending(
      invitationId,
      receiverUserId,
      tx,
    );
    if (!accepted) throw new NotFoundError(t("server.error.not_found"));

    // Soft collaborator cap — the REAL guard: the project may have filled up
    // between sending and accepting. Counts committed explicit members (a
    // 1-off race under simultaneous confirms is acceptable for a soft business
    // cap; concurrency isn't a data-integrity invariant here). Auto-viewers
    // and the owner are exempt (`added_by` null).
    const collaboratorCount = await projectMembersRepo.countExplicitMembers(
      accepted.projectId,
    );
    if (collaboratorCount >= getProjectCollaboratorCap()) {
      throw new ConflictError(t("server.project.collaborator_limit_reached"));
    }

    await projectMembersRepo.upsertMember(
      accepted.projectId,
      accepted.invitedUserId,
      accepted.role,
      accepted.invitedBy,
      tx,
    );

    if (accepted.notificationId) {
      await notificationRepo.markRead(
        accepted.notificationId,
        receiverUserId,
        tx,
      );
    }

    const project = await projectRepo.getProjectById(accepted.projectId);
    const profiles = await studioRepo.getPersonalProfilesByCreators([
      accepted.invitedUserId,
    ]);
    const invitee = profiles.get(accepted.invitedUserId);
    await notificationService.createProjectInviteAccepted({
      userId: accepted.invitedBy,
      projectId: accepted.projectId,
      payload: {
        projectId: accepted.projectId,
        projectName: project?.name ?? "",
        inviteeUserId: accepted.invitedUserId,
        inviteeName: invitee?.name ?? "",
      },
      tx,
    });
    joinedActivity = { projectId: accepted.projectId, role: accepted.role };
  });
  // Activity row AFTER the membership transaction committed (the feed
  // records outcomes; recordProjectActivity is best-effort and
  // announces the live signal itself).
  if (joinedActivity !== null) {
    const joined = joinedActivity as { projectId: string; role: ProjectRole };
    await recordProjectActivity({
      projectId: joined.projectId,
      actorUserId: receiverUserId,
      type: "member:joined",
      payload: { role: joined.role },
    });
  }
}

/**
 * The invitee declines an invite — marks it declined; membership untouched.
 *
 * In one transaction: the decline CAS (own LIVE pending → declined), then mark
 * the bell notification read. Idempotent on a second click: a missing /
 * already-decided / not-owned invite collapses to NotFound.
 * @param invitationId - The `project_invitations` row id
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
 * The owner revokes (cancels) a pending invite in their project.
 *
 * The `project_id` guard ensures the owner can only revoke invites belonging to
 * the project they own (the route gates `requireRole('owner')` on the param),
 * then in one tx the revoke CAS + marks the invitee's bell notification read (so
 * the bell entry disappears for them too).
 * @param projectId - The owner's project UUID (guard)
 * @param invitationId - The `project_invitations` row id to revoke
 * @throws {NotFoundError} no matching LIVE pending invite in this project
 */
export async function revokeInvite(
  projectId: string,
  invitationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const revoked = await invitesRepo.revokeIfPending(
      invitationId,
      projectId,
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

/**
 * List a project's LIVE pending invitations (for the owner's "invited
 * (pending)" section). Thin pass-through to the repo so the route reaches the
 * data layer through the service (prohibition #1). The route gates
 * `requireRole('owner')`, so authorization is enforced before this runs.
 * @param projectId - Project UUID
 * @returns Pending invitations with display fields (empty when none)
 */
export async function listPending(
  projectId: string,
): Promise<PendingProjectInvitationSummary[]> {
  return invitesRepo.listPendingByProject(projectId);
}





