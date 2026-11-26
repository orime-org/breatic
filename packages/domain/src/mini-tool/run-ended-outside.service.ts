// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type { DbTx } from "@breatic/core";
import * as taskRepo from "@domain/task/task.repo.js";
import * as presentationPinService from "@domain/presentation/presentation-pin.service.js";
import { endMiniToolExecutionOutsideRun } from "@domain/mini-tool/execution.service.js";

/**
 * End a mini-tool task's own lane when its task ended outside the worker (a queued cancel or the stale-waiter sweep,
 * inner#1968 design 3.9): the task's end is its terminal state (frames-split §7.15). A scene detection releases its
 * `analysis` pin; a planned run ends as `endMiniToolExecutionOutsideRun` says; any other task has no lane state here.
 * @param taskId - The task, whose row the caller's transaction just ended.
 * @param tx - That transaction.
 * @throws {Error} When the lane's own terminal write fails.
 */
export async function endMiniToolOutsideRun(taskId: string, tx: DbTx): Promise<void> {
  const task = await taskRepo.lockMiniToolExecutionTask(taskId, tx);
  if (task === null || task.source !== "mini_tool") return;
  if (task.taskType === "mini_tool_analysis") {
    await presentationPinService.release({ holderKind: "analysis", holderId: taskId }, tx);
    return;
  }
  if (task.params.miniToolExecution !== undefined) await endMiniToolExecutionOutsideRun(taskId, tx);
}
