// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The `operation_ledger` table's one home (inner#1968, design 3.1): one row
 * per operation an account's monthly allowance counts.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, operationLedger } from "@breatic/core";
import type { DbTx } from "@breatic/core";

/** What one account has counted in one period, by slot. */
export interface PeriodCounts {
  /** Counted rows the allowance covered. */
  readonly allowance: number;
  /** Counted rows charged as overage. */
  readonly overage: number;
}

/**
 * Count one account's counted operations in the period that starts at `periodStart`.
 * @param accountUserId - Whose allowance.
 * @param periodStart - The period's start, which identifies it.
 * @param tx - Optional transaction handle.
 * @returns The counts by slot.
 */
export async function countInPeriod(accountUserId: string, periodStart: Date, tx?: DbTx): Promise<PeriodCounts> {
  const [row] = await (tx ?? db)
    .select({
      allowance: sql<number>`count(*) filter (where ${operationLedger.slot} = 'allowance')::int`,
      overage: sql<number>`count(*) filter (where ${operationLedger.slot} = 'overage')::int`,
    })
    .from(operationLedger)
    .where(and(
      eq(operationLedger.accountUserId, accountUserId),
      eq(operationLedger.status, "counted"),
      eq(operationLedger.periodStart, periodStart),
    ));
  return { allowance: row?.allowance ?? 0, overage: row?.overage ?? 0 };
}
