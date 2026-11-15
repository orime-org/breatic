// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

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

import { studioRepo } from "@breatic/domain";
import * as notificationRepo from "@server/modules/notification/notification.repo.js";
import * as notificationService from "@server/modules/notification/notification.service.js";
import { studioTransfersRepo as transfersRepo } from "@breatic/domain";
import { buildStudioTransferMail } from "@server/utils/notification-mail.js";
import { decisionLink } from "@server/utils/decision-link.js";
import { sendBestEffortMail } from "@server/utils/send-best-effort-mail.js";
import { db, GlobalApiError } from "@breatic/core";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { directoryWrites, globalApi, studioMembersRepo } from "@breatic/domain";
import { t } from "@breatic/shared";
import {
  getDecisionWindowMs,
} from "@server/config/limits.js";
import { isUniqueViolation } from "@breatic/core";
import {
  isRefused,
  refusalError,
} from "@server/utils/deferred-decision.js";
import type { Refused } from "@server/utils/deferred-decision.js";
import type { RequestFailedReason } from "@breatic/shared";
import { profilesService } from "@breatic/domain";

/**
 * The current admin offers the studio to an existing member.
 *
 * Refuses personal studios, and a studio that an active credit pack still
 * points at: the admin unassigns those first. Requires the proposed new admin to be a
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
 * @throws {ConflictError} this studio already has a live offer outstanding,
 *   or an active credit pack still points at it
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
  const profiles = await profilesService.personalProfiles([
    fromAdminUserId,
  ]);
  const from = profiles.get(fromAdminUserId);
  // Bound out here because the mail is built after the transaction closes.
  // The credits are asked about before the offer's transaction opens
  // (inner#1955); a pack pointed at the Studio after that is released when the
  // transfer is accepted.
  if (await globalApi().hasActiveDesignationsTo(studio.id)) {
    throw new ConflictError(t("server.studio.transfer_credits_designated"));
  }
  let shareToken = "";
  try {
    shareToken = await db.transaction(async (tx) => {
      // The Studio row first: every transaction writing a `studio:{id}`
      // directory event takes it first, so their events commit in order.
      await studioRepo.lockStudio(studio.id, tx);
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
      // No pack may be pointed at the Studio while the offer is open.
      await directoryWrites.transferOpened(studio.id, expiresAt, tx);
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
        const recipient = (await profilesService.accountsOf([toUserId])).get(toUserId);
        if (recipient === undefined) return null;
        return buildStudioTransferMail({
          locale: recipient.locale,
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
 * The recipient accepts — the admin role moves to them, in three steps
 * (inner#1955).
 *
 * First this region checks the offer and the membership and moves the offer
 * to `accepting`, where the roles hold still. Then the global region moves the
 * directory admin (`transferAdmin`), which also releases every credit lot the
 * outgoing admin pointed at the Studio: a Studio spends what its admin
 * designated to it, so the designation cannot outlive the role. Last this
 * region swaps the roles and settles the offer. A swap that never ran is
 * finished by {@link sweepAcceptingTransfers}; a global refusal leaves the
 * offer invalidated and the roles as they were.
 *
 * Demote the old admin FIRST, promote the recipient SECOND: the reverse order
 * collides with `studio_members_one_admin_per_studio` mid-transaction. The old
 * admin drops ONE rank to maintainer (#1612 / D1), not all the way to guest.
 * @param transferId - The `studio_transfers` row id
 * @param receiverUserId - The recipient confirming
 * @throws {NotFoundError} there is no such offer
 * @throws {ForbiddenError} the caller is not the offer's named recipient
 * @throws {ConflictError} the offer was already answered, has timed out, the
 *   recipient no longer qualifies, the initiator no longer administers the
 *   studio, or the global region refused the admin change
 */
export async function confirmTransfer(
  transferId: string,
  receiverUserId: string,
): Promise<void> {
  const checked = await db.transaction<Refused | OpenOffer | AlreadyAccepted>(async (tx) => {
    const opened = await openForDecision(tx, transferId, receiverUserId);
    if (isRefused(opened) || "alreadyAccepted" in opened) return opened;
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
      await fail(offer, "invalidated", tx);
      return { refusal: "conflict" };
    }
    if (!recipientRole || recipientRole === "guest") {
      await fail(offer, "invalidated", tx);
      return { refusal: "conflict" };
    }
    if (!(await transfersRepo.markAccepting(offer.id, tx))) return { refusal: "conflict" };
    return offer;
  });
  // The refusal is raised only now: its own writes had to commit first.
  if (isRefused(checked)) throw refusalError(checked.refusal);
  // The recipient answering again: done is done, under way is still under way.
  if ("alreadyAccepted" in checked) {
    if (checked.alreadyAccepted === "accepted") return;
    throw new ConflictError(t("server.studio.transfer_processing"), TRANSFER_PROCESSING_REASON);
  }

  let moved: { changed: boolean };
  try {
    moved = await globalApi().transferAdmin({
      studioId: checked.studioId,
      fromUserId: checked.fromUserId,
      toUserId: receiverUserId,
      changeId: checked.id,
    });
  } catch (err) {
    // The global change may or may not have committed; the offer stays
    // accepting and `sweepAcceptingTransfers` asks again and finishes it.
    if (err instanceof GlobalApiError) {
      throw new ConflictError(t("server.studio.transfer_processing"), TRANSFER_PROCESSING_REASON);
    }
    throw err;
  }
  if (!moved.changed) {
    await invalidateAccepting(checked.id);
    throw refusalError("conflict");
  }
  await finishAccepted(checked.id);
}

/**
 * Finish offers left in the accepting window: one whose region step never ran
 * after the global admin change committed, or whose global call never came
 * back. The global change is asked for again; it answers as it did the first
 * time, so the roles are swapped exactly when the directory moved.
 * @param options - How long an offer may stay accepting first.
 * @param options.olderThanMs - Offers accepting for longer than this are finished.
 * @returns How many offers were finished or invalidated.
 */
export async function sweepAcceptingTransfers(options: { olderThanMs: number }): Promise<number> {
  const ids = await transfersRepo.listStaleAccepting(options.olderThanMs);
  for (const id of ids) {
    const parties = await transfersRepo.findParties(id);
    if (!parties) continue;
    const moved = await globalApi().transferAdmin({
      studioId: parties.studioId,
      fromUserId: parties.fromUserId,
      toUserId: parties.toUserId,
      changeId: id,
    });
    if (moved.changed) await finishAccepted(id);
    else await invalidateAccepting(id);
  }
  return ids.length;
}

/**
 * Refuse a Studio change while its transfer is accepting: the global region
 * may already have moved the admin, and the roles must arrive there as they were.
 * @param studioId - The Studio, locked by the caller.
 * @param tx - The changing transaction.
 * @throws {ConflictError} with reason `studio_transfer_processing` while an offer is accepting.
 */
export async function assertNoTransferAccepting(studioId: string, tx: DbTx): Promise<void> {
  if (await transfersRepo.isAccepting(studioId, tx)) {
    throw new ConflictError(t("server.studio.transfer_processing"), TRANSFER_PROCESSING_REASON);
  }
}

/** The `error.reason` of a change refused while a transfer is accepting. */
export const TRANSFER_PROCESSING_REASON = "studio_transfer_processing";

/** The recipient's own acceptance of an offer, already under way or done. */
interface AlreadyAccepted {
  alreadyAccepted: "accepting" | "accepted";
}

/**
 * Swap the roles for an accepting offer and settle it accepted.
 * @param transferId - The offer.
 */
async function finishAccepted(transferId: string): Promise<void> {
  const parties = await transfersRepo.findParties(transferId);
  if (!parties) return;
  // Resolved BEFORE the transaction opens: a display field for the outcome
  // notification, needing no transactional consistency — and a read issued from
  // inside a transaction reaches for a SECOND pooled connection while the first
  // is still held.
  const accepterProfiles = await profilesService.personalProfiles([parties.toUserId]);
  await db.transaction(async (tx) => {
    await studioRepo.lockStudio(parties.studioId, tx);
    const row = await transfersRepo.lockRequest(transferId, tx);
    if (!row || row.status !== "accepting") return;
    const studio = await studioRepo.getById(row.studioId, tx);
    const offer: OpenOffer = {
      id: row.id,
      studioId: row.studioId,
      studioName: studio?.name ?? "",
      fromUserId: row.fromUserId,
      notificationId: row.notificationId,
    };
    await studioMembersRepo.lockMembership(row.studioId, tx);
    await studioMembersRepo.updateRole(row.studioId, row.fromUserId, "maintainer", tx);
    await studioMembersRepo.updateRole(row.studioId, row.toUserId, "admin", tx);
    await directoryWrites.memberUpserted(row.studioId, row.fromUserId, "maintainer", tx);
    await directoryWrites.memberUpserted(row.studioId, row.toUserId, "admin", tx);
    await settle(offer, "accepted", tx);
    const accepter = accepterProfiles.get(row.toUserId);
    await notificationService.createStudioTransferApproved({
      userId: row.fromUserId,
      payload: {
        studioName: offer.studioName,
        studioId: row.studioId,
        accepterName: accepter?.name ?? "",
        accepterUserId: row.toUserId,
      },
      tx,
    });
  });
}

/**
 * End an accepting offer the global region refused; the roles stay as they were.
 * @param transferId - The offer.
 */
async function invalidateAccepting(transferId: string): Promise<void> {
  const parties = await transfersRepo.findParties(transferId);
  if (!parties) return;
  await db.transaction(async (tx) => {
    await studioRepo.lockStudio(parties.studioId, tx);
    const row = await transfersRepo.lockRequest(transferId, tx);
    if (!row || row.status !== "accepting") return;
    await fail(
      { id: row.id, studioId: row.studioId, studioName: "", fromUserId: row.fromUserId, notificationId: row.notificationId },
      "invalidated",
      tx,
    );
  });
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
  const outcome = await db.transaction<Refused | AlreadyAccepted | { done: true }>(async (tx) => {
    const opened = await openForDecision(tx, transferId, receiverUserId);
    if (isRefused(opened) || "alreadyAccepted" in opened) return opened;
    await settle(opened, "declined", tx);
    return { done: true };
  });
  if (isRefused(outcome)) throw refusalError(outcome.refusal);
  if ("alreadyAccepted" in outcome) {
    if (outcome.alreadyAccepted === "accepted") throw refusalError("conflict");
    throw new ConflictError(t("server.studio.transfer_processing"), TRANSFER_PROCESSING_REASON);
  }
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
    await studioRepo.lockStudio(studioId, tx);
    await assertNoTransferAccepting(studioId, tx);
    const withdrawn = await transfersRepo.cancelIfPending(
      transferId,
      studioId,
      tx,
    );
    if (!withdrawn) return { refusal: "not_found" };
    if (withdrawn.notificationId !== null) {
      await notificationRepo.retire(withdrawn.notificationId, tx);
    }
    await directoryWrites.transferClosed(studioId, tx);
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
 * @returns The locked offer with the studio's display name, the recipient's
 *   own acceptance already under way or done, or why the decision is refused.
 */
async function openForDecision(
  tx: DbTx,
  transferId: string,
  receiverUserId: string,
): Promise<OpenOffer | Refused | AlreadyAccepted> {
  // The Studio row before the offer's, the order every transaction writing a
  // `studio:{id}` directory event takes them in (inner#1955).
  const parties = await transfersRepo.findParties(transferId, tx);
  if (!parties) return { refusal: "not_found" };
  await studioRepo.lockStudio(parties.studioId, tx);
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
    await fail(
      {
        id: row.id,
        studioId: row.studioId,
        studioName: "",
        fromUserId: row.fromUserId,
        notificationId: row.notificationId,
      },
      "invalidated",
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
  if (row.status === "accepting" || row.status === "accepted") return { alreadyAccepted: row.status };
  if (row.status !== "pending") return { refusal: "conflict" };
  if (row.expired) {
    // Nobody answered in time. Somebody has to write that down, or the row
    // stays `pending` forever and holds the studio's only transfer slot.
    await fail(offer, "expired", tx);
    return { refusal: "conflict" };
  }
  return offer;
}

/**
 * Settle an offer on the recipient's answer and take its bell entry down with it.
 * @param offer - The locked offer.
 * @param status - The recipient's answer.
 * @param tx - The deciding transaction.
 */
async function settle(
  offer: OpenOffer,
  status: "accepted" | "declined",
  tx: DbTx,
): Promise<void> {
  const settled = status === "accepted"
    ? await transfersRepo.settleAccepting(offer.id, tx)
    : await transfersRepo.settleIfPending(offer.id, status, tx);
  if (offer.notificationId !== null) {
    await notificationRepo.retire(offer.notificationId, tx);
  }
  if (settled) await directoryWrites.transferClosed(offer.studioId, tx);
}

/**
 * End an offer nobody can answer any more and take its bell entry down with it.
 * @param offer - The locked offer.
 * @param reason - Its deadline passed, or what it was about stopped holding.
 * @param tx - The deciding transaction.
 */
async function fail(
  offer: OpenOffer,
  reason: RequestFailedReason,
  tx: DbTx,
): Promise<void> {
  const failed = await transfersRepo.failIfPending(offer.id, reason, tx);
  if (offer.notificationId !== null) {
    await notificationRepo.retire(offer.notificationId, tx);
  }
  if (failed) await directoryWrites.transferClosed(offer.studioId, tx);
}
