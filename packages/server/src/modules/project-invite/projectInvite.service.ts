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
 *   - `confirmInvite`: the invitee accepts. In ONE tx: take the project's row
 *     (refusing if it is gone), the accept CAS (the serialization point —
 *     concurrent confirms apply EXACTLY ONCE), the collaborator ceiling behind
 *     that lock, then upsert the membership, mark the bell notification read,
 *     and notify the inviting owner via `project.invite_accepted`.
 *   - `declineInvite`: the invitee declines (membership untouched).
 *   - `revokeInvite`: the owner cancels a pending invite in their project.
 *
 * Confirm/decline are reached through the decision service (`/decisions`),
 * never through a route of this module's own.
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
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { buildProjectInvitationMail } from "@server/utils/notification-mail.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db, getLimitsForStudio } from "@breatic/core";
import { ConflictError, NotFoundError } from "@breatic/core";
import { projectMembersRepo } from "@breatic/core";
import { type ProjectRole, t } from "@breatic/shared";
import { decisionLink } from "@server/utils/decision-link.js";
import type {
  InvitableProjectRole,
  PendingProjectInvitationSummary,
} from "@breatic/shared";
import {
  getDecisionWindowMs,
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
 * the notification payload (so the bell can build the same link). The token is
 * a NOT NULL column written by the same insert, so a rollback takes row and
 * token together — there is nothing to orphan. The
 * `project_invitations_one_pending` partial unique maps a duplicate LIVE
 * pending to a ConflictError.
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

  // The collaborator ceiling belongs to the studio this project lives in —
  // more precisely to whoever currently administers that studio, who need not
  // be the person inviting. Counts EXPLICITLY invited members
  // (`added_by IS NOT NULL`); the creator-owner and auto-materialized baseline
  // viewers are exempt, so open-baseline viewing is never blocked. Failing
  // EARLY here is a courtesy to the inviter; the gate is in `confirmInvite`,
  // and only that one runs behind a row lock.
  const { project_members: collaboratorLimit } = await getLimitsForStudio(
    project.studioId,
  );
  const collaboratorCount = await projectMembersRepo.countExplicitMembers(projectId);
  if (collaboratorCount >= collaboratorLimit) {
    throw new ConflictError(
      t("server.project.collaborator_limit_reached", {
        limit: collaboratorLimit,
      }),
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
      // The project row comes FIRST, before anything in `project_invitations`,
      // and that order is not a preference: `deleteProject` takes this row and
      // only then sweeps the invitations of this project, so a path that took
      // the two the other way round would close an AB/BA cycle with it. The
      // window is as wide as the whole delete cascade, and the loser of a
      // deadlock gets 40P01 — neither an `AppError` nor an `HTTPException`, so
      // a 500. Pinned by `invite-lock-order.integration.test.ts`.
      //
      // The lock also refuses when the project is already gone: without it the
      // insert below would commit after the cascade had swept this table,
      // leaving a live pending invite on a dead project.
      if (!(await projectRepo.lockLiveProject(projectId, tx))) {
        throw new NotFoundError(t("server.error.not_found"));
      }
      // Reap any expired-but-still-'pending' invite for this (project, invitee):
      // the one-pending partial unique index ignores expiry (a partial
      // predicate can't reference now()), so a timed-out invite would otherwise
      // trip it and reject the re-invite with a spurious "already invited"
      // (#1769). Same transaction → freeing the slot and taking it are atomic.
      await invitesRepo.expireStalePending(projectId, invitee.id, tx);
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
 * In one transaction: (1) read which project this invite points at, unlocked;
 * (2) take that project's row and refuse if it is gone — before the CAS,
 * because `deleteProject` takes the two in that order and the opposite one
 * deadlocks; (3) the accept CAS (`UPDATE … WHERE status='pending' AND
 * invited_user_id = receiver AND not expired`) — the serialization point, so
 * concurrent confirms (bell + email link, or a double click) apply EXACTLY
 * ONCE; (4) the collaborator ceiling of the studio this project lives in, read
 * and counted behind the lock taken in (2), so two simultaneous confirms cannot
 * both take the last seat; (5) upsert the `project_members` row (reviving a
 * previously-removed one); (6) mark the bell notification read; (7) notify the
 * inviting owner via `project.invite_accepted`.
 * @param invitationId - The `project_invitations` row id
 * @param receiverUserId - The invitee confirming (must own the invite)
 * @throws {NotFoundError} the invite is missing, already decided, expired, not
 *   owned by `receiverUserId`, or its project has been soft-deleted
 * @throws {ConflictError} the project is at its collaborator ceiling
 */
export async function confirmInvite(
  invitationId: string,
  receiverUserId: string,
): Promise<void> {
  let joinedActivity: { projectId: string; role: ProjectRole } | null = null;
  await db.transaction(async (tx) => {
    // Which project this invite is for, read WITHOUT a lock. The id is only
    // reachable through the invitation row, and the row lock below has to come
    // before the accept CAS, so it has to be read first. Safe: an invitation's
    // `project_id` never changes, and whether this invite may still be
    // accepted is decided by the CAS, not by this read.
    const targetProjectId = await invitesRepo.getTargetProjectId(
      invitationId,
      tx,
    );
    if (targetProjectId === null) {
      throw new NotFoundError(t("server.error.not_found"));
    }

    // Taken BEFORE the CAS, and that order is not a preference: `deleteProject`
    // takes `projects` first and `project_invitations` second, so a confirm
    // that took them the other way round would close a deadlock cycle and one
    // of the two would die with a 40P01 (a 500 for whoever lost). Refusing when
    // it returns false is what keeps a live member row off a dead project —
    // the orphan `deleteProject`'s cascade sweeps this table to prevent.
    if (!(await projectRepo.lockLiveProject(targetProjectId, tx))) {
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

    // The REAL gate. Between sending and accepting the project may have filled
    // up, and unlike the invite-time hint this one runs behind the row lock
    // taken above, so two simultaneous confirms cannot both see the same last
    // seat. Counts committed explicit members; auto-viewers and the owner are
    // exempt (`added_by` null). The project is re-read here rather than at the
    // bottom of this transaction because the ceiling belongs to its studio.
    const project = await projectRepo.getProjectById(accepted.projectId, tx);
    if (!project) throw new NotFoundError(t("server.error.not_found"));
    const { project_members: collaboratorLimit } = await getLimitsForStudio(
      project.studioId,
      tx,
    );
    const collaboratorCount = await projectMembersRepo.countExplicitMembers(
      accepted.projectId,
      tx,
    );
    if (collaboratorCount >= collaboratorLimit) {
      // Different sentence from the invite-time one: the person reading this
      // is the invitee, who holds neither the tier nor any way to raise it.
      throw new ConflictError(
        t("server.project.collaborator_limit_reached_for_invitee"),
      );
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

    const profiles = await studioRepo.getPersonalProfilesByCreators(
      [accepted.invitedUserId],
      tx,
    );
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





