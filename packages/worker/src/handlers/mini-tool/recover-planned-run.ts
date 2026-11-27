// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The end of a planned video tool run whose job will not pick it up again (frames-split design §7.19), shared by the
 * failed-job cleanup and the planned run sweep: a run past its commit point completes (registered again idempotently); a
 * running one before it fails as internal; a pending one, never started, fails through the running-slot ending.
 */

import { getStreamRedis, logger } from "@breatic/core";
import { miniToolExecutionService, runningSlotService } from "@breatic/domain";
import { finishMiniToolExecutionAndNotify } from "@worker/handlers/mini-tool/execution-completion.js";
import { completedCompletion, failedCompletion } from "@worker/handlers/mini-tool/run-execution-task.js";

/**
 * End one planned run nobody will pick up again.
 * @param taskId - The run, which is also its job id.
 * @returns Whether this call ended it; false when nothing was left to end.
 * @throws {Error} When a read, a registration or the commit fails; a failed commit another pickup refused past the commit
 * point is left to the next round of the sweep.
 */
export async function recoverPlannedRun(taskId: string): Promise<boolean> {
  const { task, execution, record } = await miniToolExecutionService.readMiniToolExecution(taskId);
  if (task.status === "pending") {
    const ended = await runningSlotService.failTask(taskId, "internal");
    for (const err of ended.publishFailures) logger.error({ err, taskId }, "running_slot_publish_failed");
    return ended.failed;
  }
  if (task.status !== "running") return false;
  const completion = record.commitPoint !== undefined
    ? await completedCompletion(execution, record.resultVersion)
    : failedCompletion(execution, record.resultVersion, { code: "internal" });
  await finishMiniToolExecutionAndNotify(taskId, completion, getStreamRedis());
  return true;
}
