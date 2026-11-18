// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { accountActivityRepo, db } from "@breatic/core";
import { taskService } from "@breatic/domain";
import type { GenerationSource, TaskEntity } from "@breatic/shared";
import type { TaskKeyRows } from "@server/modules/task/run-keys.js";

/** `taskService.create`'s arguments up to the row's id, then the key rows the task runs on (inner#1953). */
type AdmitArgs = [
  userId: string,
  projectId: string | undefined,
  spaceId: string,
  taskType: string,
  mode: "append" | "overwrite",
  params: Record<string, unknown>,
  model?: string,
  source?: GenerationSource,
  id?: string,
  keys?: TaskKeyRows,
];

/**
 * Admit an HTTP generation and its activity in the same product transaction.
 * Background callers retain taskService.create and never imply a user return.
 * @param args - The already authorized task creation request, and the key rows it runs on; our keys when absent.
 * @returns The newly admitted task.
 * @throws {Error} When either task or activity persistence fails.
 */
export async function admitGeneration(...args: AdmitArgs): Promise<TaskEntity> {
  return db.transaction(async (tx) => {
    const [userId, projectId, spaceId, taskType, mode, params, model, source, id, keys] = args;
    const task = await taskService.create(userId, projectId, spaceId, taskType, mode, params, model, source, id, tx, keys);
    await accountActivityRepo.recordActivity({ userId, projectId: projectId ?? null, kind: "generation_started" }, tx);
    return task;
  });
}
