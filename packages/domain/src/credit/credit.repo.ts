// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Credit transaction repository — audit log for all credit changes.
 */

import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { creditTransactions, creditBalances, users } from "@breatic/core";
import type { CreditTransactionEntity } from "@breatic/shared";

/**
 * Map a raw `credit_transactions` row to the shared domain entity.
 * @param row - The raw Drizzle row selected from `credit_transactions`.
 * @returns The mapped {@link CreditTransactionEntity}.
 */
function toEntity(row: typeof creditTransactions.$inferSelect): CreditTransactionEntity {
  return {
    id: row.id,
    userId: row.userId,
    txType: row.txType,
    amount: row.amount,
    balanceAfter: row.balanceAfter,
    tokensUsed: row.tokensUsed,
    model: row.model,
    provider: row.provider,
    description: row.description,
    referenceId: row.referenceId,
    createdAt: row.createdAt,
  };
}

/**
 * Append an immutable credit transaction row to the audit log.
 * @param data - The transaction fields to record.
 * @param data.userId - ID of the user the transaction belongs to.
 * @param data.txType - Transaction type, e.g. `"deduct"` or `"recharge"`.
 * @param data.amount - Signed credit delta (negative for deductions, positive for additions).
 * @param data.balanceAfter - Resulting balance once this transaction is applied.
 * @param data.tokensUsed - LLM/AIGC token count attributed to this usage; defaults to 0.
 * @param data.model - Model identifier that consumed the credits, when applicable.
 * @param data.provider - Provider name behind the model, when applicable.
 * @param data.description - Human-readable reason; defaults to an empty string.
 * @param data.referenceId - External reference such as a conversation, task, or payment ID.
 * @param tx - Optional transaction connection so this insert can join the caller's atomic deduct/add.
 * @returns The persisted {@link CreditTransactionEntity}.
 */
export async function recordTransaction(
  data: {
    userId: string;
    txType: string;
    amount: number;
    balanceAfter: number;
    tokensUsed?: number;
    model?: string;
    provider?: string;
    description?: string;
    referenceId?: string;
  },
  tx?: DbTx,
): Promise<CreditTransactionEntity> {
  const conn = tx ?? db;
  const rows = await conn
    .insert(creditTransactions)
    .values({
      userId: data.userId,
      txType: data.txType,
      amount: data.amount,
      balanceAfter: data.balanceAfter,
      tokensUsed: data.tokensUsed ?? 0,
      model: data.model,
      provider: data.provider,
      description: data.description ?? "",
      referenceId: data.referenceId,
    })
    .returning();
  return toEntity(rows[0]!);
}

/**
 * List a user's credit transactions, most recent first.
 * @param userId - ID of the user whose transactions to list.
 * @param limit - Maximum rows to return; capped at 100. Defaults to 20.
 * @param offset - Number of rows to skip for pagination. Defaults to 0.
 * @returns The matching {@link CreditTransactionEntity} records.
 */
export async function listTransactionsByUser(
  userId: string,
  limit = 20,
  offset = 0,
): Promise<CreditTransactionEntity[]> {
  const rows = await db
    .select()
    .from(creditTransactions)
    .where(eq(creditTransactions.userId, userId))
    .orderBy(desc(creditTransactions.createdAt))
    .limit(Math.min(limit, 100))
    .offset(offset);
  return rows.map(toEntity);
}

// ── Credit balance (credit_balances table) ───────────────────────────
//
// The per-user balance lives in its own table (PR3, migration 0020),
// not the `users.credits` column. These functions own all balance
// access. Each one inner-joins `users` and filters `deleted_at IS NULL`
// so a soft-deleted user is treated exactly as before the migration
// (balance reads 0, deduct/add are no-ops) — the join references the
// shared `users` schema, not the user.repo module, so the credit domain
// stays decoupled from user *business* logic.

/**
 * Get a user's current credit balance.
 * @param userId - ID of the user whose balance to read.
 * @returns the balance, or 0 if the user has no active balance row
 *   (soft-deleted or non-existent).
 */
export async function getBalance(userId: string): Promise<number> {
  const rows = await db
    .select({ balance: creditBalances.balance })
    .from(creditBalances)
    .innerJoin(users, eq(users.id, creditBalances.userId))
    .where(and(eq(creditBalances.userId, userId), isNull(users.deletedAt)))
    .limit(1);
  return rows[0]?.balance ?? 0;
}

/**
 * Atomically deduct credits. A single conditional UPDATE so concurrent
 * deductions can never drive the balance negative.
 * @param userId - ID of the user to deduct from.
 * @param amount - Number of credits to subtract (positive value).
 * @param tx - optional transaction to run inside (credit.service wraps
 *   deduct + transaction-record in one `db.transaction`).
 * @returns the new balance after deduction, or `null` if the balance
 *   was insufficient / the user has no active row.
 */
export async function deductBalance(
  userId: string,
  amount: number,
  tx?: DbTx,
): Promise<number | null> {
  const conn = tx ?? db;
  const result = await conn.execute(
    sql`UPDATE credit_balances AS cb
        SET balance = cb.balance - ${amount}, updated_at = NOW()
        FROM users AS u
        WHERE cb.user_id = u.id
          AND cb.user_id = ${userId}
          AND u.deleted_at IS NULL
          AND cb.balance >= ${amount}
        RETURNING cb.balance`,
  );
  const rows = result as unknown as Array<{ balance: number }>;
  return rows.length > 0 ? rows[0]!.balance : null;
}

/**
 * Atomically add credits, creating the balance row if it doesn't exist
 * yet (UPSERT). Guarantees a recharge / purchase always lands even if
 * the row was never opened — money in must never silently no-op.
 * @param userId - ID of the user to credit.
 * @param amount - Number of credits to add (positive value).
 * @param tx - optional transaction to run inside.
 * @returns the new balance after the addition.
 */
export async function addBalance(
  userId: string,
  amount: number,
  tx?: DbTx,
): Promise<number> {
  const conn = tx ?? db;
  const result = await conn.execute(
    sql`INSERT INTO credit_balances AS cb ("user_id", "balance")
        VALUES (${userId}, ${amount})
        ON CONFLICT ("user_id") DO UPDATE
          SET balance = cb.balance + ${amount}, updated_at = NOW()
        RETURNING cb.balance`,
  );
  const rows = result as unknown as Array<{ balance: number }>;
  return rows[0]?.balance ?? 0;
}

/**
 * Create the initial balance row for a newly-registered user (the
 * credit equivalent of opening an account). Idempotent via
 * `ON CONFLICT DO NOTHING` so a registration retry can't error.
 * @param userId - ID of the newly-registered user to open a balance row for.
 * @param initialBalance - Starting balance for the new row. Defaults to 0.
 * @param tx - optional transaction (registration may create the user +
 *   balance row atomically).
 */
export async function createBalanceRow(
  userId: string,
  initialBalance = 0,
  tx?: DbTx,
): Promise<void> {
  const conn = tx ?? db;
  await conn
    .insert(creditBalances)
    .values({ userId, balance: initialBalance })
    .onConflictDoNothing();
}
