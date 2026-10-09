// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a task's two hours run out (inner#1337 §3.2).
 */

import { getNodeTaskConfig } from "@breatic/core";
import { nodeTaskService, taskService } from "@breatic/domain";

/**
 * The deadline of a task's upstream work. A task bound to canvas nodes ends
 * with the earliest of their rows; a task bound to none gets the same budget,
 * counted from when it was created — the moment a node's row would have
 * started counting.
 * @param taskId - The task.
 * @returns The deadline in epoch milliseconds, or null when the task does not exist.
 */
export async function taskDeadline(taskId: string): Promise<number | null> {
  const fromNodes = await nodeTaskService.deadlineFor(taskId);
  if (fromNodes !== null) return fromNodes;
  const task = await taskService.getByIdInternal(taskId);
  if (task === null) return null;
  return task.createdAt.getTime() + getNodeTaskConfig().default_budget_ms;
}
