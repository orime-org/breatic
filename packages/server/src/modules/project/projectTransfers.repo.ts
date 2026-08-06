// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Project transfers repository — `project_transfers` table.
 *
 * An owner offers their project to a member, who answers later. The offer used
 * to live as a row in `notifications`, which has `read_at` and nothing else: no
 * status, no uniqueness, no expiry. It owns a table now, and this module is the
 * only place that table is touched.
 *
 * Three rules are worth reading before changing anything here.
 *
 * THE SLOT IS THE PROJECT, NOT THE PAIR. A project has exactly one owner, so it
 * can never be offered to two people at once; the partial unique index keys on
 * the project alone. That is the difference from `project_invitations`, where
 * one project may have many live invites.
 *
 * REAPING. A partial index predicate must be immutable, so it cannot mention
 * `now()` — which means a timed-out offer keeps `status = 'pending'` and holds
 * the project's slot until something flips it. Nothing would, since "expired"
 * is by definition the case where nobody acted, and here the cost is the whole
 * project: no further transfer could ever be started. So {@link createPending}
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
import { db, projectTransfers } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { mintShareToken } from "@server/utils/share-token.js";

/** Where a transfer sits in its lifecycle. */
export type ProjectTransferStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "expired"
  | "cancelled";

/** A locked transfer, with everything the decision path needs to judge it. */
export interface LockedProjectTransfer {
  id: string;
  projectId: string;
  /** The owner who offered it — the ownership check is made against this. */
  fromUserId: string;
  /** The only user allowed to accept or decline. */
  toUserId: string;
  status: ProjectTransferStatus;
  /** The bell entry to mark read when this offer leaves `pending`. */
  notificationId: string | null;
  /** True when the deadline has passed — the row is still `pending` either way. */
  expired: boolean;
}

/** A live offer as the project's own "transfer pending" surfaces see it. */
export interface LiveProjectTransfer {
  id: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
}

/**
 * Flip a timed-out pending on one project to `expired`, freeing its slot.
 *
 * Only ever touches EXPIRED pendings: a live one must still trip the index,
 * because a second simultaneous offer for the same project is a real duplicate
 * and refusing it is the point.
 *
 * `decided_at` stays null. It records that a PERSON ended this offer; nobody
 * did here, and the moment it died is already `expires_at`.
 * Returns the bell entries of the rows it reaped. The reaper is the one settle
 * path that cannot retire them itself — this is a repo, and the bell lives in
 * another module's table — so it hands them up to the service, which does.
 * Skipping that leaves an entry announcing a offer that is over, and the
 * invariant "a settled offer has no live bell entry" would then rest on an
 * unrelated filter in the unread query rather than on this write.
 * @param projectId - The project being offered.
 * @param tx - The enclosing transaction, shared with the insert that follows.
 * @returns The notification ids of the rows reaped (empty when none were).
 */
export async function expireStalePending(
  projectId: string,
  tx: DbTx,
): Promise<string[]> {
  const rows = await tx
    .update(projectTransfers)
    .set({ status: "expired" })
    .where(
      and(
        eq(projectTransfers.projectId, projectId),
        eq(projectTransfers.status, "pending"),
        isNull(projectTransfers.deletedAt),
        lte(projectTransfers.expiresAt, sql`now()`),
      ),
    )
    .returning({ notificationId: projectTransfers.notificationId });
  return rows
    .map((r) => r.notificationId)
    .filter((id): id is string => id !== null);
}

/** A freshly filed transfer, and the bell entries its reap left to take down. */
export interface CreatedProjectTransfer {
  id: string;
  /** The token that names this request in a decision link. */
  shareToken: string;
  /** Entries of timed-out rows the insert reaped; the caller retires them. */
  retiredNotificationIds: string[];
}

/**
 * Insert a pending transfer, reaping any stale one on the project first.
 *
 * Reap and insert share one transaction, so the slot is never free for anyone
 * else in between. A caller already inside a transaction passes it in; the
 * common case opens its own, because "free the slot and take it" is only
 * correct as one step.
 * @param input - The offer to create.
 * @param input.projectId - Project being offered.
 * @param input.fromUserId - The current owner making the offer.
 * @param input.toUserId - The member being offered ownership.
 * @param input.expiresAt - When this offer stops being answerable.
 * @param input.tx - Optional enclosing transaction.
 * @returns The new transfer's id, plus the bell entries of anything reaped — the
 *   caller retires those, since taking them down is a cross-module write this
 *   repo cannot make.
 * @throws {Error} 23505 when a LIVE pending already holds this project.
 */
export async function createPending(input: {
  projectId: string;
  fromUserId: string;
  toUserId: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<CreatedProjectTransfer> {
  /**
   * Free the slot and take it, on whichever transaction we end up inside.
   * @param tx - The transaction both steps share.
   * @returns The new transfer's id and anything the reap took down with it.
   * @throws {Error} 23505 from the insert, or a missing returned row.
   */
  const run = async (tx: DbTx): Promise<CreatedProjectTransfer> => {
    const retiredNotificationIds = await expireStalePending(input.projectId, tx);
    const rows = await tx
      .insert(projectTransfers)
      .values({
        projectId: input.projectId,
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        status: "pending",
        shareToken: mintShareToken(),
        expiresAt: input.expiresAt,
      })
      .returning({ id: projectTransfers.id, shareToken: projectTransfers.shareToken });
    const row = rows[0];
    if (!row) {
      throw new Error(
        "projectTransfersRepo.createPending: insert returned no row",
      );
    }
    return { id: row.id, shareToken: row.shareToken, retiredNotificationIds };
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
    .update(projectTransfers)
    .set({ notificationId })
    .where(eq(projectTransfers.id, id));
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
): Promise<LockedProjectTransfer | null> {
  const rows = await tx
    .select({
      id: projectTransfers.id,
      projectId: projectTransfers.projectId,
      fromUserId: projectTransfers.fromUserId,
      toUserId: projectTransfers.toUserId,
      status: projectTransfers.status,
      notificationId: projectTransfers.notificationId,
      // `mapWith` only supplies the result type; comparison operators are
      // `SQL<unknown>` because Drizzle cannot know what a driver hands back.
      expired: lte(projectTransfers.expiresAt, sql`now()`).mapWith(Boolean),
    })
    .from(projectTransfers)
    .where(
      and(
        eq(projectTransfers.id, id),
        isNull(projectTransfers.deletedAt),
      ),
    )
    .for("update");
  const row = rows[0];
  if (!row) return null;
  return { ...row, status: row.status as ProjectTransferStatus };
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
  status: Exclude<ProjectTransferStatus, "pending">,
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .update(projectTransfers)
    .set({
      status,
      decidedAt: status === "expired" ? null : new Date(),
      // See roleUpgradeRequests.settleIfPending: a request that ended before
      // its deadline ends its window with it, so the landing page cannot say
      // "this has ended" over "you had seven days" on day two.
      ...(status === "expired"
        ? { expiresAt: sql`LEAST(${projectTransfers.expiresAt}, now())` }
        : {}),
    })
    .where(
      and(
        eq(projectTransfers.id, id),
        eq(projectTransfers.status, "pending"),
        isNull(projectTransfers.deletedAt),
      ),
    )
    .returning({ id: projectTransfers.id, shareToken: projectTransfers.shareToken });
  return rows.length > 0;
}

/**
 * The owner withdraws an offer they made, freeing the project's slot.
 *
 * Guarded by `project_id` as well as `id`, mirroring the invite tables' revoke:
 * the caller was authorised against a PROJECT, so the row it acts on has to
 * belong to that project. Without it, an id from somewhere else would be
 * enough to cancel a stranger's transfer.
 * @param id - Transfer id.
 * @param projectId - The project the caller was authorised on.
 * @param tx - Optional enclosing transaction.
 * @returns The recipient and their bell entry, or null if nothing matched.
 */
export async function cancelIfPending(
  id: string,
  projectId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null; toUserId: string } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(projectTransfers)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(
      and(
        eq(projectTransfers.id, id),
        eq(projectTransfers.projectId, projectId),
        eq(projectTransfers.status, "pending"),
        isNull(projectTransfers.deletedAt),
      ),
    )
    .returning({
      notificationId: projectTransfers.notificationId,
      toUserId: projectTransfers.toUserId,
    });
  const row = rows[0];
  return row
    ? { notificationId: row.notificationId, toUserId: row.toUserId }
    : null;
}

/**
 * The project's live offer, for both sides' "transfer pending" surfaces.
 *
 * `expires_at > now()` is not optional here. The unique index deliberately
 * ignores the deadline, so copying its predicate would keep showing an offer
 * that died on day eight, under buttons that do nothing.
 * @param projectId - The project whose surfaces are being rendered.
 * @returns Its live offer, or null when there is none.
 */
export async function findLiveForContainer(
  projectId: string,
): Promise<LiveProjectTransfer | null> {
  const rows = await db
    .select({
      id: projectTransfers.id,
      fromUserId: projectTransfers.fromUserId,
      toUserId: projectTransfers.toUserId,
      expiresAt: projectTransfers.expiresAt,
    })
    .from(projectTransfers)
    .where(
      and(
        eq(projectTransfers.projectId, projectId),
        eq(projectTransfers.status, "pending"),
        isNull(projectTransfers.deletedAt),
        gt(projectTransfers.expiresAt, sql`now()`),
      ),
    );
  return rows[0] ?? null;
}
