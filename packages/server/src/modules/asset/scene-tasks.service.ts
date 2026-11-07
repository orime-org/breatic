// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the 3D Space task list's routes ask for (inner#1690, inner#1691):
 * reading the list, checking a timed-out generation against the queue,
 * removing a row, and the uploader's own failure report.
 *
 * A path names a project, a Space and a row id the caller supplied, so every
 * write first proves the row is that Space's own row and checks access
 * against the project the row belongs to; a row that is not answers 404 in
 * every case, so an id says nothing back about what it named.
 */

import { ConflictError, ForbiddenError, NotFoundError } from "@breatic/core";
import {
  modelCatalog,
  nodeTaskService,
  sceneTaskService,
  taskService,
  type SceneGenerationOrigin,
  type SceneTaskRow,
} from "@breatic/domain";
import { t, type TaskEntity } from "@breatic/shared";
import * as projectService from "@server/modules/project/project.service.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";

type SpaceRow = NonNullable<Awaited<ReturnType<typeof sceneTaskService.findRow>>>;

/** What every row of the list carries. */
interface SpaceTaskCommon {
  id: string;
  label: string;
  status: "running" | "done" | "failed" | "expired";
  startedByUserId: string;
  startedAt: string;
  deadlineAt: string;
  assetId: string | null;
}

/** A model upload, as the panel reads it. */
export interface SpaceImportWire extends SpaceTaskCommon {
  kind: "import";
  errorMessage: string | null;
}

/** A 3D generation, as the panel reads it: what a retry fills the dialog with, and why it failed. */
export interface SpaceGenerationWire extends SpaceTaskCommon {
  kind: "generation";
  /** The `task-failure` code, which the panel says in the user's language. */
  errorCode: string | null;
  origin: SceneGenerationOrigin | null;
  model: { name: string; displayName: string };
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  /** The resolved settings, without the prompt, the negative prompt or the views. */
  params: Record<string, unknown>;
  /** The views in front, left, back, right order. */
  inputs: Array<{ assetId: string; url: string }>;
}

/** One row as the panel reads it. */
export type SpaceTaskWire = SpaceImportWire | SpaceGenerationWire;

/** The job params that are not settings: said once each, in their own fields. */
const NOT_SETTINGS = new Set(["prompt", "negative_prompt", "image", "images", "input_asset_ids"]);

/**
 * A generation row's own fields, read from the run it names.
 * @param row - The row.
 * @param run - Its run, when it is still there.
 * @returns The fields.
 */
function generationFields(row: SceneTaskRow, run: TaskEntity | undefined): Omit<SpaceGenerationWire, keyof SpaceTaskCommon | "kind"> {
  const params = run?.params ?? {};
  const name = run?.model ?? "";
  const entry = modelCatalog.getModelCatalog().three_d.find((candidate) => candidate.name === name);
  const ids = Array.isArray(params.input_asset_ids) ? params.input_asset_ids.filter((id): id is string => typeof id === "string") : [];
  const urls = Array.isArray(params.images) ? params.images : typeof params.image === "string" ? [params.image] : [];
  const entryMode = entry === undefined ? undefined : Array.isArray(entry.mode) ? entry.mode[0] : entry.mode;
  return {
    errorCode: row.errorMessage,
    origin: row.origin,
    model: { name, displayName: entry?.display_name ?? name },
    mode: entryMode ?? (ids.length > 0 ? "i23d" : "t23d"),
    prompt: typeof params.prompt === "string" ? params.prompt : null,
    negativePrompt: typeof params.negative_prompt === "string" ? params.negative_prompt : null,
    params: Object.fromEntries(Object.entries(params).filter(([key]) => !NOT_SETTINGS.has(key))),
    inputs: ids.map((assetId, index) => ({ assetId, url: typeof urls[index] === "string" ? urls[index] : "" })),
  };
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
  const runs = await sceneTaskService.runsOf(tasks);
  return {
    serverNow: new Date().toISOString(),
    tasks: tasks.map((row): SpaceTaskWire => {
      const common: SpaceTaskCommon = {
        id: row.id,
        label: row.label,
        status: row.status,
        startedByUserId: row.startedByUserId,
        startedAt: row.startedAt.toISOString(),
        deadlineAt: new Date(nodeTaskService.rowDeadline(row)).toISOString(),
        assetId: row.assetId,
      };
      return row.action === "generate"
        ? { ...common, kind: "generation", ...generationFields(row, row.taskId === null ? undefined : runs.get(row.taskId)) }
        : { ...common, kind: "import", errorMessage: row.errorMessage };
    }),
  };
}

/**
 * Read a row the path names, only when it is that Space's own live row.
 * @param projectId - The project in the path.
 * @param spaceId - The Space in the path.
 * @param taskId - The row in the path.
 * @param actions - The kinds of row this caller acts on.
 * @returns The row.
 * @throws {NotFoundError} When the row is not that Space's own live row of one of those kinds.
 */
async function spaceRow(
  projectId: string,
  spaceId: string,
  taskId: string,
  actions: readonly string[] = ["scene_import", "generate"],
): Promise<SpaceRow> {
  const row = await sceneTaskService.findRow(taskId);
  if (
    row === null ||
    row.nodeId !== null ||
    row.deletedAt !== null ||
    row.projectId !== projectId ||
    row.spaceId !== spaceId ||
    !actions.includes(row.action)
  ) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return row;
}

/** What one check of a timed-out generation against the queue found. */
export type GenerationCheck = "running" | "has_result" | "ended";

/** The job states in which a generation may still produce a result. */
const STILL_RUNNING = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

/**
 * Whether a timed-out generation's job can still produce a result, and when
 * it already has one, land it on the row (design 4.4). The job is read before
 * the run: the worker charges and writes the row before it ends the job, so a
 * job that has ended has its result settled.
 * @param row - The generation row, expired and holding nothing.
 * @returns What the check found.
 * @throws {Error} When the queue or the database cannot be read.
 */
async function checkRun(row: SpaceRow): Promise<GenerationCheck> {
  const run = row.taskId === null ? null : await taskService.getByIdInternal(row.taskId);
  if (run === null) return "ended";
  if (run.arqJobId) {
    const job = await tasksQueue().getJob(run.arqJobId);
    if (job !== undefined && STILL_RUNNING.has(await job.getState())) return "running";
  } else if (run.status === "pending" || run.status === "running") {
    // No job id recorded: nothing can say the job ended, so it may still run.
    return "running";
  }
  const outputs = (run.result as { outputs?: Array<{ asset_id?: unknown }> } | null)?.outputs;
  const assetId = outputs?.[0]?.asset_id;
  if (run.billedAt === null || typeof assetId !== "string") return "ended";
  const settled = await sceneTaskService.settleGeneration(row, { outcome: "done", assetId });
  if (settled.assetWritten) await publishSpaceTasksQuietly(row.projectId, row.spaceId);
  return "has_result";
}

/**
 * Check a timed-out generation that holds no result against the queue.
 * @param userId - Who asks.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @returns What the check found.
 * @throws {NotFoundError} When the row is not that Space's own live generation row, or the caller is not a member of the project.
 * @throws {ForbiddenError} When the caller is a member below Editor.
 * @throws {ConflictError} When the row is not a timed-out one holding no result.
 */
export async function checkSpaceTask(
  userId: string,
  projectId: string,
  spaceId: string,
  taskId: string,
): Promise<{ outcome: GenerationCheck }> {
  const row = await spaceRow(projectId, spaceId, taskId, ["generate"]);
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (row.status !== "expired" || row.assetId !== null) throw new ConflictError(t("server.error.conflict"));
  return { outcome: await checkRun(row) };
}

/**
 * Remove a failed row, or an expired one holding no model. A timed-out
 * generation is checked against the queue first, and stays while its job can
 * still produce a result or already has.
 * @param userId - Who asks.
 * @param projectId - The project.
 * @param spaceId - The 3D Space.
 * @param taskId - The row.
 * @returns Removed, or the check that kept a timed-out generation.
 * @throws {NotFoundError} When the row is not that Space's own live row, or the caller is not a member of the project.
 * @throws {ForbiddenError} When the caller is a member below Editor.
 * @throws {ConflictError} When the row is running or holds a model.
 */
export async function removeSpaceTask(
  userId: string,
  projectId: string,
  spaceId: string,
  taskId: string,
): Promise<{ removed: true } | { removed: false; outcome: Exclude<GenerationCheck, "ended"> }> {
  const row = await spaceRow(projectId, spaceId, taskId);
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (row.action === "generate" && row.status === "expired" && row.assetId === null) {
    const outcome = await checkRun(row);
    if (outcome !== "ended") return { removed: false, outcome };
  }
  if (!(await sceneTaskService.remove(taskId))) {
    throw new ConflictError(t("server.error.conflict"));
  }
  await publishSpaceTasksQuietly(projectId, spaceId);
  return { removed: true };
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
  const row = await spaceRow(projectId, spaceId, taskId, ["scene_import"]);
  await projectService.assertAccess(row.projectId, userId, "editor");
  if (row.startedByUserId !== userId) throw new ForbiddenError(t("server.error.forbidden"));
  const { applied } = await sceneTaskService.settle(row, { outcome: "failed", errorMessage: reason });
  await publishSpaceTasksQuietly(projectId, spaceId);
  return { applied };
}
