// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { accountActivityRepo, db } from "@breatic/core";
import { taskService } from "@breatic/domain";
import type { TaskEntity } from "@breatic/shared";

/**
 * Admit an HTTP generation and its activity in the same product transaction.
 * Background callers retain taskService.create and never imply a user return.
 * @param args - The already authorized task creation request.
 * @returns The newly admitted task.
 * @throws {Error} When either task or activity persistence fails.
 */
export async function admitGeneration(...args: Parameters<typeof taskService.create>): Promise<TaskEntity> {
  return db.transaction(async (tx) => {
    const [userId, projectId, spaceId, taskType, mode, params, model, source, id] = args;
    const task = await taskService.create(userId, projectId, spaceId, taskType, mode, params, model, source, id, tx);
    await accountActivityRepo.recordActivity({ userId, projectId: projectId ?? null, kind: "generation_started" }, tx);
    return task;
  });
}
