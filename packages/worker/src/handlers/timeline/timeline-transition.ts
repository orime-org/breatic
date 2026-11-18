// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Moving a Timeline execution from the worker (inner#1711 design §5.2): every transition applied through {@link move}
 * is announced to the execution's Space (#1490 design §4.7). A pickup's retry is the one transition written without
 * it, since a new attempt changes nothing the user sees.
 */

import { announceExecutionChange, logger, timelineExecutionRepo, type TimelineExecutionEvent, type TimelineExecutionTransition } from "@breatic/core";
import type { TimelineExecution } from "@breatic/shared";

/**
 * Tell the execution's Space that it changed, and carry on if Redis refuses: the open tabs read the next change.
 * @param row - The execution as written.
 * @returns Nothing.
 */
export async function signalSpace(row: Pick<TimelineExecution, "id" | "projectId" | "spaceId" | "origin">): Promise<void> {
  try {
    await announceExecutionChange(row);
  } catch (err) {
    logger.error({ err, executionId: row.id, projectId: row.projectId, spaceId: row.spaceId }, "execution_change_publish_failed");
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
