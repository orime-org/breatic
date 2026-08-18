// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The `subscriptions` table's one home (task #106, design §5.2).
 *
 * In core rather than in server, although only server talks to Stripe: the
 * ceilings a tier carries are read here (`membership.repo.ts`), and a stored
 * subscription whose paid period ran out long ago says the tier on the account
 * is stale. That check has to reach the rows, and collab reaches the ceilings.
 *
 * Writing is one action, not several. A webhook, a redelivery of that same
 * webhook, an event that arrived out of order, and the reconciliation that
 * runs when somebody opens the panel all say the same thing — here is what
 * this subscription looks like now — so they all take the same path and it
 * converges on one row per Stripe subscription.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import type { MembershipTier } from "@breatic/shared";
import { db, type DbTx } from "@core/db/client.js";
import { subscriptions } from "@core/db/schema.js";
import type {
  StripeSubscriptionStatus,
  SubscriptionRecord,
} from "@core/auth/subscription-state.js";

/** One stored subscription, whole. */
export interface StoredSubscription extends SubscriptionRecord {
  /** Our id for the row. */
  readonly id: string;
  /** The account it belongs to. */
  readonly userId: string;
  /** The subscription item whose price changing is what an upgrade is. */
  readonly stripeItemId: string | null;
  /** Which tier the unpaid upgrade is for, when there is one. */
  readonly pendingTier: MembershipTier | null;
  /** Where to go to pay an outstanding invoice, when there is one. */
  readonly payableInvoiceUrl: string | null;
}

/** What Stripe currently says about one subscription. */
export interface SubscriptionWrite {
  /** The account it belongs to. */
  readonly userId: string;
  /** Stripe's id for it, and the key this converges on. */
  readonly stripeSubscriptionId: string;
  /** The tier it has been paid for. */
  readonly tier: MembershipTier;
  /** Stripe's own status word. */
  readonly status: StripeSubscriptionStatus;
  /** When the paid period ends, from `items.data[0].current_period_end`. */
  readonly currentPeriodEnd: Date | null;
  /** Whether it is set to end when that period runs out. */
  readonly cancelAtPeriodEnd: boolean;
  /** The subscription item, needed to change which price it sells. */
  readonly stripeItemId: string | null;
  /** Whether an upgrade is waiting on its invoice. */
  readonly hasPendingUpdate: boolean;
  /** The tier that upgrade is for, when there is one. */
  readonly pendingTier: MembershipTier | null;
  /** The hosted page for an outstanding invoice, when there is one. */
  readonly payableInvoiceUrl: string | null;
}

/** The row shape drizzle returns, before it is narrowed. */
type SubscriptionRow = typeof subscriptions.$inferSelect;

/**
 * Turns a stored row into the shape callers read.
 * @param row - One row of `subscriptions`.
 * @returns The same subscription, typed.
 */
function toStored(row: SubscriptionRow): StoredSubscription {
  return {
    id: row.id,
    userId: row.userId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    // Both tier columns are checked by the database against the same five
    // values as `users.membership_tier`, so what comes back is one of them.
    tier: row.tier as MembershipTier,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    stripeItemId: row.stripeItemId,
    hasPendingUpdate: row.hasPendingUpdate,
    pendingTier: (row.pendingTier as MembershipTier | null) ?? null,
    payableInvoiceUrl: row.payableInvoiceUrl,
  };
}

/**
 * Reads every subscription an account holds or has held.
 *
 * Newest first, which is the order `subscriptionSituation` reads: were two
 * ever live at once — an invariant the write side holds, not this one — the
 * most recent is the one somebody just paid for. "Newest" is decided by the
 * creation time AND the row id, because the time alone ties for rows written
 * in one transaction (see the ordering below).
 * @param userId - The account to read.
 * @param tx - Transaction handle, when the caller is inside one.
 * @returns Its subscriptions, newest first; empty when it has never had one.
 */
export async function listSubscriptions(
  userId: string,
  tx?: DbTx,
): Promise<StoredSubscription[]> {
  const rows = await (tx ?? db)
    .select()
    .from(subscriptions)
    .where(
      and(eq(subscriptions.userId, userId), isNull(subscriptions.deletedAt)),
    )
    // `created_at` alone is not an order: its default is `now()`, which in
    // PostgreSQL is the TRANSACTION's start time, so two rows written in one
    // transaction carry the same timestamp — and the webhook writes a row and
    // reads it back inside one. The row id breaks that tie; it is generated
    // per row, so rows written together still come back in a fixed order.
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id));
  return rows.map(toStored);
}

/**
 * Writes what Stripe currently says about one subscription.
 *
 * Keyed on the Stripe id, so every path that learns the current state — the
 * webhook, a redelivery of it, an out-of-order event, the reconciliation —
 * converges on the same row rather than adding one.
 *
 * Every field is overwritten, including the ones being cleared. Leaving a
 * stale `payable_invoice_url` behind would put "finish paying" in front of
 * somebody who is already up to date.
 * @param write - What Stripe says about the subscription now.
 * @param tx - Transaction handle, when the caller is inside one.
 * @returns The stored subscription after the write.
 * @throws {Error} if the account already holds a different live subscription,
 *   or if the write left no row, which the database cannot do here.
 */
export async function upsertSubscription(
  write: SubscriptionWrite,
  tx?: DbTx,
): Promise<StoredSubscription> {
  const values = {
    userId: write.userId,
    stripeSubscriptionId: write.stripeSubscriptionId,
    tier: write.tier,
    status: write.status,
    currentPeriodEnd: write.currentPeriodEnd,
    cancelAtPeriodEnd: write.cancelAtPeriodEnd,
    stripeItemId: write.stripeItemId,
    hasPendingUpdate: write.hasPendingUpdate,
    pendingTier: write.pendingTier,
    payableInvoiceUrl: write.payableInvoiceUrl,
  };

  const rows = await insertOrUpdate(values, tx);

  const row = rows[0];
  if (!row) {
    // Not reachable: the statement either inserts or updates. A plain Error
    // rather than an AppError — no user input produced this.
    throw new Error(
      `Writing subscription ${write.stripeSubscriptionId} returned no row`,
    );
  }
  return toStored(row);
}

/** The database's name for "this account already has a live subscription". */
const ONE_LIVE_INDEX = "subscriptions_one_live_per_user_idx";

/**
 * Whether an error is the one-live-subscription index refusing a write.
 *
 * The constraint name is on the driver's own error, and drizzle wraps that in
 * a `DrizzleQueryError` whose message is the SQL text — so matching the
 * message finds the query, never the constraint. The name is reached through
 * the `cause` chain, the same walk `isUniqueViolation` does in server.
 * @param err - Whatever the write threw.
 * @returns Whether this index is the one that refused it.
 */
function violatesOneLiveIndex(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (
      typeof cur === "object" &&
      "constraint_name" in cur &&
      cur.constraint_name === ONE_LIVE_INDEX
    ) {
      return true;
    }
    cur = typeof cur === "object" && "cause" in cur ? cur.cause : null;
  }
  return false;
}

/**
 * Runs the insert-or-update, translating the one-live-subscription violation.
 *
 * That index is what actually holds the invariant — a check here could not,
 * because the two ways to break it (two checkouts completing at once, an event
 * arriving while the panel reconciles) run in separate transactions that
 * cannot see each other midway. What this adds is a sentence saying which
 * invariant was hit, in place of a bare constraint name.
 * @param values - The row to write.
 * @param tx - Transaction handle, when the caller is inside one.
 * @returns The written row, in an array of one.
 * @throws {Error} if the account already holds a different live subscription.
 */
async function insertOrUpdate(
  values: typeof subscriptions.$inferInsert,
  tx: DbTx | undefined,
): Promise<SubscriptionRow[]> {
  try {
    return await (tx ?? db)
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          tier: values.tier,
          status: values.status,
          currentPeriodEnd: values.currentPeriodEnd,
          cancelAtPeriodEnd: values.cancelAtPeriodEnd,
          stripeItemId: values.stripeItemId,
          hasPendingUpdate: values.hasPendingUpdate,
          pendingTier: values.pendingTier,
          payableInvoiceUrl: values.payableInvoiceUrl,
          // A subscription that was soft-deleted and then heard from again is
          // live; nothing else would put the row back in the account's list.
          deletedAt: null,
          updatedAt: new Date(),
        },
      })
      .returning();
  } catch (err) {
    if (!violatesOneLiveIndex(err)) throw err;
    throw new Error(
      `Account ${values.userId} already holds a live subscription; ` +
        `${values.stripeSubscriptionId} cannot be stored as a second one`,
    );
  }
}
