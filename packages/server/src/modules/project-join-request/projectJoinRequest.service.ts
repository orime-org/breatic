// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project join requests — a studio member who is not on a project asks its
 * owner to let them in (#96).
 *
 * Every studio member sees every project of the studio, and entry needs a
 * member row that only the owner grants. A request lives in
 * `project_join_requests`; the owner's bell entry only announces it, and
 * follows whoever owns the project now.
 *
 * Two functions keep requests in step with membership, and they are called
 * from outside this module, inside the caller's transaction:
 *   - {@link settleOnJoin} — a requester who became a member by another route
 *     (accepting an invite, inheriting the project) has nothing left to ask;
 *   - {@link readdressOnOwnerChange} — a project that changed owner moves the
 *     bell entries of its pending requests to the new owner.
 *
 * A path that locks a project's `projects` row together with any of its
 * request or member rows takes the project row first: filing, deciding and
 * withdrawing here, deciding a role upgrade, accepting a transfer, removing a
 * studio member and the delete cascade. Every write to a join request happens
 * under that project lock, which {@link readdressOnOwnerChange} relies on when
 * it reads the pending requests unlocked. Deciding also locks the requester's
 * studio membership before the project.
 *
 * A decision re-checks everything it assumed under those locks: the request is
 * still pending and not timed out, the caller owns the project now, the
 * requester is still in the studio (their membership row stays locked, so a
 * concurrent removal waits for the decision) and not yet on the project, and
 * the project has a seat.
 */

import { db, projectMembersRepo, ConflictError, NotFoundError, getLimitsForStudio } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import type { DecisionGrantRole } from "@breatic/shared";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as requestsRepo from "@server/modules/project-join-request/projectJoinRequests.repo.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { buildProjectJoinRequestMail } from "@server/utils/notification-mail.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { getDecisionWindowMs } from "@server/config/limits.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import { isRefused, refusalError } from "@server/utils/deferred-decision.js";
import type { Refused } from "@server/utils/deferred-decision.js";


/** What the join dialog needs about a project the caller cannot enter. */
export interface MyJoinRequestView {
  project: { id: string; name: string; studioSlug: string };
  pendingRequest: { id: string; createdAt: Date } | null;
}

/**
 * Resolve the project and confirm the caller is in its studio.
 *
 * Outside the studio the project does not exist as far as the caller can
 * tell, the same answer opening it gives.
 * @param projectId - The project.
 * @param userId - The caller.
 * @returns The project and its studio's slug.
 * @throws {NotFoundError} when the project is gone or the caller is not in its studio.
 */
async function loadForStudioMember(
  projectId: string,
  userId: string,
): Promise<{ id: string; name: string; studioId: string; studioSlug: string }> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  const [role, studio] = await Promise.all([
    studioMembersRepo.getRole(project.studioId, userId),
    studioRepo.getById(project.studioId),
  ]);
  if (role === null || !studio) throw new NotFoundError(t("server.error.not_found"));
  return { id: project.id, name: project.name, studioId: project.studioId, studioSlug: studio.slug };
}

/**
 * Resolve a user's display name (their personal studio's name).
 * @param userId - The user.
 * @param tx - Enclosing transaction, when the caller is inside one.
 * @returns The name, or an empty string when unresolved.
 */
async function displayName(userId: string, tx?: DbTx): Promise<string> {
  const profiles = await studioRepo.getPersonalProfilesByCreators([userId], tx);
  return profiles.get(userId)?.name ?? "";
}

/**
 * What the join dialog shows: the project's name, where to go back to, and
 * the caller's own pending request if they have one.
 * @param projectId - The project.
 * @param userId - The caller.
 * @returns The dialog's data.
 * @throws {NotFoundError} when the project is gone or the caller is not in its studio.
 */
export async function getMine(projectId: string, userId: string): Promise<MyJoinRequestView> {
  const project = await loadForStudioMember(projectId, userId);
  const pending = await requestsRepo.findLiveFor(projectId, userId);
  return {
    project: { id: project.id, name: project.name, studioSlug: project.studioSlug },
    pendingRequest: pending,
  };
}

/**
 * File a request: a pending row, and a bell entry for the owner carrying the
 * same deadline, in one transaction under the project lock.
 * @param input - Who asks, about which project, and why.
 * @param input.projectId - The project.
 * @param input.requesterUserId - The caller.
 * @param input.message - Optional note for the owner.
 * @param input.origin - The request's HTTP Origin, for the email's link.
 * @throws {NotFoundError} when the project is gone or the caller is not in its studio.
 * @throws {ConflictError} when the caller is already a member, or already has a
 *   pending request on this project.
 */
export async function request(input: {
  projectId: string;
  requesterUserId: string;
  message?: string | null;
  origin?: string;
}): Promise<void> {
  const project = await loadForStudioMember(input.projectId, input.requesterUserId);
  if ((await projectMembersRepo.getRole(project.id, input.requesterUserId)) !== null) {
    throw new ConflictError(t("server.project.join_already_member"));
  }
  const requesterName = await displayName(input.requesterUserId);
  const message = input.message?.trim() ? input.message : null;
  const expiresAt = new Date(Date.now() + getDecisionWindowMs());

  let filed: { shareToken: string; ownerUserId: string } | Refused;
  try {
    filed = await db.transaction(async (tx) => {
      if (!(await projectRepo.lockLiveProject(project.id, tx))) {
        return { refusal: "not_found" as const };
      }
      // Re-read under the lock: a member row that committed while we waited
      // means there is nothing left to ask for.
      if ((await projectMembersRepo.getRole(project.id, input.requesterUserId, tx)) !== null) {
        return { refusal: "conflict" as const };
      }
      const ownerUserId = await projectMembersRepo.getOwner(project.id, tx);
      if (ownerUserId === null) return { refusal: "not_found" as const };
      const created = await requestsRepo.createPending({
        projectId: project.id,
        requesterUserId: input.requesterUserId,
        message,
        expiresAt,
        tx,
      });
      await Promise.all(created.retiredNotificationIds.map((id) => notificationRepo.retire(id, tx)));
      const entry = await notificationService.createProjectJoinRequest({
        ownerUserId,
        projectId: project.id,
        expiresAt,
        payload: {
          shareToken: created.shareToken,
          requestId: created.id,
          requesterUserId: input.requesterUserId,
          requesterName,
          projectId: project.id,
          projectName: project.name,
          message,
        },
        tx,
      });
      await requestsRepo.setNotification(created.id, entry.id, tx);
      return { shareToken: created.shareToken, ownerUserId };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(t("server.project.join_already_pending"));
    throw err;
  }
  if (isRefused(filed)) {
    if (filed.refusal === "conflict") throw new ConflictError(t("server.project.join_already_member"));
    throw refusalError(filed.refusal);
  }

  const { shareToken, ownerUserId } = filed;
  if (input.origin !== undefined && input.origin !== "") {
    const origin = input.origin;
    await sendBestEffortMail(
      async () => {
        const owner = await userRepo.getUserById(ownerUserId);
        if (!owner) return null;
        return buildProjectJoinRequestMail({
          ownerEmail: owner.email,
          requesterName,
          projectName: project.name,
          message,
          decisionLink: decisionLink(origin, shareToken),
        });
      },
      { userId: ownerUserId, subject: "project_join_request" },
    );
  }
}

/**
 * The requester withdraws their pending request on a project.
 * @param projectId - The project.
 * @param requesterUserId - The caller.
 * @throws {NotFoundError} when they have no live pending request there.
 */
export async function cancelMine(projectId: string, requesterUserId: string): Promise<void> {
  const cancelled = await db.transaction(async (tx) => {
    await projectRepo.lockLiveProject(projectId, tx);
    const row = await requestsRepo.cancelPendingFor(projectId, requesterUserId, tx);
    if (row?.notificationId) await notificationRepo.retire(row.notificationId, tx);
    return row;
  });
  if (!cancelled) throw new NotFoundError(t("server.error.not_found"));
}

/** A request that passed every gate a decision shares. */
interface OpenRequest {
  id: string;
  projectId: string;
  projectName: string;
  studioId: string;
  requesterUserId: string;
  notificationId: string | null;
}

/**
 * Lock the requester's studio membership, the project and the request, and
 * run the gates both decisions share.
 *
 * Refusals come back as values: the branches that settle the request before
 * refusing need their write to commit, which throwing would roll back.
 * @param tx - The deciding transaction.
 * @param requestId - The request.
 * @param ownerUserId - The caller.
 * @returns The request, or why the decision is refused.
 */
async function openForDecision(
  tx: DbTx,
  requestId: string,
  ownerUserId: string,
): Promise<OpenRequest | Refused> {
  const keys = await requestsRepo.getDecisionKeys(requestId, tx);
  if (keys === null) return { refusal: "not_found" };
  const { projectId, requesterUserId } = keys;
  // `studio_id` never changes, so the unlocked read names the right studio.
  const project = await projectRepo.getProjectById(projectId, tx);
  if (!project) return { refusal: "not_found" };
  const inStudio = await studioMembersRepo.lockMemberRole(project.studioId, requesterUserId, tx);
  await projectRepo.lockLiveProject(projectId, tx);
  const row = await requestsRepo.lockRequest(requestId, tx);
  if (!row) return { refusal: "not_found" };
  if (row.status !== "pending") return { refusal: "conflict" };
  const req: OpenRequest = {
    id: row.id,
    projectId,
    projectName: project.name,
    studioId: project.studioId,
    requesterUserId,
    notificationId: row.notificationId,
  };
  if (row.expired) {
    await expire(req, tx);
    return { refusal: "conflict" };
  }
  if ((await projectMembersRepo.getRole(projectId, ownerUserId, tx)) !== "owner") {
    // Left pending: the caller's lack of authority says nothing about the
    // request, which the current owner can still answer.
    return { refusal: "forbidden" };
  }
  const onProject = await projectMembersRepo.getRole(projectId, requesterUserId, tx);
  if (inStudio === null || onProject !== null) {
    await expire(req, tx);
    return { refusal: "conflict" };
  }
  return req;
}

/**
 * Settle a request as expired and take the owner's bell entry down with it.
 * @param req - The request.
 * @param tx - The enclosing transaction.
 */
async function expire(req: OpenRequest, tx: DbTx): Promise<void> {
  await requestsRepo.settleIfPending(req.id, { status: "expired" }, tx);
  if (req.notificationId !== null) await notificationRepo.retire(req.notificationId, tx);
}

/**
 * The owner lets the requester in with the chosen role.
 * @param input - The request, the deciding owner and the role to grant.
 * @param input.requestId - The request.
 * @param input.ownerUserId - The caller.
 * @param input.role - The role to grant.
 * @throws {NotFoundError} when there is no such request or its project is gone.
 * @throws {ForbiddenError} when the caller is not the project's current owner.
 * @throws {ConflictError} when it was already handled, has timed out, its
 *   premise no longer holds, or the project has no free seat.
 */
export async function approve(input: {
  requestId: string;
  ownerUserId: string;
  role: DecisionGrantRole;
}): Promise<void> {
  const deciderName = await displayName(input.ownerUserId);
  const outcome = await db.transaction<Refused | { projectId: string; requesterUserId: string } | { full: number }>(
    async (tx) => {
      const opened = await openForDecision(tx, input.requestId, input.ownerUserId);
      if (isRefused(opened)) return opened;
      const { project_members: limit } = await getLimitsForStudio(opened.studioId, tx);
      if ((await projectMembersRepo.countCollaborators(opened.projectId, tx)) >= limit) {
        return { full: limit };
      }
      const wrote = await projectMembersRepo.addUnlessActive(
        opened.projectId,
        opened.requesterUserId,
        input.role,
        input.ownerUserId,
        tx,
      );
      if (!wrote) {
        await expire(opened, tx);
        return { refusal: "conflict" };
      }
      await requestsRepo.settleIfPending(
        opened.id,
        { status: "approved", decidedByUserId: input.ownerUserId, grantedRole: input.role },
        tx,
      );
      if (opened.notificationId !== null) await notificationRepo.retire(opened.notificationId, tx);
      await notificationService.createProjectJoinDecision({
        requesterUserId: opened.requesterUserId,
        projectId: opened.projectId,
        outcome: "approved",
        payload: {
          deciderUserId: input.ownerUserId,
          deciderName,
          projectId: opened.projectId,
          projectName: opened.projectName,
          grantedRole: input.role,
        },
        tx,
      });
      return { projectId: opened.projectId, requesterUserId: opened.requesterUserId };
    },
  );
  if ("full" in outcome) {
    throw new ConflictError(t("server.project.collaborator_limit_reached", { limit: outcome.full }));
  }
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
  await recordProjectActivity({
    projectId: outcome.projectId,
    actorUserId: outcome.requesterUserId,
    type: "member:joined",
    payload: { role: input.role },
  });
}

/**
 * The owner turns the request down; the requester is told and may ask again.
 * @param input - The request and the deciding owner.
 * @param input.requestId - The request.
 * @param input.ownerUserId - The caller.
 * @throws {NotFoundError} when there is no such request or its project is gone.
 * @throws {ForbiddenError} when the caller is not the project's current owner.
 * @throws {ConflictError} when it was already handled, has timed out, or its
 *   premise no longer holds.
 */
export async function reject(input: { requestId: string; ownerUserId: string }): Promise<void> {
  const deciderName = await displayName(input.ownerUserId);
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const opened = await openForDecision(tx, input.requestId, input.ownerUserId);
    if (isRefused(opened)) return opened;
    await requestsRepo.settleIfPending(
      opened.id,
      { status: "rejected", decidedByUserId: input.ownerUserId },
      tx,
    );
    if (opened.notificationId !== null) await notificationRepo.retire(opened.notificationId, tx);
    await notificationService.createProjectJoinDecision({
      requesterUserId: opened.requesterUserId,
      projectId: opened.projectId,
      outcome: "rejected",
      payload: {
        deciderUserId: input.ownerUserId,
        deciderName,
        projectId: opened.projectId,
        projectName: opened.projectName,
      },
      tx,
    });
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * A user just became a member of a project by another route: their pending
 * request there, if any, has nothing left to ask for.
 *
 * Called from every path that writes an active member row other than
 * {@link approve}, inside that path's transaction.
 * @param projectId - The project.
 * @param userId - The new member.
 * @param tx - The transaction that wrote the member row.
 */
export async function settleOnJoin(projectId: string, userId: string, tx: DbTx): Promise<void> {
  const settled = await requestsRepo.expirePendingFor(projectId, userId, tx);
  if (settled?.notificationId) await notificationRepo.retire(settled.notificationId, tx);
}

/**
 * A project changed owner: move each pending request's bell entry to the new
 * owner, keeping the same decision token.
 *
 * Called from every path that writes a new owner row, inside that path's
 * transaction. The new owner's own pending request is settled first through
 * {@link settleOnJoin}, so it never lands in their bell.
 * @param projectId - The project.
 * @param newOwnerUserId - Its owner now.
 * @param tx - The transaction that wrote the owner row.
 */
export async function readdressOnOwnerChange(
  projectId: string,
  newOwnerUserId: string,
  tx: DbTx,
): Promise<void> {
  await settleOnJoin(projectId, newOwnerUserId, tx);
  const pending = await requestsRepo.listLivePendingForProject(projectId, tx);
  if (pending.length === 0) return;
  const project = await projectRepo.getProjectById(projectId, tx);
  const profiles = await studioRepo.getPersonalProfilesByCreators(
    pending.map((p) => p.requesterUserId),
    tx,
  );
  for (const req of pending) {
    if (req.notificationId !== null) await notificationRepo.retire(req.notificationId, tx);
    const entry = await notificationService.createProjectJoinRequest({
      ownerUserId: newOwnerUserId,
      projectId,
      expiresAt: req.expiresAt,
      payload: {
        shareToken: req.shareToken,
        requestId: req.id,
        requesterUserId: req.requesterUserId,
        requesterName: profiles.get(req.requesterUserId)?.name ?? "",
        projectId,
        projectName: project?.name ?? "",
        message: req.message,
      },
      tx,
    });
    await requestsRepo.setNotification(req.id, entry.id, tx);
  }
}
