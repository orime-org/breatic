// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { and, desc, eq, isNull, lte } from "drizzle-orm";
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
  /** When the Stripe snapshot behind this row was taken. */
  readonly observedAt: Date;
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
  /**
   * When this view of the subscription was taken from Stripe.
   *
   * Set by the caller at the moment it fetched, not at the moment it writes —
   * the gap between the two is exactly what this exists to arbitrate.
   */
  readonly observedAt: Date;
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
    observedAt: row.observedAt,
  };
}

/**
 * Reads every subscription an account holds or has held.
 *
 * Newest first, which is a convenience for anything displaying them rather
 * than a rule anybody depends on: `subscriptionSituation` chooses among live
 * rows by its own total order (paid before unpaid, then tier, then period,
 * then id) precisely so that no reading rests on the order rows arrive in.
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
 * @throws {Error} if the write left no row, which the database cannot do here.
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
    observedAt: write.observedAt,
  };

  const rows = await insertOrUpdate(values, tx);
  if (rows[0]) return toStored(rows[0]);

  // No row came back because the stored one was taken from a newer view of
  // Stripe than this one, so the write was skipped. That is an ordinary
  // outcome, not a failure — and the caller still wants to know what the
  // subscription looks like, which is the row that won.
  const current = await readOne(write.stripeSubscriptionId, tx);
  if (!current) {
    // Not reachable: something is there, or the insert would have happened.
    throw new Error(
      `Writing subscription ${write.stripeSubscriptionId} left no row`,
    );
  }
  return current;
}

/**
 * Reads one subscription by its Stripe id.
 * @param stripeSubscriptionId - Stripe's id for it.
 * @param tx - Transaction handle, when the caller is inside one.
 * @returns The stored subscription, or null.
 */
async function readOne(
  stripeSubscriptionId: string,
  tx: DbTx | undefined,
): Promise<StoredSubscription | null> {
  const rows = await (tx ?? db)
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return rows[0] ? toStored(rows[0]) : null;
}

/**
 * Runs the insert-or-update for one subscription row.
 *
 * No handling for "this account already holds a live subscription": that
 * constraint is gone (0059). It wrote a business rule onto a table that
 * mirrors Stripe, and Stripe does not guarantee it — so the only thing the
 * constraint could do was fail the write, and neither writer had anywhere to
 * go from there. Which of two live rows governs the account is decided when
 * they are read (`subscription-state.ts`), where two live rows are a state to
 * describe rather than an error to raise.
 * @param values - The row to write.
 * @param tx - Transaction handle, when the caller is inside one.
 * @returns The written row in an array of one, or an empty array when a newer
 *   view of this subscription is already stored.
 */
async function insertOrUpdate(
  values: typeof subscriptions.$inferInsert & { observedAt: Date },
  tx: DbTx | undefined,
): Promise<SubscriptionRow[]> {
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
        observedAt: values.observedAt,
        // A subscription that was soft-deleted and then heard from again is
        // live; nothing else would put the row back in the account's list.
        deletedAt: null,
        updatedAt: new Date(),
      },
      // A writer holding an older view of Stripe than the one already stored
      // has nothing to add: it would replace a newer truth with an older
      // one. Both writers fetch outside any lock, so which of them commits
      // first says nothing about which of them saw Stripe last.
      setWhere: lte(subscriptions.observedAt, values.observedAt),
    })
    .returning();
}
