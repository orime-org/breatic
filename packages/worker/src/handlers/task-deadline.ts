// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a task's two hours run out (inner#1337 §3.2).
 */

import { getNodeTaskConfig } from "@breatic/core";
import { nodeTaskService } from "@breatic/domain";

/**
 * The deadline of a task's work. A task bound to canvas nodes ends with the
 * earliest of their rows; a task bound to none gets the same budget, counted
 * from when it was created — the moment a node's row would have started
 * counting.
 * @param taskId - The task.
 * @param createdAt - When the task row was created, or undefined when there is no row.
 * @returns The deadline in epoch milliseconds.
 * @throws {Error} When the task row is gone: there is nothing to run against.
 */
export async function taskDeadline(taskId: string, createdAt: Date | undefined): Promise<number> {
  const fromNodes = await nodeTaskService.deadlineFor(taskId);
  if (fromNodes !== null) return fromNodes;
  if (createdAt === undefined) throw new Error(`task ${taskId} has no row to run against`);
  return createdAt.getTime() + getNodeTaskConfig().default_budget_ms;
}
