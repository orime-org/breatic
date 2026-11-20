// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { endMiniToolModelStep, listUnresolvedMiniToolModelSteps } from "@breatic/domain";
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
      // Abandon does not name who served; the step recorded the upstream it was sent to.
      costs, servedBy: step.ticket === null ? null : step.upstream });
  }
}
