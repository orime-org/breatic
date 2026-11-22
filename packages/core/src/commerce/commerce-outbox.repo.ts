// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product's outbox to the billing service (`commerce_outbox`, inner#1993
 * §5.1, §5.2). Writers append in their own business transaction; the relay
 * claims one due row at a time, in order within its aggregate, and marks it
 * sent, retries it later or moves it to the dead letters.
 *
 * Nothing is appended while the deployment sells nothing: no relay runs then,
 * and a row nobody sends would only pile up. Once selling starts, the daily
 * lot-mirror reconcile resends every bought lot that is not active, and the
 * active ones changed within `lot_mirror_reconcile_window_days`.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { env } from "@core/config/env.js";
import { db, type DbTx } from "@core/db/client.js";
import { commerceOutbox, commerceOutboxDeadLetters } from "@core/db/schema.js";
import type { CommerceOutboxType } from "@core/commerce/contract.js";

/**
 * Append one event.
 * @param aggregateKey - What it orders against.
 * @param type - The event.
 * @param payload - Its body.
 * @param tx - The business transaction.
 */
async function append(aggregateKey: string, type: CommerceOutboxType, payload: Record<string, unknown>, tx: DbTx): Promise<void> {
  if (!env.SELLING) return;
  await tx.insert(commerceOutbox).values({ aggregateKey, type, payload });
}

/**
 * Append a bought lot's lifecycle; lots nobody paid for are not mirrored.
 * @param lot - The lot as it now stands.
 * @param lot.id - Its id.
 * @param lot.sourceId - Its source, the payment for a bought lot.
 * @param lot.sourceKind - What kind of source.
 * @param lot.userId - Its buyer.
 * @param lot.lifecycle - Its lifecycle.
 * @param tx - The transaction that moved it.
 */
export async function appendLotLifecycle(
  lot: { id: string; sourceId: string; sourceKind: string; userId: string; lifecycle: string },
  tx: DbTx,
): Promise<void> {
  if (lot.sourceKind !== "payment") return;
  await append(`lot:${lot.id}`, "lot_refund_lifecycle", { lotId: lot.id, paymentId: lot.sourceId, userId: lot.userId, lifecycle: lot.lifecycle }, tx);
}

/**
 * Append an erased account.
 * @param userId - The deleted account.
 * @param tx - The erasure's transaction.
 */
export async function appendAccountErasure(userId: string, tx: DbTx): Promise<void> {
  await append(`erasure:${userId}`, "account_erasure", { userId }, tx);
}

/**
 * Append the referral code an account signed up with; the billing service
 * binds it or refuses it (inner#1993 §8.4).
 * @param binding - What to bind.
 * @param binding.userId - The new account.
 * @param binding.code - The code it signed up with.
 * @param binding.source - Which sign-up path it came through.
 * @param tx - The account's creating transaction.
 */
export async function appendReferralBinding(binding: { userId: string; code: string; source: string }, tx: DbTx): Promise<void> {
  await append(`referral:${binding.userId}`, "referral_binding", { ...binding, requestedAt: new Date().toISOString() }, tx);
}

/** One claimed outbox row. */
export interface CommerceOutboxRow {
  id: string;
  seq: number;
  aggregateKey: string;
  type: CommerceOutboxType;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

/** The columns a row is read with, in `RawRow`'s names. */
const ROW_COLUMNS = sql`o.id, o.seq::text AS seq, o.aggregate_key, o.type, o.payload, o.attempts, o.last_error, o.created_at`;

/**
 * Claim the next due row: unsent, due, and the oldest unsent row of its
 * aggregate, so one row waiting on a retry holds back only its own aggregate.
 * `SKIP LOCKED` keeps two relays off the same row.
 * @param tx - The relay's transaction, which holds the row until it ends.
 * @returns The row, or null when none is due.
 */
export async function claimNextDue(tx: DbTx): Promise<CommerceOutboxRow | null> {
  const rows = await tx.execute<RawRow>(sql`
    SELECT ${ROW_COLUMNS}
    FROM commerce_outbox o
    WHERE o.sent_at IS NULL
      AND o.next_attempt_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM commerce_outbox e
        WHERE e.aggregate_key = o.aggregate_key AND e.sent_at IS NULL AND e.seq < o.seq
      )
    ORDER BY o.seq
    LIMIT 1
    FOR UPDATE OF o SKIP LOCKED`);
  return rows[0] === undefined ? null : toRow(rows[0]);
}

/** An outbox row as the driver reads it. */
type RawRow = {
  id: string;
  seq: string;
  aggregate_key: string;
  type: CommerceOutboxType;
  payload: Record<string, unknown>;
  attempts: number;
  last_error: string | null;
  created_at: string;
};

/**
 * An outbox row in the names the code uses.
 * @param row - The row as read.
 * @returns The row.
 */
function toRow(row: RawRow): CommerceOutboxRow {
  return {
    id: row.id,
    seq: Number(row.seq),
    aggregateKey: row.aggregate_key,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
  };
}

/**
 * An account's referral binding still waiting in the outbox (inner#1993
 * §5.5), for a user's request to send it once itself: a plain read, so the
 * request never holds the row nor touches its attempts. A sent row, a row
 * moved to the dead letters and no row at all all answer null.
 * @param userId - The account.
 * @returns The unsent row, or null.
 */
export async function findUnsentReferralBinding(userId: string): Promise<CommerceOutboxRow | null> {
  const rows = await db.execute<RawRow>(sql`
    SELECT ${ROW_COLUMNS}
    FROM commerce_outbox o
    WHERE o.aggregate_key = ${`referral:${userId}`} AND o.sent_at IS NULL
    ORDER BY o.seq
    LIMIT 1`);
  return rows[0] === undefined ? null : toRow(rows[0]);
}

/**
 * Mark a row sent, unless it already is: the relay and a user's request may
 * both have delivered it, and the first mark stands.
 * @param id - The row.
 * @param tx - The relay's transaction; a user's request writes outside one.
 */
export async function markSent(id: string, tx?: DbTx): Promise<void> {
  await (tx ?? db).update(commerceOutbox).set({ sentAt: new Date() }).where(and(eq(commerceOutbox.id, id), isNull(commerceOutbox.sentAt)));
}

/**
 * Put a claimed row back for a later attempt.
 * @param id - The row.
 * @param attempts - Attempts made so far, this one included.
 * @param delaySeconds - How long until it is due again.
 * @param lastError - Why this attempt failed.
 * @param tx - The relay's transaction.
 */
export async function markRetry(id: string, attempts: number, delaySeconds: number, lastError: string, tx: DbTx): Promise<void> {
  await tx
    .update(commerceOutbox)
    .set({ attempts, lastError, nextAttemptAt: sql`now() + make_interval(secs => ${delaySeconds})` })
    .where(eq(commerceOutbox.id, id));
}

/**
 * Move an unsent row to the dead letters; it is never sent again. The row
 * leaves this table (the one hard delete here) and lives on, same id, seq
 * and payload, in `commerce_outbox_dead_letters`, so an aggregate's history
 * is the two tables read together. A row already sent or already moved, by
 * the relay or a user's request delivering it at the same time, is left.
 * @param row - The row.
 * @param attempts - Attempts made, this one included.
 * @param lastError - Why the last attempt failed.
 * @param reason - Why it is given up.
 * @param tx - The transaction.
 * @returns Whether this call moved it.
 */
export async function moveToDeadLetters(row: CommerceOutboxRow, attempts: number, lastError: string, reason: string, tx: DbTx): Promise<boolean> {
  const removed = await tx
    .delete(commerceOutbox)
    .where(and(eq(commerceOutbox.id, row.id), isNull(commerceOutbox.sentAt)))
    .returning({ id: commerceOutbox.id });
  if (removed.length === 0) return false;
  await tx.insert(commerceOutboxDeadLetters).values({
    id: row.id,
    seq: BigInt(row.seq),
    aggregateKey: row.aggregateKey,
    type: row.type,
    payload: row.payload,
    attempts,
    lastError,
    reason,
    createdAt: row.createdAt,
  });
  return true;
}
