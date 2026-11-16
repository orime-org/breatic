// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Monthly operations (inner#1968): what an account has used of its allowance.
 */

import { getMembershipReadingForUser, getOperationsConfig } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import { quantizeQuotedCredits, serializeCreditMicro, type OperationUsage } from "@breatic/shared";
import * as operationRepo from "@domain/operation/operation.repo.js";

/**
 * What one account has used of this period's operations, read under no lock:
 * one membership reading gives the allowance and the period, one aggregate
 * gives the counts.
 * @param userId - The account.
 * @param tx - Optional transaction handle.
 * @returns The usage, or null where operations are not counted (payments off, or the self_hosted tier).
 * @throws {Error} if no live account has that id, or its data is invalid.
 */
export async function readOperationUsage(userId: string, tx?: DbTx): Promise<OperationUsage | null> {
  const { operations } = await getMembershipReadingForUser(userId, tx);
  if (!operations.charging) return null;
  const counts = await operationRepo.countInPeriod(userId, operations.period.start, tx);
  return {
    monthlyAllowance: operations.monthly,
    usedThisPeriod: counts.allowance + counts.overage,
    allowanceUsed: counts.allowance,
    allowanceRemaining: Math.max(0, operations.monthly - counts.allowance),
    overageThisPeriod: counts.overage,
    periodStart: operations.period.start.toISOString(),
    nextResetAt: operations.period.end.toISOString(),
    overageCredits: serializeCreditMicro(quantizeQuotedCredits(getOperationsConfig().overage_credits)),
  };
}
