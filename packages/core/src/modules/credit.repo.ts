/**
 * Credit transaction repository — audit log for all credit changes.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "@core/db/client.js";
import { creditTransactions } from "@core/db/schema.js";
import type { CreditTransactionEntity } from "@breatic/shared";

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

/** Record a credit transaction. */
export async function recordTransaction(data: {
  userId: string;
  txType: string;
  amount: number;
  balanceAfter: number;
  tokensUsed?: number;
  model?: string;
  provider?: string;
  description?: string;
  referenceId?: string;
}): Promise<CreditTransactionEntity> {
  const rows = await db
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

/** List credit transactions for a user, ordered by most recent. */
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
