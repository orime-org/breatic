// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { endMiniToolModelStep, listUnresolvedMiniToolModelSteps, MINI_TOOL_MODEL_ROUTE } from "@breatic/domain";
import { mediaRunner } from "@worker/handlers/model-task.js";

/**
 * End every model step a video mini-tool run leaves unresolved before its final state is written (inner#1306 execution
 * design §11.4 run end): each is abandoned through provider, and what the abandon hands over ends it `failed`, as a
 * `timeout` when the run's deadline ended it. A step with no ticket was never sent and cost nothing.
 * @param taskId - The run's task.
 * @param reason - Why the run ends: its deadline, or anything else.
 * @throws {Error} When a step's end cannot be recorded.
 */
export async function abandonUnresolvedModelSteps(taskId: string, reason: "deadline" | "failed"): Promise<void> {
  const category = reason === "deadline" ? "timeout" : "failed";
  for (const step of await listUnresolvedMiniToolModelSteps(taskId)) {
    const costs = step.ticket === null ? [] : mediaRunner().abandon(step.ticket).costs;
    await endMiniToolModelStep({ taskId, stepId: step.stepId, end: { kind: "failed", category, error: { code: category, message: "The run ended before this step did" } },
      // A model step runs only on the frozen route's upstream, which abandon does not name.
      costs, servedBy: step.ticket === null ? null : MINI_TOOL_MODEL_ROUTE.upstream });
  }
}
