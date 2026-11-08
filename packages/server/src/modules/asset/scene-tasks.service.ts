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
  type SceneTaskRow,
} from "@breatic/domain";
import { modesOf, picturesOf, t, type SceneGenerationOrigin, type TaskEntity } from "@breatic/shared";
import * as projectService from "@server/modules/project/project.service.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";

type SpaceRow = NonNullable<Awaited<ReturnType<typeof sceneTaskService.findById>>>;

/** What every row of the list carries. */
interface SpaceTaskCommon {
  id: string;
  label: string;
  status: "running" | "done" | "failed" | "expired";
  startedByUserId: string;
  startedAt: string;
  deadlineAt: string;
  assetId: string | null;
  /** The `task-failure` code, or the upstream's own words for a failure it gave. */
  errorMessage: string | null;
}

/** A model upload, as the panel reads it. */
export interface SpaceImportWire extends SpaceTaskCommon {
  kind: "import";
}

/** A 3D generation, as the panel reads it: what a retry fills the dialog with, and why it failed. */
export interface SpaceGenerationWire extends SpaceTaskCommon {
  kind: "generation";
  origin: SceneGenerationOrigin | null;
  model: { name: string; displayName: string };
  mode: string;
  prompt: string | null;
  /** The resolved settings, `negative_prompt` among them, without the prompt or the views. */
  params: Record<string, unknown>;
  /** The views in front, left, back, right order. */
  inputs: Array<{ assetId: string; url: string }>;
}

/** One row as the panel reads it. */
export type SpaceTaskWire = SpaceImportWire | SpaceGenerationWire;

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
  // The views sit under the param the entry reads them in, as the submission wrote them.
  const viewParam = entry === undefined ? undefined : picturesOf(entry)?.name;
  const views = viewParam === undefined ? undefined : params[viewParam];
  const ids = Array.isArray(params.input_asset_ids) ? params.input_asset_ids.filter((id): id is string => typeof id === "string") : [];
  const urls: unknown[] = Array.isArray(views) ? views : [views];
  const entryMode = entry === undefined ? undefined : modesOf(entry)[0];
  const notSettings = new Set(["prompt", "input_asset_ids", ...(viewParam === undefined ? [] : [viewParam])]);
  return {
    origin: row.origin,
    model: { name, displayName: entry?.display_name ?? name },
    mode: entryMode ?? (ids.length > 0 ? "i23d" : "t23d"),
    prompt: typeof params.prompt === "string" ? params.prompt : null,
    params: Object.fromEntries(Object.entries(params).filter(([key]) => !notSettings.has(key))),
    inputs: ids.map((assetId, index) => {
      const url = urls[index];
      return { assetId, url: typeof url === "string" ? url : "" };
    }),
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
        errorMessage: row.errorMessage,
      };
      return row.action === "generate"
        ? { ...common, kind: "generation", ...generationFields(row, row.taskId === null ? undefined : runs.get(row.taskId)) }
        : { ...common, kind: "import" };
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
  const row = await sceneTaskService.findById(taskId);
  if (
    row === null ||
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
 * it already has one, land it on the row (design 4.4). The outcome is judged
 * on the run as read after its job is known to have stopped: the worker
 * charges and settles the row before it ends the job, so a run read then
 * holds whatever result the job produced.
 * @param row - The generation row, expired and holding nothing.
 * @returns What the check found.
 * @throws {Error} When the queue or the database cannot be read.
 */
async function checkRun(row: SpaceRow): Promise<GenerationCheck> {
  if (row.taskId === null) return "ended";
  const queued = await taskService.getByIdInternal(row.taskId);
  if (queued === null) return "ended";
  if (queued.arqJobId) {
    const job = await tasksQueue().getJob(queued.arqJobId);
    if (job !== undefined && STILL_RUNNING.has(await job.getState())) return "running";
  } else if (queued.status === "pending" || queued.status === "running") {
    // No job id recorded: nothing can say the job ended, so it may still run.
    return "running";
  }
  const run = (await taskService.getByIdInternal(row.taskId)) ?? queued;
  const outcome = sceneTaskService.generationOutcome((run.result as { outputs?: Array<{ asset_id?: unknown }> } | null)?.outputs);
  if (run.billedAt === null || outcome.outcome === "failed") return "ended";
  const settled = await sceneTaskService.settle(row, outcome);
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
