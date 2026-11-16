// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one way a Timeline execution moves (inner#1968, design 3.2): the
 * transition and, when it ends the execution, its operation, in one commit.
 * A success counts; a cancellation, failure or expiry releases, including a
 * late success landing on a cancelling row.
 */

import { db, timelineExecutionRepo, type DbTx, type TimelineExecutionEvent, type TimelineExecutionTransition } from "@breatic/core";
import * as operationService from "@domain/operation/operation.service.js";
import { timelineOperationKey } from "@domain/timeline/operation-key.js";

/**
 * Apply one event to an execution and settle its operation when the event ends it.
 * @param input - The execution and the event.
 * @param input.id - The execution.
 * @param input.event - The event.
 * @param tx - The caller's transaction; one is opened when absent.
 * @returns The transition's outcome.
 * @throws {Error} When the execution does not exist or a write fails; nothing then commits.
 */
export async function transition(
  input: { id: string; event: TimelineExecutionEvent },
  tx?: DbTx,
): Promise<TimelineExecutionTransition> {
  let counted: operationService.CountOutcome | null = null;
  /**
   * The transition and its settlement on one transaction.
   * @param t - The transaction.
   * @returns The transition's outcome.
   */
  const run = async (t: DbTx): Promise<TimelineExecutionTransition> => {
    const result = await timelineExecutionRepo.transition(input, t);
    if (!result.applied) return result;
    const key = timelineOperationKey(result.row.id);
    if (result.row.status === "succeeded") counted = await operationService.countOperation(key, t);
    else if (result.row.status === "cancelled" || result.row.status === "failed" || result.row.status === "expired") {
      await operationService.releaseOperation(key, t, result.row.status);
    }
    return result;
  };
  const result = tx === undefined ? await db.transaction(run) : await run(tx);
  await operationService.settleOverage(counted);
  return result;
}
