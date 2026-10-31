// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's first completed generation, reported once (inner#1442).
 *
 * Its own module so the report can be tested without driving a whole task run.
 */

import { claimFirstMilestone, logger, projectsRepo, serverAnalyticsWanted, trackServerEvent } from "@breatic/core";

/**
 * Send `first_generation_completed` when this is the account's first
 * completed task (inner#1442 design §4.8). Called by the run that won the
 * billing CAS, so a task counts once however often it is delivered.
 * @param task - The task that just completed.
 * @param task.taskId - Its id.
 * @param task.taskType - What kind of generation it was.
 * @param task.userId - Who ran it.
 * @param task.projectId - Where it ran, when it is canvas-bound.
 */
export async function reportFirstGeneration(task: {
  taskId: string;
  taskType: string;
  userId: string;
  projectId?: string;
}): Promise<void> {
  try {
    if (!(await claimFirstMilestone("first-generation", task.userId))) return;
    if (!serverAnalyticsWanted()) return;
    const studioId = task.projectId ? await projectsRepo.findOwnerStudioId(task.projectId) : undefined;
    trackServerEvent("first_generation_completed", {
      userId: task.userId,
      insertId: `first-generation:${task.userId}`,
      properties: { studio_id: studioId, project_id: task.projectId, kind: task.taskType },
    });
  } catch (err) {
    logger.warn({ err, taskId: task.taskId }, "first_generation_report_failed");
  }
}
