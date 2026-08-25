// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio transfer-admin handshake — the admin offers the studio to a member,
 * who answers later. The project version (see projectTransfer.service) is the
 * same shape one level down.
 *
 * Four operations: `requestTransfer` files an offer, `confirmTransfer` /
 * `declineTransfer` are the recipient's two answers, and `withdrawTransfer`
 * lets the studio's CURRENT admin take the offer back.
 *
 * The offer lives in `studio_transfers`; the bell entry only announces it. It
 * used to BE the bell entry, which is a table with no status, no uniqueness and
 * no expiry — so an offer could be filed any number of times, could never be
 * withdrawn, and "already answered" was indistinguishable from "already read".
 *
 * ONE LIVE OFFER PER STUDIO. A studio has exactly one admin, so it can never be
 * offered to two people at once; the partial unique index keys on the studio
 * alone. `createPending` reaps a timed-out offer in the transaction that takes
 * the slot, because a partial index predicate cannot mention `now()` — without
 * that, one unanswered offer would freeze the studio's adminship for good.
 *
 * A confirm re-checks every premise, because it runs up to a week after the
 * offer was made and all three participants may have moved:
 *
 *   1. lock the offer by id (never by status — see the repo header)
 *   2. it must still be pending, else 409
 *   3. it must not have timed out, else retire it and 409
 *   4. the caller must be the named recipient, else 403
 *   5. the initiator must still be the studio's admin, and the recipient must
 *      still be a non-guest member
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import * as userRepo from "@server/modules/auth/user.repo.js";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import * as transfersRepo from "@server/modules/studio/studioTransfers.repo.js";
import { buildStudioTransferMail } from "@server/utils/notification-mail.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db } from "@breatic/core";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { creditLotService, studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import {
  getDecisionWindowMs,
} from "@server/config/limits.js";
import { isUniqueViolation } from "@server/utils/pg-error.js";
import {
  isRefused,
  refusalError,
} from "@server/utils/deferred-decision.js";
import type { Refused } from "@server/utils/deferred-decision.js";

/**
 * The current admin offers the studio to an existing member.
 *
 * Refuses personal studios, and requires the proposed new admin to be a
 * distinct active non-guest member. The offer row and its bell entry are
 * written in one transaction and carry the same deadline — they are two
 * projections of one fact, and a null `expires_at` on the bell side reads as
 * "never expires", so an entry created without one outlives the offer it
 * announces.
 * @param slug - The studio's URL handle
 * @param fromAdminUserId - The acting admin initiating the transfer
 * @param toUserId - The member proposed as the new admin
 * @param origin - Request Origin for the best-effort email link; omit to skip it
 * @throws {NotFoundError} studio not found, or the recipient is not an active member
 * @throws {ForbiddenError} the studio is personal (admin cannot be transferred)
 * @throws {ConflictError} this studio already has a live offer outstanding
 * @throws {ValidationError} the recipient is the acting admin themselves, or a guest
 */
export async function requestTransfer(
  slug: string,
  fromAdminUserId: string,
  toUserId: string,
  origin?: string,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  if (studio.type === "personal") {
    throw new ForbiddenError(t("server.studio.cannot_modify_personal"));
  }
  if (toUserId === fromAdminUserId) {
    throw new ValidationError(t("server.error.validation"));
  }
  const role = await studioMembersRepo.getRole(studio.id, toUserId);
  if (!role) throw new NotFoundError(t("server.error.not_found"));
  // Only a non-guest (admin / maintainer) may receive the studio (#1612 / D3):
  // guests are read-only and must not become the admin.
  if (role === "guest") {
    throw new ValidationError(t("server.error.validation"));
  }

  const expiresAt = new Date(Date.now() + getDecisionWindowMs());
  const profiles = await studioRepo.getPersonalProfilesByCreators([
    fromAdminUserId,
  ]);
  const from = profiles.get(fromAdminUserId);
  // Bound out here because the mail is built after the transaction closes.
  let shareToken = "";
  try {
    shareToken = await db.transaction(async (tx) => {
      const filed = await transfersRepo.createPending({
        studioId: studio.id,
        fromUserId: fromAdminUserId,
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
        await notificationService.createStudioTransferRequest({
          userId: toUserId,
          payload: {
            fromUserId: fromAdminUserId,
            fromName: from?.name ?? "",
            studioId: studio.id,
            studioName: studio.name,
            transferId,
          shareToken: filed.shareToken,
          },
          expiresAt,
          tx,
        });
      await transfersRepo.attachNotification(transferId, notification.id, tx);
      // The mail is sent outside this transaction, so the token has to travel.
      return filed.shareToken;
    });
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
        return buildStudioTransferMail({
          recipientEmail: recipient.email,
          initiatorName: from?.name ?? "",
          studioName: studio.name,
          decisionLink: decisionLink(origin, shareToken),
        });
      },
      { userId: toUserId, subject: "studio_transfer" },
    );
  }
}

/**
 * The recipient accepts — the admin role moves to them.
 *
 * Demote the old admin FIRST, promote the recipient SECOND: the reverse order
 * collides with `studio_members_one_admin_per_studio` mid-transaction. The old
 * admin drops ONE rank to maintainer (#1612 / D1), not all the way to guest.
 *
 * Between those two, every credit lot of the outgoing admin's that pointed at
 * this studio stops pointing (#15). A studio spends what its admin designated
 * to it, so the designation cannot outlive the role — and it happens in this
 * transaction because the rule is about the same instant.
 * @param transferId - The `studio_transfers` row id
 * @param receiverUserId - The recipient confirming
 * @throws {NotFoundError} there is no such offer, or a role swap finds no row
 * @throws {ForbiddenError} the caller is not the offer's named recipient
 * @throws {ConflictError} the offer was already answered, has timed out, the
 *   recipient no longer qualifies, or the initiator no longer administers the
 *   studio
 */
export async function confirmTransfer(
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
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const opened = await openForDecision(tx, transferId, receiverUserId);
    if (isRefused(opened)) return opened;
    const offer = opened;
    const { studioId, fromUserId } = offer;

    // The request-time non-guest check (#1612 / D3) can go stale within the
    // TTL — the recipient may have been demoted to guest, or left, since. One
    // locked read of the whole membership: the same call the leave / kick path
    // makes, so the two queue on identical rows in identical order rather than
    // deadlocking. See `lockMembership` for why this cannot be narrowed to the
    // two rows we care about.
    const members = await studioMembersRepo.lockMembership(studioId, tx);
    const currentAdminUserId =
      members.find((m) => m.role === "admin")?.userId ?? null;
    const recipientRole =
      members.find((m) => m.userId === receiverUserId)?.role ?? null;

    // Which admin is this offer actually moving? It names its initiator in a
    // row written up to a week ago; if the studio has changed hands since, that
    // offer is stale. Confirming one anyway fails in two distinct ways, both
    // observed:
    //   - the studio went to a THIRD party — the promote collides with
    //     studio_members_one_admin_per_studio, surfacing as an unclassified
    //     500 rather than a conflict;
    //   - the studio went to the RECIPIENT already — the promote is a no-op so
    //     nothing collides, but the demote still runs and pushes the stale
    //     initiator to maintainer. If they had been demoted to guest, that is
    //     a silent privilege GRANT off a week-old offer.
    if (currentAdminUserId === null || currentAdminUserId !== fromUserId) {
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }
    if (!recipientRole || recipientRole === "guest") {
      await settle(offer, "expired", tx);
      return { refusal: "conflict" };
    }

    // Both writes are refusals-as-values like every other branch here. Throwing
    // would abort the transaction — which is survivable today because nothing
    // has been settled yet at this point, but the rule has no exceptions
    // precisely so that the next person to add a settle above these lines does
    // not have to notice.
    const demoted = await studioMembersRepo.updateRole(
      studioId,
      fromUserId,
      "maintainer",
      tx,
    );
    if (!demoted) return { refusal: "conflict" };

    // The initiator has stopped administering this studio, so the studio stops
    // being able to spend their credits. Below the demote because every branch
    // above it returns — and returning commits — so a release placed higher
    // would strip someone who never stopped being admin. Inside this
    // transaction because the rule is about the same instant: run apart, the
    // studio keeps drawing on their money in the window between.
    await creditLotService.releaseDesignations({
      userId: fromUserId,
      studioId,
      tx,
    });

    const promoted = await studioMembersRepo.updateRole(
      studioId,
      receiverUserId,
      "admin",
      tx,
    );
    if (!promoted) return { refusal: "conflict" };
    await settle(offer, "accepted", tx);

    const accepter = accepterProfiles.get(receiverUserId);
    await notificationService.createStudioTransferApproved({
      userId: fromUserId,
      payload: {
        studioName: offer.studioName,
        studioId,
        accepterName: accepter?.name ?? "",
        accepterUserId: receiverUserId,
      },
      tx,
    });
    return { done: true };
  });
  // The refusal is raised only now: its own writes had to commit first.
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
}

/**
 * The recipient declines — no role changes, and the studio's slot is freed at
 * once so the admin can offer it to somebody else.
 * @param transferId - The `studio_transfers` row id
 * @param receiverUserId - The recipient declining
 * @throws {NotFoundError} there is no such offer
 * @throws {ForbiddenError} the caller is not the offer's named recipient
 * @throws {ConflictError} the offer was already answered or has timed out
 */
export async function declineTransfer(
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
 * The studio's CURRENT admin takes an outstanding offer back.
 *
 * Withdrawal belongs to whoever administers the studio now, not to whoever sent
 * the offer. Giving it to the sender strands the studio: after a transfer the
 * former admin is gone, and a second, unanswered offer would block adminship
 * for a week with the only key held by someone who has left.
 * Keyed on the slug the caller was authorised against, the same handle every
 * other admin-gated studio route takes — resolving it here rather than in the
 * route keeps the "no such studio" answer in one place.
 * @param transferId - The `studio_transfers` row id
 * @param slug - The studio's URL handle, as the caller was authorised on
 * @throws {NotFoundError} no such studio, or no live offer of it matches that id
 */
export async function withdrawTransfer(
  transferId: string,
  slug: string,
): Promise<void> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  const studioId = studio.id;
  const outcome = await db.transaction<Refused | { done: true }>(async (tx) => {
    const withdrawn = await transfersRepo.cancelIfPending(
      transferId,
      studioId,
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
 * The studio's live offer, for both sides' "transfer pending" surfaces.
 * @param slug - The studio's URL handle.
 * @returns The live offer, or null when there is none.
 * @throws {NotFoundError} no such studio.
 */
export async function findLiveTransfer(slug: string): Promise<{
  id: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
} | null> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new NotFoundError(t("server.error.not_found"));
  return transfersRepo.findLiveForContainer(studio.id);
}

/** A locked offer that has passed the gates every answer shares. */
interface OpenOffer {
  id: string;
  studioId: string;
  studioName: string;
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
 * @returns The locked offer with the studio's display name, or why the
 *   decision is refused.
 */
async function openForDecision(
  tx: DbTx,
  transferId: string,
  receiverUserId: string,
): Promise<OpenOffer | Refused> {
  const row = await transfersRepo.lockRequest(transferId, tx);
  if (!row) return { refusal: "not_found" };
  // Takes the transaction's own handle: a read issued from inside a
  // transaction reaches for a second pooled connection while the first is held.
  const studio = await studioRepo.getById(row.studioId, tx);
  if (!studio) {
    // The studio was soft-deleted under an outstanding offer. Nothing will ever
    // answer it, so it is settled here rather than left holding the studio's
    // only transfer slot — the same treatment every other dead-request branch
    // gets, and the same `conflict` they all report.
    await settle(
      {
        id: row.id,
        studioId: row.studioId,
        studioName: "",
        fromUserId: row.fromUserId,
        notificationId: row.notificationId,
      },
      "expired",
      tx,
    );
    return { refusal: "conflict" };
  }
  const offer: OpenOffer = {
    id: row.id,
    studioId: row.studioId,
    studioName: studio.name,
    fromUserId: row.fromUserId,
    notificationId: row.notificationId,
  };
  if (row.toUserId !== receiverUserId) return { refusal: "forbidden" };
  if (row.status !== "pending") return { refusal: "conflict" };
  if (row.expired) {
    // Nobody answered in time. Somebody has to write that down, or the row
    // stays `pending` forever and holds the studio's only transfer slot.
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
