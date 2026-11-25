// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * When a task's two hours run out (inner#1337 §3.2).
 */

import { budgetDeadlineFrom } from "@breatic/core";
import { nodeTaskService } from "@breatic/domain";

/**
 * The deadline of a task's work. A task bound to canvas nodes ends with the
 * earliest of their rows; a task bound to none gets the same budget, counted
 * from when it started running: time spent waiting for a free running slot
 * does not count (inner#1968).
 * @param taskId - The task.
 * @param startedAt - When it started running, as its row records it.
 * @returns The deadline in epoch milliseconds.
 */
export async function taskDeadline(taskId: string, startedAt: Date): Promise<number> {
  return (await nodeTaskService.deadlineFor(taskId)) ?? budgetDeadlineFrom(startedAt.getTime());
}
