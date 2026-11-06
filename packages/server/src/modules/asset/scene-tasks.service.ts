// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the 3D Space task list's routes ask for (inner#1690): reading the
 * list, removing a row, and the uploader's own failure report.
 *
 * A path names a project, a Space and a row id the caller supplied, so every
 * write first proves the row is that Space's own row and checks access
 * against the project the row belongs to; a row that is not answers 404 in
 * every case, so an id says nothing back about what it named.
 */

import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import { nodeTaskService, sceneTaskService } from "@breatic/domain";
import { t } from "@breatic/shared";
import * as projectService from "@server/modules/project/project.service.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";

/** One row as the panel reads it. */
export interface SpaceTaskWire {
  id: string;
  label: string;
  status: "running" | "done" | "failed" | "expired";
  startedByUserId: string;
  startedAt: string;
  deadlineAt: string;
  errorMessage: string | null;
  assetId: string | null;
}

/**
 * The Space's list, judging overdue rows dead first.
 * @param userId - Who reads.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @returns The rows newest first, and the server's clock the deadlines are read against.
 * @throws {NotFoundError} When the reader is not a member of the project.
 */
export async function listSpaceTasks(
  userId: string,
  projectId: string,
  spaceId: string,
): Promise<{ serverNow: string; tasks: SpaceTaskWire[] }> {
  await projectService.assertAccess(projectId, userId, "viewer");
  const { tasks, harvested } = await sceneTaskService.harvestAndList(projectId, spaceId);
  if (harvested > 0) await publishSpaceTasksQuietly(projectId, spaceId);
  return {
    serverNow: new Date().toISOString(),
    tasks: tasks.map((row) => ({
      id: row.id,
      label: row.label,
      status: row.status,
      startedByUserId: row.startedByUserId,
      startedAt: row.startedAt.toISOString(),
      deadlineAt: new Date(nodeTaskService.rowDeadline(row)).toISOString(),
      errorMessage: row.errorMessage,
      assetId: row.assetId,
    })),
  };
}

/**
 * Read a row the path names, only when it is that Space's own live row.
 * @param projectId - The project in the path.
 * @param spaceId - The Space in the path.
 * @param taskId - The row in the path.
 * @returns The row.
 * @throws {NotFoundError} When the row is not that Space's own live row.
 */
async function spaceRow(
  projectId: string,
  spaceId: string,
  taskId: string,
): Promise<NonNullable<Awaited<ReturnType<typeof nodeTaskService.findById>>>> {
  const row = await nodeTaskService.findById(taskId);
  if (
    row === null ||
    row.nodeId !== null ||
    row.deletedAt !== null ||
    row.projectId !== projectId ||
    row.spaceId !== spaceId
  ) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return row;
}

/**
 * Remove a failed row, or an expired one holding no model.
 * @param userId - Who asks.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @throws {NotFoundError} When the row is not that Space's own live row, or the caller is not a member of the project.
 * @throws {ForbiddenError} When the caller is a member below Editor.
 * @throws {ConflictError} When the row is running or holds a model.
 */
export async function removeSpaceTask(
  userId: string,
  projectId: string,
  spaceId: string,
  taskId: string,
): Promise<void> {
  const row = await spaceRow(projectId, spaceId, taskId);
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (!(await sceneTaskService.remove(taskId))) {
    throw new ConflictError(t("server.error.conflict"));
  }
  await publishSpaceTasksQuietly(projectId, spaceId);
}

/**
 * The uploader's report that the bytes never reached the edge.
 * @param userId - Who reports.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @param reason - The one reason a browser can witness.
 * @returns Whether this report moved the row.
 * @throws {NotFoundError} When the row is not that Space's own live row, or the caller is not a member of the project.
 * @throws {ForbiddenError} When the caller is a member below Editor or did not start this upload.
 */
export async function reportSpaceTaskFailure(
  userId: string,
  projectId: string,
  spaceId: string,
  taskId: string,
  reason: "aborted",
): Promise<{ applied: boolean }> {
  const row = await spaceRow(projectId, spaceId, taskId);
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (row.startedByUserId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  const { applied } = await sceneTaskService.settle(row, { outcome: "failed", errorMessage: reason });
  await publishSpaceTasksQuietly(projectId, spaceId);
  return { applied };
}
