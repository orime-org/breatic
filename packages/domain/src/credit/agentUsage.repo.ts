// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one home of `agent_usage_records` (#296): rows are appended here and
 * nowhere else.
 */

import { agentUsageRecords, db } from "@breatic/core";
import type { DbTx } from "@breatic/core";
import type { UsageRow } from "@domain/credit/usage-recorder.js";

/**
 * Append one usage row. Container consumption deduplicates by its operation key.
 * @param row - The paid call to record.
 * @param tx - An enclosing transaction when usage and business state commit together.
 * @returns Nothing once the row is written, or once an earlier attempt's is found.
 * @throws {Error} When the database insert fails.
 */
export async function insertUsageRecord(row: UsageRow, tx?: DbTx): Promise<void> {
  await (tx ?? db)
    .insert(agentUsageRecords)
    .values({
      operationKey: row.operationKey,
      feature: row.feature,
      source: row.source,
      actorUserId: row.actorUserId,
      projectId: row.projectId,
      model: row.model,
      provider: row.provider,
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      reasoningTokens: row.reasoningTokens,
      requestCount: row.requestCount,
      costUsd: String(row.costUsd),
      costSource: row.costSource,
      credits: String(row.credits),
    })
    // Only a container run has a unique key (one row per task, whichever
    // attempt writes it first); every other row has nothing to conflict with.
    .onConflictDoNothing();
}
