// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Role-upgrade request service — a viewer asks the owner for editor rights.
 *
 * Four operations: `request` files one, `approve` / `reject` answer it, and
 * `cancel` withdraws it. The request itself lives in `role_upgrade_requests`;
 * the bell entry in `notifications` only ANNOUNCES it.
 *
 * That split is the point of this module's shape. The request used to BE the
 * bell entry, and a table built to announce things has no status, no
 * uniqueness and no expiry — so the flow inherited three defects at once: a
 * request could never time out, the same viewer could file any number of them,
 * and "already decided" was indistinguishable from "already read". Every guard
 * bolted on to compensate revealed the next gap.
 *
 * A decision is answered days after it was filed, so it re-checks everything
 * it assumed rather than trusting the request's own contents:
 *
 *   1. lock the request row by id (never by status — see the repo header)
 *   2. it must still be pending, else 409 "already handled"
 *   3. it must not have timed out, else retire it and 409
 *   4. the caller must be the project's CURRENT owner, else 403
 *   5. the requester must still be a viewer, else retire it and 409
 *   6. write, settle, retire the bell entry, announce the outcome
 *
 * Steps 3 and 5 push the request to `expired` — it has genuinely stopped
 * being answerable — and take its bell entry down with it. Step 4 deliberately
 * does not: a decider lacking authority says nothing about the request, which
 * remains perfectly valid for whoever owns the project now.
 *
 * The approve path holds NO row lock on `project_members`: step 5's check and
 * the role write are one conditional statement (`updateRoleUnderOwner`), so
 * this path cannot join the deadlock the other writers on that table form.
 */

import { db } from "@breatic/core";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as requestsRepo from "@server/modules/role-upgrade-request/roleUpgradeRequests.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import { buildRoleUpgradeRequestMail } from "@server/utils/notification-mail.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import {
  getDecisionWindowMs,
} from "@server/config/limits.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import {
  isRefused,
  refusalError,
} from "@server/utils/deferred-decision.js";
import type { Refused } from "@server/utils/deferred-decision.js";
import { projectMembersRepo } from "@breatic/core";
import { ConflictError } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { t } from "@breatic/shared";
import type { NotificationEntity } from "@breatic/shared";

interface RoleUpgradeRequestInput {
  ownerUserId: string;
  requesterUserId: string;
  projectId: string;
  projectName: string;
  message?: string | null;
  /** The request's HTTP Origin, for building the link the email carries. */
  origin?: string;
}

/** A filed request and the bell entry announcing it. */
export interface FiledRequest {
  requestId: string;
  notification: NotificationEntity;
}

/**
 * File a request: one row in `role_upgrade_requests`, one bell entry for the
 * owner, both in a single transaction.
 *
 * The two carry the SAME `expires_at`, because they are two projections of one
 * fact and a viewer must never see them disagree. `createPending` reaps any
 * timed-out request on this key first, so a viewer whose earlier request was
 * never answered can file again rather than being locked out by their own
 * silence.
 * @param input - Owner, requester, project, and the optional note.
 * @returns The new request's id and the bell entry announcing it.
 * @throws {ConflictError} when this viewer already has a live request here.
 */
export async function request(
  input: RoleUpgradeRequestInput,
): Promise<FiledRequest> {
  const requester = await resolveActorProfile(input.requesterUserId);
  const expiresAt = new Date(Date.now() + getDecisionWindowMs());
  try {
    const filedRequest = await db.transaction<
      (FiledRequest & { shareToken: string }) | { refusal: "not_found" }
    >(async (tx) => {
      // Locks the project for the length of this transaction and refuses if it
      // is already gone. Without it the row commits after the delete cascade
      // has swept this table — a live pending request on a dead project, which
      // nobody can decide and nothing can reap.
      if (!(await projectRepo.lockLiveProject(input.projectId, tx))) {
        return { refusal: "not_found" as const };
      }
      const filed = await requestsRepo.createPending({
        projectId: input.projectId,
        requesterUserId: input.requesterUserId,
        requestedRole: "editor",
        message: input.message ?? undefined,
        expiresAt,
        tx,
      });
      const requestId = filed.id;
      // Reaping is the one settle path the repo cannot finish on its own: it
      // pushed timed-out rows terminal, and their bell entries have to come
      // down with them or they outlive the requests they announce.
      await Promise.all(
        filed.retiredNotificationIds.map((id) =>
          notificationRepo.retire(id, tx),
        ),
      );
      const notification = await notificationService.createRoleUpgradeRequest({
        ownerUserId: input.ownerUserId,
        projectId: input.projectId,
        expiresAt,
        payload: {
          requestId,
          shareToken: filed.shareToken,
          requesterUserId: input.requesterUserId,
          requesterName: requester.name,
          projectId: input.projectId,
          projectName: input.projectName,
          requestedRole: "editor",
          message: input.message ?? null,
        },
        tx,
      });
      await requestsRepo.attachNotification(requestId, notification.id, tx);
      return { requestId, notification, shareToken: filed.shareToken };
    });
    if ("refusal" in filedRequest) throw refusalError(filedRequest.refusal);

    // Best-effort email — the bell entry above is the always-delivered path.
    // Without this the owner has to be in the app that week to learn a decision
    // is waiting, and the request just times out unanswered.
    if (input.origin !== undefined && input.origin !== "") {
      const origin = input.origin;
      await sendBestEffortMail(
        async () => {
          // Resolve the recipient INSIDE the best-effort boundary: a DB read
          // blip must not fail this request, which already committed.
          const owner = await userRepo.getUserById(input.ownerUserId);
          if (!owner) return null;
          return buildRoleUpgradeRequestMail({
            ownerEmail: owner.email,
            requesterName: requester.name,
            projectName: input.projectName,
            requestedRole: "editor",
            message: input.message ?? null,
            decisionLink: decisionLink(origin, filedRequest.shareToken),
          });
        },
        { userId: input.ownerUserId, subject: "role_upgrade_request" },
      );
    }

    return {
      requestId: filedRequest.requestId,
      notification: filedRequest.notification,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.error.conflict"));
    }
    throw err;
  }
}

interface DecisionInput {
  requestId: string;
  ownerUserId: string;
}

/**
 * Owner approves a request: the requester becomes an editor.
 *
 * The premise check and the role write are one statement, so nothing can slip
 * between them — if the requester stopped being a viewer while the request
 * waited, nothing is written and the request is retired instead.
 * @param input - Request id and the deciding owner.
 * @throws {NotFoundError} when there is no such request.
 * @throws {ConflictError} when it was already handled, has timed out, or its
 *   premise no longer holds.
 * @throws {ForbiddenError} when the caller is not the project's current owner.
 */
export async function approve(input: DecisionInput): Promise<void> {
  // Resolved BEFORE the transaction opens: it is a display field for the
  // outcome notification, it needs no transactional consistency, and a read
  // issued from inside a transaction reaches for a SECOND pooled connection
  // while the first is still held — which is how a pool exhausts itself under
  // concurrent decisions.
  const decider = await resolveActorProfile(input.ownerUserId);
  const outcome = await db.transaction<
    Refused | { projectId: string; requesterUserId: string }
  >(async (tx) => {
    const opened = await openForDecision(tx, input);
    if (isRefused(opened)) return opened;
    const req = opened;
    const won = await projectMembersRepo.updateRoleUnderOwner(
      req.projectId,
      req.requesterUserId,
      "viewer",
      "editor",
      input.ownerUserId,
      tx,
    );
    if (!won) {
      // The conditional write refuses for TWO different reasons, and they call
      // for opposite treatment. Ask which one it was rather than assuming.
      const stillOwner = await projectMembersRepo.getRole(
        req.projectId,
        input.ownerUserId,
        tx,
      );
      if (stillOwner !== "owner") {
        // The caller lost the project between the gate and this statement — a
        // transfer committed underneath them. Their lack of authority says
        // nothing about the request, which the NEW owner can still answer, so
        // it is left exactly as it was.
        return { refusal: "forbidden" };
      }
      // The requester is no longer the viewer this request was filed about —
      // promoted by another route, or removed from the project. The request
      // has stopped being answerable, so it is settled rather than left to
      // occupy its slot for another week.
      await settle(req, "expired", null, tx);
      return { refusal: "conflict" };
    }
    if (!(await settle(req, "approved", input.ownerUserId, tx))) {
      return { refusal: "forbidden" };
    }
    // The project is only known once the row is locked, so this read cannot
    // move out — it takes the transaction's own handle instead of reaching for
    // a second connection. Read at decision time only as a fallback label; the
    // bell resolves the current name from the id.
    const project = await projectRepo.getProjectById(req.projectId, tx);
    await notificationService.createRoleUpgradeApproved({
      requesterUserId: req.requesterUserId,
      projectId: req.projectId,
      payload: {
        deciderUserId: input.ownerUserId,
        deciderName: decider.name,
        projectId: req.projectId,
        projectName: project?.name ?? "",
        newRole: "editor",
      },
      tx,
    });
    return { projectId: req.projectId, requesterUserId: req.requesterUserId };
  });
  // The refusal is raised only now: its own writes had to commit first.
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
  // Activity row AFTER the role bump committed (best-effort audit; the helper
  // announces the live signal itself).
  await recordProjectActivity({
    projectId: outcome.projectId,
    actorUserId: input.ownerUserId,
    type: "member:role-changed",
    payload: {
      role: "editor",
      previousRole: "viewer",
      targetUserId: outcome.requesterUserId,
    },
  });
}

/**
 * Owner rejects a request: nothing changes but the request's own status.
 *
 * The premise is re-checked here too, even though there is no write to guard.
 * Rejecting a request whose subject already became an editor would announce a
 * refusal of something that has already happened.
 * @param input - Request id and the deciding owner.
 * @throws {NotFoundError} when there is no such request.
 * @throws {ConflictError} when it was already handled, has timed out, or its
 *   premise no longer holds.
 * @throws {ForbiddenError} when the caller is not the project's current owner.
 */
export async function reject(input: DecisionInput): Promise<void> {
  // Resolved before the transaction opens — see `approve` for why.
  const decider = await resolveActorProfile(input.ownerUserId);
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const opened = await openForDecision(tx, input);
    if (isRefused(opened)) return opened;
    const req = opened;
    const role = await projectMembersRepo.getRole(
      req.projectId,
      req.requesterUserId,
      tx,
    );
    if (role !== "viewer") {
      await settle(req, "expired", null, tx);
      return { refusal: "conflict" };
    }
    if (!(await settle(req, "rejected", input.ownerUserId, tx))) {
      // Same window as approve's: a transfer committed between the gate and
      // here. Nothing is written and the request stays valid for its new owner.
      return { refusal: "forbidden" };
    }
    const project = await projectRepo.getProjectById(req.projectId, tx);
    await notificationService.createRoleUpgradeRejected({
      requesterUserId: req.requesterUserId,
      projectId: req.projectId,
      payload: {
        deciderUserId: input.ownerUserId,
        deciderName: decider.name,
        projectId: req.projectId,
        projectName: project?.name ?? "",
      },
      tx,
    });
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * The requester withdraws their own request, freeing the slot at once.
 *
 * Without this the viewer is held hostage by their own unanswered ask: the
 * unique index refuses a second one, and only time releases it. The owner's
 * bell entry goes down in the same transaction, since what it announced is
 * over.
 * @param requestId - The request to withdraw.
 * @param requesterUserId - The caller; must be the person who filed it.
 * @throws {NotFoundError} when no live request of theirs matches.
 */
export async function cancel(
  requestId: string,
  requesterUserId: string,
): Promise<void> {
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const cancelled = await requestsRepo.cancelIfPending(
      requestId,
      requesterUserId,
      tx,
    );
    if (!cancelled) return { refusal: "not_found" };
    if (cancelled.notificationId !== null) {
      await notificationRepo.retire(cancelled.notificationId, tx);
    }
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * The requester's own live request on a project, for the surface that replaces
 * their "request editor access" button with "requested · N days left · cancel".
 * @param projectId - The project being viewed.
 * @param requesterUserId - The signed-in viewer.
 * @returns Their live request, or null when they have none.
 */
export async function findLive(
  projectId: string,
  requesterUserId: string,
): Promise<{ id: string; expiresAt: Date } | null> {
  const row = await requestsRepo.findLiveForRequester(
    projectId,
    requesterUserId,
  );
  return row ? { id: row.id, expiresAt: row.expiresAt } : null;
}

/** A locked request that has passed every gate but its premise check. */
interface OpenRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  notificationId: string | null;
}

/**
 * Lock the request and run the gates every decision shares: it exists, it is
 * still pending, it has not timed out, and the caller owns the project now.
 *
 * The lock keys on id alone, so a request settled by a concurrent decision
 * still comes back and can be reported as "already handled" rather than
 * "never existed" — the repo header explains why putting `status` in a
 * `FOR UPDATE` predicate destroys exactly that distinction.
 * Refusals come back as VALUES, not exceptions: the timed-out branch settles
 * the row before refusing, and throwing here would abort the transaction that
 * write lives in. The caller raises them after the commit.
 * @param tx - The deciding transaction; the lock is meaningless without one.
 * @param input - Request id and the deciding caller.
 * @returns The locked request, or why the decision is refused.
 */
async function openForDecision(
  tx: DbTx,
  input: DecisionInput,
): Promise<OpenRequest | Refused> {
  const row = await requestsRepo.lockRequest(input.requestId, tx);
  if (!row) return { refusal: "not_found" };
  const req: OpenRequest = {
    id: row.id,
    projectId: row.projectId,
    requesterUserId: row.requesterUserId,
    notificationId: row.notificationId,
  };
  if (row.status !== "pending") return { refusal: "conflict" };
  if (row.expired) {
    // Nobody answered in time. Somebody has to write that down, or the row
    // stays `pending` forever and holds this viewer's slot — "expired" is by
    // definition the case where no other path runs.
    await settle(req, "expired", null, tx);
    return { refusal: "conflict" };
  }
  const decider = await projectMembersRepo.getRole(
    row.projectId,
    input.ownerUserId,
    tx,
  );
  if (decider !== "owner") {
    // Deliberately leaves the request pending: this caller's lack of authority
    // says nothing about the request, which the CURRENT owner can still answer.
    return { refusal: "forbidden" };
  }
  return req;
}

/**
 * Move a request to a terminal status and take its bell entry down with it.
 *
 * A settlement CREDITED TO A PERSON re-establishes that person's authority
 * first, and refuses if it is gone. That check lives here rather than in each
 * caller for one reason: the window it closes is between the gate and the
 * write, so every write needs it, and a rule each caller has to remember is a
 * rule one of them will forget — `reject` did, for a whole round, while
 * `approve` had it. A transfer committing in that window would otherwise let a
 * caller who no longer owns the project destroy a request the new owner never
 * sees.
 *
 * `expired` carries no decider and needs no authority: it records that nobody
 * came, which is true no matter who noticed.
 * @param req - The locked request.
 * @param status - Terminal status to settle on.
 * @param decidedByUserId - The owner who ruled, or null when nobody did.
 * @param tx - The deciding transaction.
 * @returns True when it settled; false when the decider's authority was gone.
 */
async function settle(
  req: OpenRequest,
  status: "approved" | "rejected" | "expired",
  decidedByUserId: string | null,
  tx: DbTx,
): Promise<boolean> {
  if (decidedByUserId !== null) {
    const stillOwner = await projectMembersRepo.getRole(
      req.projectId,
      decidedByUserId,
      tx,
    );
    if (stillOwner !== "owner") return false;
  }
  await requestsRepo.settleIfPending(req.id, status, decidedByUserId, tx);
  if (req.notificationId !== null) {
    await notificationRepo.retire(req.notificationId, tx);
  }
  return true;
}

/**
 * Resolve a user's personal-studio display identity (name + slug = `@handle`)
 * for the bell payload. A user mid-onboarding (no personal studio) yields empty
 * strings; the bell renders the row without an actor link rather than crashing.
 * @param userId - The actor (requester / deciding owner) to resolve.
 * @returns The actor's display name + `@handle` (empty strings when unresolved).
 */
async function resolveActorProfile(
  userId: string,
): Promise<{ name: string; handle: string }> {
  const profiles = await studioService.getPersonalStudioProfilesByUserIds([
    userId,
  ]);
  const p = profiles.get(userId);
  return { name: p?.name ?? "", handle: p?.slug ?? "" };
}
