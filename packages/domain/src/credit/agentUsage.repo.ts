// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one home of `agent_usage_records` (#296): rows are appended here and
 * nowhere else.
 */

import { agentUsageRecords, db } from "@breatic/core";
import type { UsageRow } from "@domain/credit/usage-recorder.js";

/**
 * Append one usage row.
 * @param row - The paid call to record.
 * @returns Nothing once the row is written.
 */
export async function insertUsageRecord(row: UsageRow): Promise<void> {
  await db
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
    });
}
