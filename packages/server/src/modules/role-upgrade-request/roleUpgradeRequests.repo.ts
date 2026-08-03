// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Role-upgrade requests repository — `role_upgrade_requests` table.
 *
 * A viewer asks for edit rights and the project's owner answers later. The
 * request used to live as a row in `notifications`, which has `read_at` and
 * nothing else: no status, no uniqueness, no expiry. It owns a table now, and
 * this module is the only place that table is touched.
 *
 * Two rules are worth reading before changing anything here.
 *
 * REAPING. At most one live pending request per (project, requester), enforced
 * by a partial unique index. A partial index predicate must be immutable, so
 * it cannot mention `now()` — which means a timed-out request keeps
 * `status = 'pending'` and holds its slot until something flips it. Nothing
 * would, since "expired" is by definition the case where nobody acted. So
 * {@link createPending} reaps stale pendings in the same transaction that
 * takes the slot, exactly as the invite tables learned to (#1769).
 *
 * LOCKING BY ID, NOT BY STATUS. {@link lockRequest} locks on `id` alone and
 * reports the status it found. Adding `status = 'pending'` to the lock's WHERE
 * looks tighter and is worse: under READ COMMITTED a `SELECT … FOR UPDATE`
 * re-checks its predicate against the row version it finally locked, so the
 * loser of a concurrent decision matches nothing and gets an empty result —
 * indistinguishable from "no such request", at exactly the moment the
 * difference matters most.
 */

import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { db, roleUpgradeRequests } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { mintShareToken } from "@server/utils/share-token.js";

/** Where a request sits in its lifecycle. */
export type RoleUpgradeStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

/** A locked request, with everything the decision path needs to judge it. */
export interface LockedRoleUpgradeRequest {
  id: string;
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  status: RoleUpgradeStatus;
  /** The bell entry to mark read when this request leaves `pending`. */
  notificationId: string | null;
  /** True when the deadline has passed — the row is still `pending` either way. */
  expired: boolean;
}

/** A live request as the requester's own "pending / cancel" surface sees it. */
export interface LiveRoleUpgradeRequest {
  id: string;
  requestedRole: string;
  expiresAt: Date;
}

/**
 * Flip timed-out pendings on one key to `expired`, freeing the unique slot.
 *
 * Only ever touches EXPIRED pendings: a live one must still trip the index,
 * because a second simultaneous request from the same person is a real
 * duplicate and refusing it is the point.
 * Returns the bell entries of the rows it reaped. The reaper is the one settle
 * path that cannot retire them itself — this is a repo, and the bell lives in
 * another module's table — so it hands them up to the service, which does.
 * Skipping that leaves an entry announcing a request that is over, and the
 * invariant "a settled request has no live bell entry" would then rest on an
 * unrelated filter in the unread query rather than on this write.
 * @param projectId - The project being asked about.
 * @param requesterUserId - The person asking.
 * @param tx - The enclosing transaction, shared with the insert that follows.
 * @returns The notification ids of the rows reaped (empty when none were).
 */
export async function expireStalePending(
  projectId: string,
  requesterUserId: string,
  tx: DbTx,
): Promise<string[]> {
  const rows = await tx
    .update(roleUpgradeRequests)
    .set({ status: "expired" })
    .where(
      and(
        eq(roleUpgradeRequests.projectId, projectId),
        eq(roleUpgradeRequests.requesterUserId, requesterUserId),
        eq(roleUpgradeRequests.status, "pending"),
        isNull(roleUpgradeRequests.deletedAt),
        lte(roleUpgradeRequests.expiresAt, sql`now()`),
      ),
    )
    .returning({ notificationId: roleUpgradeRequests.notificationId });
  return rows
    .map((r) => r.notificationId)
    .filter((id): id is string => id !== null);
}

/** A freshly filed request, and the bell entries its reap left to take down. */
export interface CreatedRoleUpgradeRequest {
  id: string;
  /** Entries of timed-out rows the insert reaped; the caller retires them. */
  retiredNotificationIds: string[];
}

/**
 * Insert a pending request, reaping any stale one on the same key first.
 *
 * Reap and insert share one transaction, so the slot is never free for anyone
 * else in between. A caller already inside a transaction passes it in; the
 * common case opens its own, because "free the slot and take it" is only
 * correct as one step.
 * @param input - The request to create.
 * @param input.projectId - Project the upgrade is asked for.
 * @param input.requesterUserId - The viewer asking.
 * @param input.requestedRole - Role being asked for.
 * @param input.message - Optional note for the decider.
 * @param input.expiresAt - When this request stops being answerable.
 * @param input.tx - Optional enclosing transaction.
 * @returns The new request's id, plus the bell entries of anything reaped — the
 *   caller retires those, since taking them down is a cross-module write this
 *   repo cannot make.
 * @throws {Error} 23505 when a LIVE pending already holds this key.
 */
export async function createPending(input: {
  projectId: string;
  requesterUserId: string;
  requestedRole: string;
  message?: string;
  expiresAt: Date;
  tx?: DbTx;
}): Promise<CreatedRoleUpgradeRequest> {
  /**
   * Free the slot and take it, on whichever transaction we end up inside.
   * @param tx - The transaction both steps share.
   * @returns The new request's id and anything the reap took down with it.
   * @throws {Error} 23505 from the insert, or a missing returned row.
   */
  const run = async (tx: DbTx): Promise<CreatedRoleUpgradeRequest> => {
    const retiredNotificationIds = await expireStalePending(input.projectId, input.requesterUserId, tx);
    const rows = await tx
      .insert(roleUpgradeRequests)
      .values({
        projectId: input.projectId,
        requesterUserId: input.requesterUserId,
        requestedRole: input.requestedRole,
        message: input.message ?? null,
        status: "pending",
        shareToken: mintShareToken(),
        expiresAt: input.expiresAt,
      })
      .returning({ id: roleUpgradeRequests.id });
    const row = rows[0];
    if (!row) {
      throw new Error(
        "roleUpgradeRequestsRepo.createPending: insert returned no row",
      );
    }
    return { id: row.id, retiredNotificationIds };
  };
  return input.tx ? run(input.tx) : db.transaction(run);
}

/**
 * Link the bell notification to a request, in the same transaction that made
 * it, so deciding or cancelling can mark it read and the entry disappears
 * with the request rather than outliving it.
 * @param id - Request id.
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
    .update(roleUpgradeRequests)
    .set({ notificationId })
    .where(eq(roleUpgradeRequests.id, id));
}

/**
 * Take the row lock the decision path serialises on, and report what it found.
 *
 * Locks by id alone — see this module's header for why adding `status` to the
 * predicate silently breaks the concurrent case. The caller reads `status` to
 * tell "already decided" from "no such request", and `expired` to refuse a
 * request whose deadline passed while it still sits `pending`.
 * @param id - Request id.
 * @param tx - The deciding transaction.
 * @returns The locked request, or null when there is no such live row.
 */
export async function lockRequest(
  id: string,
  tx: DbTx,
): Promise<LockedRoleUpgradeRequest | null> {
  const rows = await tx
    .select({
      id: roleUpgradeRequests.id,
      projectId: roleUpgradeRequests.projectId,
      requesterUserId: roleUpgradeRequests.requesterUserId,
      requestedRole: roleUpgradeRequests.requestedRole,
      status: roleUpgradeRequests.status,
      notificationId: roleUpgradeRequests.notificationId,
      // `mapWith` only supplies the result type; comparison operators are
      // `SQL<unknown>` because Drizzle cannot know what a driver hands back.
      expired: lte(roleUpgradeRequests.expiresAt, sql`now()`).mapWith(Boolean),
    })
    .from(roleUpgradeRequests)
    .where(
      and(
        eq(roleUpgradeRequests.id, id),
        isNull(roleUpgradeRequests.deletedAt),
      ),
    )
    .for("update");
  const row = rows[0];
  if (!row) return null;
  return { ...row, status: row.status as RoleUpgradeStatus };
}

/**
 * Move a still-pending request to a terminal status.
 *
 * The `status = 'pending'` predicate is the serialisation point: of two
 * concurrent decisions exactly one UPDATE matches, and the other is told it
 * lost rather than quietly overwriting the winner.
 *
 * `decided_at` is set for every status but `expired`, and that split is the
 * whole meaning of the column: it marks that a person ended this request.
 * Deriving it from the status rather than from `decidedByUserId` is deliberate
 * — the two are not the same question. A cancel is ended by a person and has
 * no decider, so it sets `decided_at` and leaves `decided_by_user_id` null.
 * @param id - Request id.
 * @param status - Terminal status to settle on.
 * @param decidedByUserId - The owner who ruled on it, or null when nobody did.
 * @param tx - The deciding transaction.
 * @returns True when this call is the one that settled it.
 */
export async function settleIfPending(
  id: string,
  status: Exclude<RoleUpgradeStatus, "pending">,
  decidedByUserId: string | null,
  tx: DbTx,
): Promise<boolean> {
  const rows = await tx
    .update(roleUpgradeRequests)
    .set({
      status,
      decidedByUserId,
      decidedAt: status === "expired" ? null : new Date(),
    })
    .where(
      and(
        eq(roleUpgradeRequests.id, id),
        eq(roleUpgradeRequests.status, "pending"),
        isNull(roleUpgradeRequests.deletedAt),
      ),
    )
    .returning({ id: roleUpgradeRequests.id });
  return rows.length > 0;
}

/**
 * The requester withdraws their own request, freeing the slot immediately.
 *
 * The `requester_user_id` guard is what makes this the REQUESTER's escape
 * hatch: without it, anyone holding the id could withdraw someone else's ask.
 *
 * `decided_by_user_id` stays null — nobody ruled on this — but `decided_at` is
 * set, because a person did end it. See {@link settleIfPending} for why those
 * are separate questions.
 * @param id - Request id.
 * @param requesterUserId - The person withdrawing; must own the request.
 * @param tx - Optional enclosing transaction.
 * @returns The attached notification to mark read, or null if nothing matched.
 */
export async function cancelIfPending(
  id: string,
  requesterUserId: string,
  tx?: DbTx,
): Promise<{ notificationId: string | null } | null> {
  const handle = tx ?? db;
  const rows = await handle
    .update(roleUpgradeRequests)
    .set({ status: "cancelled", decidedAt: new Date() })
    .where(
      and(
        eq(roleUpgradeRequests.id, id),
        eq(roleUpgradeRequests.requesterUserId, requesterUserId),
        eq(roleUpgradeRequests.status, "pending"),
        isNull(roleUpgradeRequests.deletedAt),
      ),
    )
    .returning({ notificationId: roleUpgradeRequests.notificationId });
  const row = rows[0];
  return row ? { notificationId: row.notificationId } : null;
}

/**
 * The requester's own live request, for the "asking / cancel" surface.
 *
 * `expires_at > now()` is not optional here. The unique index deliberately
 * ignores the deadline, so copying its predicate would keep showing a request
 * that died on day eight, under a cancel button that does nothing.
 * @param projectId - Project the surface belongs to.
 * @param requesterUserId - The signed-in viewer.
 * @returns Their live request, or null when they have none.
 */
export async function findLiveForRequester(
  projectId: string,
  requesterUserId: string,
): Promise<LiveRoleUpgradeRequest | null> {
  const rows = await db
    .select({
      id: roleUpgradeRequests.id,
      requestedRole: roleUpgradeRequests.requestedRole,
      expiresAt: roleUpgradeRequests.expiresAt,
    })
    .from(roleUpgradeRequests)
    .where(
      and(
        eq(roleUpgradeRequests.projectId, projectId),
        eq(roleUpgradeRequests.requesterUserId, requesterUserId),
        eq(roleUpgradeRequests.status, "pending"),
        isNull(roleUpgradeRequests.deletedAt),
        gt(roleUpgradeRequests.expiresAt, sql`now()`),
      ),
    );
  return rows[0] ?? null;
}
