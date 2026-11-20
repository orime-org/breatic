// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The product's outbox to the billing service (`commerce_outbox`, inner#1993
 * §5.1, §5.2). Writers append in their own business transaction; the relay
 * claims one due row at a time, in order within its aggregate, and marks it
 * sent, retries it later or moves it to the dead letters.
 *
 * Nothing is appended while the deployment sells nothing: no relay runs then,
 * and a row nobody sends would only pile up. The daily lot-mirror reconcile
 * resends every lot's current lifecycle once selling starts.
 */

import { eq, sql } from "drizzle-orm";
import { env } from "@core/config/env.js";
import type { DbTx } from "@core/db/client.js";
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

/**
 * Claim the next due row: unsent, due, and the oldest unsent row of its
 * aggregate, so one row waiting on a retry holds back only its own aggregate.
 * `SKIP LOCKED` keeps two relays off the same row.
 * @param tx - The relay's transaction, which holds the row until it ends.
 * @returns The row, or null when none is due.
 */
export async function claimNextDue(tx: DbTx): Promise<CommerceOutboxRow | null> {
  const rows = await tx.execute<{
    id: string;
    seq: string;
    aggregate_key: string;
    type: CommerceOutboxType;
    payload: Record<string, unknown>;
    attempts: number;
    last_error: string | null;
    created_at: string;
  }>(sql`
    SELECT o.id, o.seq::text AS seq, o.aggregate_key, o.type, o.payload, o.attempts, o.last_error, o.created_at
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
  const row = rows[0];
  if (row === undefined) return null;
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
 * Mark a claimed row sent.
 * @param id - The row.
 * @param tx - The relay's transaction.
 */
export async function markSent(id: string, tx: DbTx): Promise<void> {
  await tx.update(commerceOutbox).set({ sentAt: new Date() }).where(eq(commerceOutbox.id, id));
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
 * Move a claimed row to the dead letters; it is never sent again.
 * @param row - The row.
 * @param attempts - Attempts made, this one included.
 * @param lastError - Why the last attempt failed.
 * @param reason - Why it is given up.
 * @param tx - The relay's transaction.
 */
export async function moveToDeadLetters(row: CommerceOutboxRow, attempts: number, lastError: string, reason: string, tx: DbTx): Promise<void> {
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
  await tx.delete(commerceOutbox).where(eq(commerceOutbox.id, row.id));
}
