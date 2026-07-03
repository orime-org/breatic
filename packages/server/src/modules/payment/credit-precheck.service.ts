// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Credit pre-check shared by every task-enqueuing route (#1580 #7, user
 * decision 2026-07-03: the server refuses obviously-insufficient balances
 * BEFORE creating a task; the worker still bills the actual usage at
 * completion).
 *
 * NON-LOCKING by design: the check reads the balance without reserving
 * anything, so two requests passing concurrently can drive the balance
 * negative — the accepted trade-off of a soft pre-check (the alternative,
 * reserving credits, needs a full hold/settle/expire lifecycle for a
 * marginal gain). `markCompletedAndBill`'s atomic deduct remains the
 * billing source of truth.
 *
 * Extracted from mini-tools' route-local `checkCredits` so /canvas/tasks
 * and /mini-tools/* share ONE pre-check that can never drift.
 */

import { env } from "@breatic/core";
import { creditService } from "@breatic/domain";

/**
 * Reject a task-enqueue request whose owner cannot cover `required`
 * credits. Skipped entirely when payments are disabled (dev / self-host).
 * @param userId - The authenticated user whose balance is checked.
 * @param required - Credits the caller must at least hold (the model's
 *   `cost_per_call` estimate, or `MIN_TASK_CREDIT_COST` for flat checks).
 * @returns An error message when the balance is below `required`, or
 *   `null` when affordable (or payments are disabled).
 */
export async function precheckCredits(
  userId: string,
  required: number,
): Promise<string | null> {
  if (!env.PAYMENT_ENABLED) return null;
  const balance = await creditService.getBalance(userId);
  if (balance < required) {
    return `Insufficient credits. Required: ${required}, available: ${balance}`;
  }
  return null;
}
