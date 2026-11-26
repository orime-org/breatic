// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { createQueue, currentConsent, defaultJobOpts } from "@breatic/core";
import { miniToolExecutionService, type AcceptedMiniToolExecution, type MiniToolExecutionJob } from "@breatic/domain";
import { startRowedRun } from "@server/modules/task/generation-task.js";

let tasksQueue: ReturnType<typeof createQueue> | undefined;

/**
 * Start the accepted planned run with the original row and queue owners; admission already held its credits.
 * @param accepted - The complete SQL-claimed execution plan.
 * @param userId - Its authenticated initiating actor.
 * @returns Pending after queue acceptance or failed after a refused opened run.
 * @throws {Error} When admission fails before a node row can carry the refusal.
 */
export async function startPlannedMiniToolRun(accepted: AcceptedMiniToolExecution, userId: string): Promise<"pending" | "failed"> {
  const job: MiniToolExecutionJob = {
    taskId: accepted.taskId, source: "mini_tool", executionKind: "planned", analyticsConsent: currentConsent(),
  };
  return startRowedRun({
    taskId: accepted.taskId, projectId: accepted.projectId, spaceId: accepted.spaceId,
    nodeIds: accepted.targetNodeIds, userId, action: "mini_tool", label: accepted.tool,
    enqueue: () => (tasksQueue ??= createQueue("tasks")).add("execute-mini-tool", job, { ...defaultJobOpts(), jobId: accepted.taskId }),
    settleFailure: async (reason) => {
      const record = await miniToolExecutionService.failMiniToolExecutionAdmission(accepted.taskId, { code: reason });
      return record.status === "completed" ? "completed" : "failed";
    },
    logTag: "mini_tool_planned", logContext: { tool: accepted.tool },
  });
}
