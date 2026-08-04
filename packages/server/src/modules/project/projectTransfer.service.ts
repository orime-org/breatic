// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project transfer-owner handshake — the owner offers the project to a
 * collaborator, who answers later.
 *
 * Four operations: `requestProjectTransfer` files an offer,
 * `confirmProjectTransfer` / `declineProjectTransfer` are the recipient's two
 * answers, and `withdrawProjectTransfer` lets the project's CURRENT owner take
 * the offer back.
 *
 * The offer lives in `project_transfers`; the bell entry only announces it. It
 * used to BE the bell entry, which is a table with no status, no uniqueness and
 * no expiry — so an offer could be filed any number of times, could never be
 * withdrawn, and "already answered" was indistinguishable from "already read".
 *
 * ONE LIVE OFFER PER PROJECT. A project has exactly one owner, so it can never
 * be offered to two people at once; the partial unique index keys on the
 * project alone. `createPending` reaps a timed-out offer in the transaction
 * that takes the slot, because a partial index predicate cannot mention
 * `now()` — without that, one unanswered offer would freeze the project's
 * ownership for good.
 *
 * A confirm re-checks every premise, because it runs up to a week after the
 * offer was made and all three participants may have moved:
 *
 *   1. lock the offer by id (never by status — see the repo header)
 *   2. it must still be pending, else 409
 *   3. it must not have timed out, else retire it and 409
 *   4. the caller must be the named recipient, else 403
 *   5. the recipient must still be an eligible project + studio member
 *   6. the initiator must still be the owner — enforced by demoting only from
 *      `owner`, so a stale offer writes nothing
 *
 * Step 6 is not paranoia. Demoting whoever the offer names, unconditionally,
 * promotes a former owner who has since been pushed below editor — a privilege
 * grant off a week-old row.
 */

import * as projectRepo from "@server/modules/project/project.repo.js";
import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as transfersRepo from "@server/modules/project/projectTransfers.repo.js";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import { buildProjectTransferMail } from "@server/utils/notification-mail.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db, projectMembersRepo } from "@breatic/core";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import {
  deferredRequestExpiry,
  getDeferredRequestTtlDays,
} from "@server/config/limits.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import {
  isRefused,
  refusalError,
} from "@server/utils/deferred-decision.js";
import type { Refused } from "@server/utils/deferred-decision.js";

/**
 * The current owner offers the project to another collaborator.
 *
 * Refuses personal-studio projects, verifies the caller is the current owner
 * (ADR D4: only the owner initiates — not the studio admin), and requires the
 * recipient to satisfy BOTH layers (ADR D3): already a member of THIS project
 * (editor or viewer) AND a non-guest member of the project's studio. The studio
 * layer is what stops ownership leaving the studio to an outside collaborator.
 *
 * The offer row and its bell entry are written in one transaction and carry the
 * same deadline — they are two projections of one fact, and a null `expires_at`
 * on the bell side reads as "never expires", so an entry created without one
 * outlives the offer it announces.
 * @param projectId - The project whose owner role is being offered
 * @param fromUserId - The acting owner initiating the transfer
 * @param toUserId - The collaborator proposed as the new owner
 * @param origin - Request Origin for the best-effort email link; omit to skip it
 * @throws {NotFoundError} project or studio not found
 * @throws {ForbiddenError} the studio is personal, or the caller is not the owner
 * @throws {ConflictError} this project already has a live offer outstanding
 * @throws {ValidationError} the recipient is the acting owner, is not a project
 *   member (editor/viewer), is not a studio member (would transfer out of the
 *   studio), or is a studio guest
 */
export async function requestProjectTransfer(
  projectId: string,
  fromUserId: string,
  toUserId: string,
  origin?: string,
): Promise<void> {
  const project = await projectRepo.getProjectById(projectId);
  if (!project) throw new NotFoundError(t("server.error.not_found"));
  const studio = await studioRepo.getById(project.studioId);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  // Only the current owner may initiate (ADR D4) — the studio admin cannot.
  const currentOwner = await projectMembersRepo.getOwner(projectId);
  if (currentOwner !== fromUserId) {
    throw new ForbiddenError(t("server.error.forbidden"));
  }
  if (toUserId === fromUserId) {
    throw new ValidationError(t("server.error.validation"));
  }
  // Recipient eligibility is TWO layers (ADR D3 — both required):
  // 1) project layer — must ALREADY collaborate on this project (editor or
  //    viewer). A recipient with the owner role would be the initiator (rejected
  //    by the self-transfer guard above), so only editor / viewer / null occur.
  const recipientProjectRole = await projectMembersRepo.getRole(
    projectId,
    toUserId,
  );
  if (recipientProjectRole !== "editor" && recipientProjectRole !== "viewer") {
    throw new ValidationError(t("server.error.validation"));
  }
  // 2) studio layer — must be a non-guest (admin / maintainer) member of the
  //    project's studio. Blocks transferring the project OUT of its studio: a
  //    project may hold "outside collaborators" who are project members but not
  //    studio members (projectInvite.createInvite never checks studio
  //    membership), and blocks guests from taking ownership.
  const recipientStudioRole = await studioMembersRepo.getRole(
    studio.id,
    toUserId,
  );
  if (!recipientStudioRole || recipientStudioRole === "guest") {
    throw new ValidationError(t("server.error.validation"));
  }

  const expiresAt = deferredRequestExpiry();
  const profiles = await studioRepo.getPersonalProfilesByCreators([fromUserId]);
  const from = profiles.get(fromUserId);
  // Bound out here because the mail is built after the transaction closes.
  let shareToken = "";
  try {
    const filedOffer = await db.transaction<Refused | { done: true; shareToken: string }>(async (tx) => {
      // Locks the project for the length of this transaction and refuses if it
      // is already gone — see `lockLiveProject` for what commits without it.
      if (!(await projectRepo.lockLiveProject(projectId, tx))) {
        return { refusal: "not_found" as const };
      }
      const filed = await transfersRepo.createPending({
        projectId,
        fromUserId,
        toUserId,
        expiresAt,
        tx,
      });
      const transferId = filed.id;
      // Reaping is the one settle path the repo cannot finish on its own: it
      // pushed timed-out rows terminal, and their bell entries have to come
      // down with them or they outlive the offers they announce.
      await Promise.all(
        filed.retiredNotificationIds.map((id) =>
          notificationRepo.retire(id, tx),
        ),
      );
      const notification =
        await notificationService.createProjectTransferRequest({
          userId: toUserId,
          payload: {
            fromUserId,
            fromName: from?.name ?? "",
            projectId,
            projectName: project.name,
            transferId,
          shareToken: filed.shareToken,
          },
          expiresAt,
          tx,
        });
      await transfersRepo.attachNotification(transferId, notification.id, tx);
      // Carried out of the transaction because the mail is sent outside it.
      return { done: true as const, shareToken: filed.shareToken };
    });
    if (isRefused(filedOffer)) throw refusalError(filedOffer.refusal);
    shareToken = filedOffer.shareToken;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(t("server.error.conflict"));
    }
    throw err;
  }

  // Best-effort transfer email — the bell notification above is the always-
  // delivered path; this only fires when an SMTP backend is configured and the
  // caller passed an origin (the route's HTTP Origin). A send failure must NOT
  // fail the request (the offer + bell already committed).
  if (origin) {
    await sendBestEffortMail(
      async () => {
        // Resolve the recipient INSIDE the best-effort boundary — a DB read blip
        // must not fail this request (the offer already committed).
        const recipient = await userRepo.getUserById(toUserId);
        if (!recipient) return null;
        return buildProjectTransferMail({
          recipientEmail: recipient.email,
          initiatorName: from?.name ?? "",
          projectName: project.name,
          decisionLink: decisionLink(origin, shareToken),
          windowDays: getDeferredRequestTtlDays(),
        });
      },
      { userId: toUserId, subject: "project_transfer" },
    );
  }
}

/**
 * The recipient accepts — the owner role moves to them.
 *
 * In one transaction: lock and gate the offer, re-verify both eligibility
 * layers under row locks, demote the old owner FIRST and promote the recipient
 * SECOND, settle the offer and retire its bell entry, then notify the old
 * owner. After the commit, append the ownership-transferred activity.
 *
 * The demote-then-promote order is load-bearing: the reverse collides with
 * `project_members_one_owner_per_project` mid-transaction.
 * @param transferId - The `project_transfers` row id
 * @param receiverUserId - The recipient confirming
 * @throws {NotFoundError} there is no such offer
 * @throws {ForbiddenError} the caller is not the offer's named recipient
 * @throws {ConflictError} the offer was already answered, has timed out, the
 *   recipient no longer qualifies, or the initiator no longer owns the project
 */
export async function confirmProjectTransfer(
  transferId: string,
  receiverUserId: string,
): Promise<void> {
  // Resolved BEFORE the transaction opens: a display field for the outcome
  // notification, needing no transactional consistency — and a read issued from
  // inside a transaction reaches for a SECOND pooled connection while the first
  // is still held, which is how a pool exhausts itself under concurrent
  // decisions.
  const accepterProfiles = await studioRepo.getPersonalProfilesByCreators([
    receiverUserId,
  ]);
  const outcome = await db.transaction<
    Refused | { projectId: string; oldOwnerId: string }
  >(async (tx) => {
    const opened = await openForDecision(tx, transferId, receiverUserId);
    if (isRefused(opened)) return opened;
    const offer = opened;
    const { projectId, fromUserId } = offer;

    // The request-time two-layer eligibility (ADR D3) can go stale within the
    // TTL — the recipient may have been demoted to studio guest or kicked from
    // the studio since. Re-verify BOTH layers BEFORE the swap; otherwise
    // materializeOwner (ON CONFLICT DO UPDATE, no setWhere) would revive a
    // soft-deleted / guest row straight to owner and move the project out of
    // its studio.
    //
    // Both re-reads take a ROW LOCK, and the order is load-bearing:
    //   1. the recipient's `studio_members` row
    //   2. the recipient's `project_members` row
    // Re-reading without the lock left a window wide enough to lose the guard
    // entirely: a concurrent leave / kick could commit between the check and
    // materializeOwner, and since that upsert clears `deleted_at`, it REVIVED
    // the membership row the leave had just soft-deleted. The result was a
    // permanent inconsistency — a non-member owning one of the studio's
    // projects, still able to open it. Leaving locks `studio_members` first
    // and then writes `project_members`, so taking the two in the same order
    // here makes the two transactions queue rather than deadlock.
    //
    // The project row itself is read unlocked: `studio_id` is immutable, so
    // there is nothing here for a concurrent writer to change.
    const project = await projectRepo.getProjectById(projectId, tx);
    if (!project) {
      // The project was soft-deleted under an outstanding offer. Nothing will
      // ever answer it, so it is settled here rather than left holding the
      // project's only transfer slot — the same treatment the sibling branches
      // below give every other dead offer.
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }
    const recipientStudioRole = await studioMembersRepo.lockMemberRole(
      project.studioId,
      receiverUserId,
      tx,
    );
    if (!recipientStudioRole || recipientStudioRole === "guest") {
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }
    const recipientProjectRole = await projectMembersRepo.lockMemberRole(
      projectId,
      receiverUserId,
      tx,
    );
    if (recipientProjectRole !== "editor" && recipientProjectRole !== "viewer") {
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }

    // Demote the old owner FIRST (drops zero owners), then promote the
    // recipient SECOND. Demoting only FROM `owner` is the initiator's premise
    // check: if the project changed hands since the offer was made, this writes
    // nothing rather than promoting a former owner who has since been pushed
    // below editor.
    const demoted = await projectMembersRepo.updateRoleIfCurrent(
      projectId,
      fromUserId,
      "owner",
      "editor",
      tx,
    );
    if (!demoted) {
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }
    await projectMembersRepo.materializeOwner(projectId, receiverUserId, tx);
    await settle(offer, "accepted", tx);

    const accepter = accepterProfiles.get(receiverUserId);
    await notificationService.createProjectTransferApproved({
      userId: fromUserId,
      payload: {
        projectId,
        projectName: project.name,
        accepterUserId: receiverUserId,
        accepterName: accepter?.name ?? "",
      },
      tx,
    });
    return { projectId, oldOwnerId: fromUserId };
  });

  // The refusal is raised only now: its own writes had to commit first.
  if (isRefused(outcome)) throw refusalError(outcome.refusal);

  // Activity row AFTER the swap committed (best-effort audit; the helper
  // announces the live `activity:new` signal itself). The actor is the old
  // owner — they transferred the project away.
  await recordProjectActivity({
    projectId: outcome.projectId,
    actorUserId: outcome.oldOwnerId,
    type: "member:ownership-transferred",
    payload: {
      previousOwnerId: outcome.oldOwnerId,
      newOwnerId: receiverUserId,
    },
  });
}

/**
 * The recipient declines — no role changes, and the project's slot is freed at
 * once so the owner can offer it to somebody else.
 * @param transferId - The `project_transfers` row id
 * @param receiverUserId - The recipient declining
 * @throws {NotFoundError} there is no such offer
 * @throws {ForbiddenError} the caller is not the offer's named recipient
 * @throws {ConflictError} the offer was already answered or has timed out
 */
export async function declineProjectTransfer(
  transferId: string,
  receiverUserId: string,
): Promise<void> {
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const opened = await openForDecision(tx, transferId, receiverUserId);
    if (isRefused(opened)) return opened;
    await settle(opened, "declined", tx);
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * The project's CURRENT owner takes an outstanding offer back.
 *
 * Withdrawal belongs to whoever owns the project now, not to whoever sent the
 * offer. Giving it to the sender strands the project: after a transfer the
 * former owner is gone, and a second, unanswered offer would block ownership
 * for a week with the only key held by someone who has left.
 * @param transferId - The `project_transfers` row id
 * @param projectId - The project the caller was authorised as owner of
 * @throws {NotFoundError} no live offer of this project matches that id
 */
export async function withdrawProjectTransfer(
  transferId: string,
  projectId: string,
): Promise<void> {
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const withdrawn = await transfersRepo.cancelIfPending(
      transferId,
      projectId,
      tx,
    );
    if (!withdrawn) return { refusal: "not_found" };
    if (withdrawn.notificationId !== null) {
      await notificationRepo.retire(withdrawn.notificationId, tx);
    }
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * The project's live offer, for both sides' "transfer pending" surfaces.
 * @param projectId - The project being viewed.
 * @returns The live offer, or null when there is none.
 */
export async function findLiveProjectTransfer(
  projectId: string,
): Promise<{
  id: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
} | null> {
  return transfersRepo.findLiveForContainer(projectId);
}

/** A locked offer that has passed the gates every answer shares. */
interface OpenOffer {
  id: string;
  projectId: string;
  fromUserId: string;
  notificationId: string | null;
}

/**
 * Lock the offer and run the gates both answers share: it exists, it is still
 * pending, it has not timed out, and the caller is its named recipient.
 *
 * The recipient check is the one that cannot be skipped. It used to be implicit
 * in the mark-read guard on the recipient's own bell entry; once the offer is a
 * row of its own, nothing else binds the caller to it, and any signed-in user
 * holding the id could accept a transfer meant for somebody else.
 * @param tx - The deciding transaction; the lock is meaningless without one.
 * @param transferId - The offer id.
 * @param receiverUserId - The caller answering.
 * Refusals come back as VALUES, not exceptions: the timed-out branch settles
 * the row before refusing, and throwing here would abort the transaction that
 * write lives in. The caller raises them after the commit.
 * @returns The locked offer, or why the decision is refused.
 */
async function openForDecision(
  tx: DbTx,
  transferId: string,
  receiverUserId: string,
): Promise<OpenOffer | Refused> {
  const row = await transfersRepo.lockRequest(transferId, tx);
  if (!row) return { refusal: "not_found" };
  const offer: OpenOffer = {
    id: row.id,
    projectId: row.projectId,
    fromUserId: row.fromUserId,
    notificationId: row.notificationId,
  };
  if (row.toUserId !== receiverUserId) return { refusal: "forbidden" };
  if (row.status !== "pending") return { refusal: "conflict" };
  if (row.expired) {
    // Nobody answered in time. Somebody has to write that down, or the row
    // stays `pending` forever and holds the project's only transfer slot.
    await settle(offer, "expired", tx);
    return { refusal: "conflict" };
  }
  return offer;
}

/**
 * Move an offer to a terminal status and take its bell entry down with it.
 * @param offer - The locked offer.
 * @param status - Terminal status to settle on.
 * @param tx - The deciding transaction.
 */
async function settle(
  offer: OpenOffer,
  status: "accepted" | "declined" | "expired",
  tx: DbTx,
): Promise<void> {
  await transfersRepo.settleIfPending(offer.id, status, tx);
  if (offer.notificationId !== null) {
    await notificationRepo.retire(offer.notificationId, tx);
  }
}
