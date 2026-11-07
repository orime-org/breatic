// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Moving a Timeline execution from the worker (inner#1711 design §5.2): every applied transition signals the Space's
 * task list, and an end that spent nothing releases the hold.
 */

import { logger, publishSpaceTasksChanged, timelineExecutionRepo, type TimelineExecutionEvent, type TimelineExecutionTransition } from "@breatic/core";
import { creditHoldService } from "@breatic/domain";
import type { TimelineExecution } from "@breatic/shared";

/**
 * Tell the members with the Space open that its execution list changed, and carry on if that fails: whoever missed
 * it reads the list when they next open it.
 * @param row - The execution.
 * @returns Nothing.
 */
export async function signalSpace(row: Pick<TimelineExecution, "id" | "projectId" | "spaceId">): Promise<void> {
  try {
    await publishSpaceTasksChanged(row.projectId, row.spaceId);
  } catch (err) {
    logger.error({ err, executionId: row.id, projectId: row.projectId, spaceId: row.spaceId }, "space_tasks_publish_failed");
  }
}

/**
 * Apply one event and signal the Space when it was applied.
 * @param row - The execution.
 * @param event - The event.
 * @returns The transition's outcome.
 * @throws {Error} When the write fails.
 */
export async function move(row: Pick<TimelineExecution, "id" | "projectId" | "spaceId">, event: TimelineExecutionEvent): Promise<TimelineExecutionTransition> {
  const result = await timelineExecutionRepo.transition({ id: row.id, event });
  if (result.applied) await signalSpace(result.row);
  return result;
}

/**
 * End an execution that spent nothing: apply the event and, when it applied, release the hold.
 * @param row - The execution.
 * @param event - A terminal event.
 * @returns The transition's outcome.
 * @throws {Error} When the write or the release fails.
 */
export async function endUnspent(row: Pick<TimelineExecution, "id" | "projectId" | "spaceId">, event: TimelineExecutionEvent): Promise<TimelineExecutionTransition> {
  const result = await timelineExecutionRepo.transition({ id: row.id, event });
  if (result.applied) {
    await creditHoldService.releaseHold(row.id);
    await signalSpace(result.row);
  }
  return result;
}
