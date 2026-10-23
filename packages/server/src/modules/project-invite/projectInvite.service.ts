// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as invitesRepo from "@server/modules/project-invite/projectInvitations.repo.js";
import { createInvitation } from "@server/modules/invitation/invitation.service.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { db, getLimitsForStudio, trackServerEvent } from "@breatic/core";
import * as projectJoinRequestService from "@server/modules/project-join-request/projectJoinRequest.service.js";
import { ConflictError, NotFoundError } from "@breatic/core";
import { projectMembersRepo } from "@breatic/core";
import { type ProjectRole, t } from "@breatic/shared";
import type {
  InvitableProjectRole,
  PendingProjectInvitationSummary,
} from "@breatic/shared";

/**
 * Invite an account or mailbox to a Project through recipient arbitration.
 * @param projectId - The Project whose owner is inviting.
 * @param inviterUserId - The acting owner.
 * @param email - Recipient mailbox.
 * @param role - Granted membership role.
 * @param origin - Trusted frontend origin for invitation links.
 * @returns The committed invitation and its recipient delivery state.
 * @throws {NotFoundError} When the target or invitation is closed.
 * @throws {ConflictError} When duplicate, full, already a member or undelivered.
 * @throws {Error} When persistence fails.
 */
export async function createInvite(
  projectId: string, inviterUserId: string, email: string, role: InvitableProjectRole, origin?: string,
): Promise<{
  invitationId: string;
  inviteeUserId: string | null;
  inviteeEmail: string;
  projectName: string;
  inviterName: string;
  role: InvitableProjectRole;
  pendingSignup: boolean;
}> {
  const result = await createInvitation("project", projectId, inviterUserId, email, role, origin);
  trackServerEvent("member_invited", {
    userId: inviterUserId,
    insertId: `invite:${result.invitationId}`,
    properties: { studio_id: result.studioId, project_id: projectId, scope: "project", role, invitation_id: result.invitationId },
  });
  return {
    invitationId: result.invitationId, inviteeUserId: result.inviteeUserId, inviteeEmail: result.inviteeEmail,
    projectName: result.targetName, inviterName: result.inviterName, role, pendingSignup: result.pendingSignup,
  };
}

/**
 * The invitee confirms an invite — atomically turns the pending invite into a
 * real membership.
 *
 * In one transaction: (1) read which project this invite points at, unlocked;
 * (2) take that project's row and refuse if it is gone or archived — before
 * the CAS, because `archiveProject` takes the two in that order and the
 * opposite one deadlocks; (3) the accept CAS (`UPDATE … WHERE status='pending' AND
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
  let joinedActivity: { projectId: string; studioId: string; role: ProjectRole } | null = null;
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

    // Taken BEFORE the CAS, and that order is not a preference: `archiveProject`
    // takes `projects` first and `project_invitations` second, so a confirm
    // that took them the other way round would close a deadlock cycle and one
    // of the two would die with a 40P01 (a 500 for whoever lost). Refusing when
    // it returns false is what keeps membership frozen on an archived project.
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
    // seat. Only a NEW seat is checked: an invitee who became a member by
    // another route since the invite was sent already holds one, and accepting
    // only changes its role. The project is re-read here rather than at the
    // bottom of this transaction because the ceiling belongs to its studio.
    const project = await projectRepo.getProjectById(accepted.projectId, tx);
    if (!project) throw new NotFoundError(t("server.error.not_found"));
    const { project_members: collaboratorLimit } = await getLimitsForStudio(
      project.studioId,
      tx,
    );
    const alreadyMember =
      (await projectMembersRepo.getRole(
        accepted.projectId,
        accepted.invitedUserId,
        tx,
      )) !== null;
    const collaboratorCount = await projectMembersRepo.countCollaborators(
      accepted.projectId,
      tx,
    );
    if (!alreadyMember && collaboratorCount >= collaboratorLimit) {
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
    await projectJoinRequestService.settleOnJoin(accepted.projectId, accepted.invitedUserId, tx);

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
    joinedActivity = { projectId: accepted.projectId, studioId: project.studioId, role: accepted.role };
  });
  // Activity row AFTER the membership transaction committed (the feed
  // records outcomes; recordProjectActivity is best-effort and
  // announces the live signal itself).
  if (joinedActivity !== null) {
    const joined = joinedActivity as { projectId: string; studioId: string; role: ProjectRole };
    trackServerEvent("invitation_accepted", {
      userId: receiverUserId,
      insertId: `invite-accepted:${invitationId}`,
      properties: {
        studio_id: joined.studioId, project_id: joined.projectId, scope: "project", role: joined.role,
        invitation_id: invitationId,
      },
    });
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
    if (!await projectRepo.lockLiveProject(projectId, tx)) throw new NotFoundError(t("server.error.not_found"));
    const revoked = await invitesRepo.revokeIfPending(
      invitationId,
      projectId,
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





