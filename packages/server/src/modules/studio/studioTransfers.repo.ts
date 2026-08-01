// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio transfers repository — `studio_transfers` table.
 *
 * An admin offers their studio to a member, who answers later. The offer used
 * to live as a row in `notifications`, which has `read_at` and nothing else: no
 * status, no uniqueness, no expiry. It owns a table now, and this module is the
 * only place that table is touched.
 *
 * Three rules are worth reading before changing anything here.
 *
 * THE SLOT IS THE STUDIO, NOT THE PAIR. A studio has exactly one admin, so it
 * can never be offered to two people at once; the partial unique index keys on
 * the studio alone. That is the difference from `studio_invitations`, where one
 * studio may have many live invites.
 *
 * REAPING. A partial index predicate must be immutable, so it cannot mention
 * `now()` — which means a timed-out offer keeps `status = 'pending'` and holds
 * the studio's slot until something flips it. Nothing would, since "expired" is
 * by definition the case where nobody acted, and here the cost is the whole
 * studio: no further transfer could ever be started. So {@link createPending}
 * reaps stale pendings in the same transaction that takes the slot, exactly as
 * the invite tables learned to (#1769).
 *
 * LOCKING BY ID, NOT BY STATUS. {@link lockRequest} locks on `id` alone and
 * reports the status it found. Adding `status = 'pending'` to the lock's WHERE
 * looks tighter and is worse: under READ COMMITTED a `SELECT … FOR UPDATE`
 * re-checks its predicate against the row version it finally locked, so the
 * loser of a concurrent decision matches nothing and gets an empty result —
 * indistinguishable from "no such offer", at exactly the moment the difference
 * matters most.
 */

import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db, studioTransfers } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** Where a transfer sits in its lifecycle. */
export type StudioTransferStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled";

/** A locked transfer, with everything the decision path needs to judge it. */
export interface LockedStudioTransfer {
  id: string;
  studioId: string;
  /** The admin who offered it — the adminship check is made against this. */
  fromUserId: string;
  /** The only user allowed to accept or decline. */
  toUserId: string;
  status: StudioTransferStatus;
  /** The bell entry to mark read when this offer leaves `pending`. */
  notificationId: string | null;
  /** True when the deadline has passed — the row is still `pending` either way. */
  expired: boolean;
}

/** A live offer as the studio's own "transfer pending" surfaces see it. */
export interface LiveStudioTransfer {
  id: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
}

/**
 * Flip a timed-out pending on one studio to `expired`, freeing its slot.
 *
 * Only ever touches EXPIRED pendings: a live one must still trip the index,
 * because a second simultaneous offer for the same studio is a real duplicate
 * and refusing it is the point.
 *
 * `decided_at` stays null. It records that a PERSON ended this offer; nobody
 * did here, and the moment it died is already `expires_at`.
 * @param studioId - The studio being offered.
 * @param tx - The enclosing transaction, shared with the insert that follows.
 */
export async function expireStalePending(
  studioId: string,
  tx: DbTx,
): Promise<void> {
  await tx
    .update(studioTransfers)
    .set({ status: "expired" })
    .where(
      and(
        eq(studioTransfers.studioId, studioId),
        eq(studioTransfers.status, "pending"),
        isNull(studioTransfers.deletedAt),
        lte(studioTransfers.expiresAt, sql`now()`),
      ),
    );
}

/**
 * Insert a pending transfer, reaping any stale one on the studio first.
 *
 * Reap and insert share one transaction, so the slot is never free for anyone
 * else in between. A caller already inside a transaction passes it in; the
 * common case opens its own, because "free the slot and take it" is only
 * correct as one step.
 * @param input - The offer to create.
 * @param input.studioId - Studio being offered.
 * @param input.fromUserId - The current admin making the offer.
 * @param input.toUserId - The member being offered adminship.
 * @param input.expiresAt - When this offer stops being answerable.
 * @param input.tx - Optional enclosing transaction.
 * @returns The new transfer's id.
 * @throws {Error} 23505 when a LIVE pending already holds this studio.
 */
export async function createPending(input: {
  studioId: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<string> {
  /**
   * Free the slot and take it, on whichever transaction we end up inside.
   * @param tx - The transaction both steps share.
   * @returns The new transfer's id.
   * @throws {Error} 23505 from the insert, or a missing returned row.
   */
  const run = async (tx: DbTx): Promise<string> => {
    await expireStalePending(input.studioId, tx);
    const rows = await tx
      .insert(studioTransfers)
      .values({
        studioId: input.studioId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        status: "pending",
        expiresAt: input.expiresAt,
      })
      .returning({ id: studioTransfers.id });
    const row = rows[0];
    if (!row) {
      throw new Error(
        "studioTransfersRepo.createPending: insert returned no row",
      );
    }
    return row.id;
  };
  return input.tx ? run(input.tx) : db.transaction(run);
}

/**
 * Link the bell notification to a transfer, in the same transaction that made
 * it, so deciding or cancelling can mark it read and the entry disappears with
 * the offer rather than outliving it.
 * @param id - Transfer id.
 * @param notificationId - The bell entry announcing it.
 * @param tx - Optional enclosing transaction.
 */
export async function attachNotification(
  id: string,
  notificationId: string,
  tx?: DbTx,
): Promise<void> {
  const handle = tx ?? db;
  await handle
    .update(studioTransfers)
    .set({ notificationId })
    .where(eq(studioTransfers.id, id));
}

/**
 * Take the row lock the decision path serialises on, and report what it found.
 *
 * Locks by id alone — see this module's header for why adding `status` to the
 * predicate silently breaks the concurrent case. The caller reads `status` to
 * tell "already decided" from "no such offer", `toUserId` to refuse anyone but
 * the recipient, and `expired` to refuse an offer whose deadline passed while
 * it still sits `pending`.
 * @param id - Transfer id.
 * @param tx - The deciding transaction.
 * @returns The locked transfer, or null when there is no such live row.
 */
export async function lockRequest(
  id: string,
  tx: DbTx,
): Promise<LockedStudioTransfer | null> {
  const rows = await tx
    .select({
      id: studioTransfers.id,
      studioId: studioTransfers.studioId,
      fromUserId: studioTransfers.fromUserId,
      toUserId: studioTransfers.toUserId,
      status: studioTransfers.status,
      notificationId: studioTransfers.notificationId,
      // `mapWith` only supplies the result type; comparison operators are
      // `SQL<unknown>` because Drizzle cannot know what a driver hands back.
      expired: lte(studioTransfers.expiresAt, sql`now()`).mapWith(Boolean),
    })
    .from(studioTransfers)
    .where(and(eq(studioTransfers.id, id), isNull(studioTransfers.deletedAt)))
    .for("update");
  const row = rows[0];
  if (!row) return null;
  return { ...row, status: row.status as StudioTransferStatus };
}

/**
 * Move a still-pending transfer to a terminal status.
 *
 * The `status = 'pending'` predicate is the serialisation point: of two
 * concurrent decisions exactly one UPDATE matches, and the other is told it
 * lost rather than quietly overwriting the winner.
 *
 * `decided_at` is set for every status but `expired`, and that split is the
 * whole meaning of the column: it marks that a person ended this offer. Deriving
 * it from the status rather than from a caller-supplied flag is deliberate —
 * a caller cannot get it wrong by forgetting.
 * @param id - Transfer id.
 * @param status - Terminal status to settle on.
 * @param tx - The deciding transaction.
 * @returns True when this call is the one that settled it.
 */
export async function settleIfPending(
  id: string,
  status: Exclude<StudioTransferStatus, "pending">,
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .update(studioTransfers)
    .set({ status, decidedAt: status === "expired" ? null : new Date() })
    .where(
      and(
        eq(studioTransfers.id, id),
        eq(studioTransfers.status, "pending"),
        isNull(studioTransfers.deletedAt),
      ),
    )
    .returning({ id: studioTransfers.id });
  return rows.length > 0;
}

/**
 * The admin withdraws an offer they made, freeing the studio's slot.
 *
 * Guarded by `studio_id` as well as `id`, mirroring the invite tables' revoke:
 * the caller was authorised against a STUDIO, so the row it acts on has to
 * belong to that studio. Without it, an id from somewhere else would be enough
 * to cancel a stranger's transfer.
 * @param id - Transfer id.
 * @param studioId - The studio the caller was authorised on.
 * @param tx - Optional enclosing transaction.
 * @returns The recipient and their bell entry, or null if nothing matched.
 */
export async function cancelIfPending(
  id: string,
  studioId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null; toUserId: string } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(studioTransfers)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(
      and(
        eq(studioTransfers.id, id),
        eq(studioTransfers.studioId, studioId),
        eq(studioTransfers.status, "pending"),
        isNull(studioTransfers.deletedAt),
      ),
    )
    .returning({
      notificationId: studioTransfers.notificationId,
      toUserId: studioTransfers.toUserId,
    });
  const row = rows[0];
  return row
    ? { notificationId: row.notificationId, toUserId: row.toUserId }
    : null;
}

/**
 * The studio's live offer, for both sides' "transfer pending" surfaces.
 *
 * `expires_at > now()` is not optional here. The unique index deliberately
 * ignores the deadline, so copying its predicate would keep showing an offer
 * that died on day eight, under buttons that do nothing.
 * @param studioId - The studio whose surfaces are being rendered.
 * @returns Its live offer, or null when there is none.
 */
export async function findLiveForContainer(
  studioId: string,
): Promise<LiveStudioTransfer | null> {
  const rows = await db
    .select({
      id: studioTransfers.id,
      fromUserId: studioTransfers.fromUserId,
      toUserId: studioTransfers.toUserId,
      expiresAt: studioTransfers.expiresAt,
    })
    .from(studioTransfers)
    .where(
      and(
        eq(studioTransfers.studioId, studioId),
        eq(studioTransfers.status, "pending"),
        isNull(studioTransfers.deletedAt),
        gt(studioTransfers.expiresAt, sql`now()`),
      ),
    );
  return rows[0] ?? null;
}
