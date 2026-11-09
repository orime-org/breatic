// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one home of `agent_usage_records` (#296): rows are appended here and
 * nowhere else.
 */

import { inArray, sql } from "drizzle-orm";
import { agentUsageRecords, db } from "@breatic/core";
import type { UsageRow } from "@domain/credit/usage-recorder.js";

/**
 * Append one usage row. A container run's row is written once per task.
 * @param row - The paid call to record.
 * @returns Nothing once the row is written, or once an earlier attempt's is found.
 * @throws {Error} When the write fails.
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
      costIdentity: row.costIdentity,
    })
    // A container run has one row per task, whichever attempt writes it first,
    // and a call with a cost identity one row per identity; every other row has
    // nothing to conflict with.
    .onConflictDoNothing();
}

/**
 * The credits recorded under each operation key.
 * @param operationKeys - The operations.
 * @returns Each key's total as Postgres sums the numeric; a key with no rows is absent.
 * @throws {Error} When the read fails.
 */
export async function sumCreditsByOperationKeys(operationKeys: readonly string[]): Promise<Map<string, string>> {
  if (operationKeys.length === 0) return new Map();
  const rows = await db
    .select({ operationKey: agentUsageRecords.operationKey, credits: sql<string>`sum(${agentUsageRecords.credits})::text` })
    .from(agentUsageRecords)
    .where(inArray(agentUsageRecords.operationKey, [...operationKeys]))
    .groupBy(agentUsageRecords.operationKey);
  return new Map(rows.map((row) => [row.operationKey, row.credits]));
}
