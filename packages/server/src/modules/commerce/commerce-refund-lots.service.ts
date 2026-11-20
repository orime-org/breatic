// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lot facts the billing service's refund decisions read from the product
 * (inner#1993 §3.3 `refund-lots/facts`).
 */

import type { LotRefundFacts } from "@breatic/core";
import { creditLotRepo } from "@breatic/domain";
import type { StoredAnswer } from "@server/modules/commerce/commerce-request.repo.js";

/**
 * Many live lots' refund facts.
 * @param lotIds - The lots, at most 100.
 * @returns 200 with one row per live lot.
 * @throws {Error} When the database fails.
 */
export async function readRefundLotFacts(lotIds: string[]): Promise<StoredAnswer> {
  const rows = await creditLotRepo.readLotRefundFacts(lotIds);
  return { httpStatus: 200, body: rows.map(toLotRefundFacts) };
}

/**
 * One lot's refund facts in the contract's shape.
 * @param row - The lot as the repository read it.
 * @returns The facts.
 */
export function toLotRefundFacts(row: creditLotRepo.LotRefundFactsRow): LotRefundFacts {
  return {
    lotId: row.id,
    userId: row.userId,
    sourceId: row.sourceId,
    sourceKind: row.sourceKind,
    lifecycle: row.lifecycle,
    purchasedCredits: row.purchasedCredits,
    remainingCredits: row.remainingCredits,
    refundAttempts: row.refundAttempts,
    refundRequestedAt: row.refundRequestedAt?.toISOString() ?? null,
    ledgerSum: row.ledgerSum,
    everSpent: row.everSpent,
    everRestored: row.everRestored,
    designated: row.designated,
    createdAt: row.createdAt.toISOString(),
  };
}
