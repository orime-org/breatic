// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { DbTx } from "@breatic/core";
import { miniToolExecutionRecordSchema } from "@breatic/shared/mini-tools";
import type { MiniToolConsumptionRecord } from "@domain/mini-tool/consumption.types.js";
import * as taskRepo from "@domain/task/task.repo.js";

/**
 * Mirror one original expense in the same transaction that advances its truth.
 * @param task - The parent read under the existing consumption lock.
 * @param consumption - The actual pending, known or recorded step fact.
 * @param tx - The transaction saving the original step and any usage row.
 * @returns Nothing; other mini-tool lanes keep their current result shape.
 * @throws {Error} When a planned namespace or its atomic write is invalid.
 */
export async function mirrorMiniToolExecutionConsumption(
  task: taskRepo.LockedMiniToolConsumptionTask, consumption: MiniToolConsumptionRecord, tx: DbTx,
): Promise<void> {
  if (task.result.miniToolExecution === undefined) return;
  const record = miniToolExecutionRecordSchema.parse(task.result.miniToolExecution);
  const publicFact = {
    consumptionKey: consumption.consumptionKey, state: consumption.state, chargeTo: consumption.chargeTo,
    costUsd: consumption.costUsd, credits: consumption.credits,
  };
  const found = record.usage.findIndex((fact) => fact.consumptionKey === consumption.consumptionKey);
  if (found === -1) record.usage.push(publicFact);
  else record.usage[found] = publicFact;
  await taskRepo.storeMiniToolExecutionRecord(task.id, { ...miniToolExecutionRecordSchema.parse(record) }, tx);
}
