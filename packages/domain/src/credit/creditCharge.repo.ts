// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `credit_charge_requests` table (inner#1617): a charge for delivered work,
 * recorded with the delivery and settled exactly once.
 *
 * A row is inserted in the delivery's own transaction, locked by its primary
 * key alone when settled, and moved to `settled` in the charge's commit. A
 * failed settlement leaves it pending and refreshes `updated_at`, which is the
 * order the sweep reads in.
 */

import { and, asc, eq, lt, sql } from "drizzle-orm";
import { db, creditChargeRequests } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** What kind of delivery a request charges for. */
export type ChargeRequestKind = "task" | "timeline_execution" | "operation";

/** A request about to be recorded. */
export interface NewChargeRequest {
  kind: ChargeRequestKind;
  /** What the settlement's ledger rows carry as their reference. */
  referenceId: string;
  actorUserId: string;
  projectId: string | null;
  /** Credits, already rounded to the cent. */
  amount: number;
  description?: string;
  model?: string;
  provider?: string;
  tokensUsed?: number;
  /** The credit hold the settlement releases. */
  releaseHold?: string;
}

/** A recorded request. */
export interface ChargeRequest {
  id: string;
  kind: ChargeRequestKind;
  referenceId: string;
  actorUserId: string;
  projectId: string | null;
  /** Decimal string. */
  amount: string;
  description: string | null;
  model: string | null;
  provider: string | null;
  tokensUsed: number | null;
  releaseHold: string | null;
  status: "pending" | "settled";
}

/**
 * Record a request, unless one already holds its key.
 * @param input - The request.
 * @param tx - The delivery's transaction.
 * @returns The new row's id, or null when its kind, actor and reference already have one.
 */
export async function insertPending(input: NewChargeRequest, tx: DbTx): Promise<string | null> {
  const rows = await tx
    .insert(creditChargeRequests)
    .values({
      kind: input.kind,
      referenceId: input.referenceId,
      actorUserId: input.actorUserId,
      projectId: input.projectId,
      amount: String(input.amount),
      description: input.description ?? null,
      // Cut to the ledger's widths (`credit_ledger.model` / `provider`): a
      // vendor-reported name too long for a column must not refuse the
      // delivery this row commits with.
      model: input.model?.slice(0, 100) ?? null,
      provider: input.provider?.slice(0, 50) ?? null,
      tokensUsed: input.tokensUsed ?? null,
      releaseHold: input.releaseHold ?? null,
    })
    .onConflictDoNothing({
      target: [creditChargeRequests.kind, creditChargeRequests.actorUserId, creditChargeRequests.referenceId],
    })
    .returning({ id: creditChargeRequests.id });
  return rows[0]?.id ?? null;
}

/**
 * Lock a request for its settlement. The lock names the primary key alone: a
 * condition on `status` would be re-checked once the lock is granted and skip
 * the row exactly when another settlement had just finished it.
 * @param id - The request.
 * @param tx - The settlement's transaction.
 * @returns The row, or null when there is none.
 */
export async function lockById(id: string, tx: DbTx): Promise<ChargeRequest | null> {
  const rows = await tx
    .select({
      id: creditChargeRequests.id,
      kind: creditChargeRequests.kind,
      referenceId: creditChargeRequests.referenceId,
      actorUserId: creditChargeRequests.actorUserId,
      projectId: creditChargeRequests.projectId,
      amount: creditChargeRequests.amount,
      description: creditChargeRequests.description,
      model: creditChargeRequests.model,
      provider: creditChargeRequests.provider,
      tokensUsed: creditChargeRequests.tokensUsed,
      releaseHold: creditChargeRequests.releaseHold,
      status: creditChargeRequests.status,
    })
    .from(creditChargeRequests)
    .where(eq(creditChargeRequests.id, id))
    .for("update");
  return rows[0] ?? null;
}

/**
 * Mark a locked request settled, in the charge's own commit.
 * @param id - The request.
 * @param tx - The settlement's transaction.
 */
export async function markSettled(id: string, tx: DbTx): Promise<void> {
  const now = new Date();
  await tx
    .update(creditChargeRequests)
    .set({ status: "settled", settledAt: now, updatedAt: now })
    .where(eq(creditChargeRequests.id, id));
}

/**
 * Count a failed settlement on a request still pending, which also moves it to
 * the back of the sweep. A settled row is left as it is.
 * @param id - The request.
 * @param message - What the settlement threw.
 */
export async function recordFailure(id: string, message: string): Promise<void> {
  await db
    .update(creditChargeRequests)
    .set({
      attempts: sql`${creditChargeRequests.attempts} + 1`,
      lastError: message,
      updatedAt: sql`now()`,
    })
    .where(and(eq(creditChargeRequests.id, id), eq(creditChargeRequests.status, "pending")));
}

/**
 * The pending request under a key.
 * @param kind - Its kind.
 * @param actorUserId - Its actor.
 * @param referenceId - Its reference.
 * @returns Its id, or null when there is none or it is settled.
 */
export async function findPendingId(
  kind: ChargeRequestKind,
  actorUserId: string,
  referenceId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: creditChargeRequests.id })
    .from(creditChargeRequests)
    .where(
      and(
        eq(creditChargeRequests.kind, kind),
        eq(creditChargeRequests.actorUserId, actorUserId),
        eq(creditChargeRequests.referenceId, referenceId),
        eq(creditChargeRequests.status, "pending"),
      ),
    );
  return rows[0]?.id ?? null;
}

/** A pending request as the sweep reads it, with what its log needs. */
export interface SweepableChargeRequest {
  id: string;
  kind: ChargeRequestKind;
  referenceId: string;
  actorUserId: string;
  /** Decimal string. */
  amount: string;
  attempts: number;
}

/**
 * Pending requests the sweep may take: untouched for at least `minAgeMs`,
 * least recently tried first, skipping any another transaction holds.
 * @param minAgeMs - How long a row must have been left alone.
 * @param limit - How many to take.
 * @returns The rows.
 */
export async function listSweepable(minAgeMs: number, limit: number): Promise<SweepableChargeRequest[]> {
  return db
    .select({
      id: creditChargeRequests.id,
      kind: creditChargeRequests.kind,
      referenceId: creditChargeRequests.referenceId,
      actorUserId: creditChargeRequests.actorUserId,
      amount: creditChargeRequests.amount,
      attempts: creditChargeRequests.attempts,
    })
    .from(creditChargeRequests)
    .where(
      and(
        eq(creditChargeRequests.status, "pending"),
        lt(creditChargeRequests.updatedAt, sql`now() - make_interval(secs => ${minAgeMs / 1000})`),
      ),
    )
    .orderBy(asc(creditChargeRequests.updatedAt))
    .limit(limit)
    .for("update", { skipLocked: true });
}
