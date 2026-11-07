// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Submitting a 3D generation from a 3D Space (inner#1691 design 4.2).
 *
 * Steps 1 to 5 are the Canvas generation's (the route's `holdRun`): editor
 * access, this submission's checks ({@link checkSubmission}), and its
 * estimate ({@link estimateOf}) held under the new task's id. Then
 * the task, its Space-level row and the job, in that order, following
 * `startRowedRun`: a failure before the row exists releases the hold and is
 * the answer; a failure once the row exists settles the row `failed` with the
 * cause, and the row is the answer. Queueing is the point of no return: the
 * job runs and is charged whatever happens after it, so what follows only
 * logs.
 */

import { currentConsent, defaultJobOpts, getNodeTaskConfig, logger, ValidationError } from "@breatic/core";
import {
  creditHoldService,
  estimateTaskCredits,
  nodeTaskService,
  planSceneGeneration,
  resolveProjectImageInputs,
  sceneTaskService,
  taskService,
  type ProjectImageInput,
  type SceneGenerationOrigin,
  type SceneGenerationPlan,
  type SceneGenerationProblem,
} from "@breatic/domain";
import { t, type ParamViolation } from "@breatic/shared";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { admitGeneration } from "@server/modules/task/admit-generation.service.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";

/** A submission, as the route validated it. */
export interface SceneGenerationSubmission {
  mode: "t23d" | "i23d";
  model: string;
  prompt?: string;
  params: Record<string, unknown>;
  /** The views in front, left, back, right order. */
  imageAssetIds?: string[];
  origin: SceneGenerationOrigin;
}

/** What a submission answers: the task, its row, and whether the job was queued. */
export interface SceneGenerationAnswer {
  task_id: string;
  row_id: string;
  status: "pending" | "failed";
}

/**
 * A value as a refusal names it.
 * @param value - The value.
 * @returns It, written out.
 */
function shown(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * A broken settings rule, in the user's language.
 * @param v - The rule.
 * @returns The sentence.
 */
function violationMessage(v: ParamViolation): string {
  switch (v.rule) {
    case "forced":
      return t("server.three_d.setting_forced", { param: v.param, given: shown(v.given), force: v.force, value: shown(v.value) });
    case "values":
      return t("server.three_d.setting_values", { param: v.param, values: v.values.map(shown).join(", "), value: shown(v.value) });
    case "integer":
      return t("server.three_d.setting_integer", { param: v.param, value: shown(v.value) });
    case "bounds":
      return t("server.three_d.setting_bounds", { param: v.param, min: shown(v.min ?? null), max: shown(v.max ?? null), value: v.value });
    case "max_length":
    case "prompt_max_length":
      return t("server.three_d.setting_too_long", { param: v.param, max: v.max, length: v.length });
  }
}

/**
 * Why a submission does not hold together, in the user's language.
 * @param problem - What does not hold.
 * @returns The sentence.
 */
function problemMessage(problem: SceneGenerationProblem): string {
  switch (problem.kind) {
    case "model":
      return t("server.three_d.model_not_offered", { model: problem.model, mode: problem.mode });
    case "prompt":
      return problem.takesPrompt ? t("server.three_d.prompt_required") : t("server.three_d.prompt_not_taken", { model: problem.model });
    case "image_count":
      return t("server.three_d.image_count", { model: problem.model, min: problem.min, max: problem.max, actual: problem.actual });
    case "not_a_setting":
      return t("server.three_d.not_a_setting", { model: problem.model, param: problem.param });
    case "violation":
      return violationMessage(problem.violation);
  }
}

/**
 * The job's params, which `tasks.params` keeps: the resolved settings, the
 * prompt, the views' registered addresses in the param the entry reads them
 * in, and their asset ids in the same order for the list and a retry.
 * @param plan - The checked submission.
 * @param prompt - The prompt as given, on a text run.
 * @param images - The resolved views.
 * @returns The params.
 */
function jobParams(plan: SceneGenerationPlan, prompt: string | undefined, images: readonly ProjectImageInput[]): Record<string, unknown> {
  const { imageParam } = plan;
  return {
    ...plan.params,
    ...(plan.prompt !== null && prompt !== undefined ? { prompt } : {}),
    ...(imageParam === null || images.length === 0
      ? {}
      : { [imageParam.name]: imageParam.list ? images.map((image) => image.url) : images[0]!.url }),
    input_asset_ids: images.map((image) => image.assetId),
  };
}

/**
 * The params the worker is handed: the task's own, less the views' asset ids.
 * @param params - The params `tasks.params` keeps.
 * @returns The same params without `input_asset_ids`.
 */
function withoutAssetIds(params: Record<string, unknown>): Record<string, unknown> {
  const { input_asset_ids: _ids, ...sent } = params;
  return sent;
}

/** A submission that passed its checks: the resolved run and its views. */
export interface CheckedSubmission {
  plan: SceneGenerationPlan;
  images: ProjectImageInput[];
}

/**
 * A submission's own checks (design 4.2 steps 2 to 4): the model and mode,
 * the prompt, the number of views and the settings, then each view resolved
 * to an image of the project.
 * @param projectId - The project.
 * @param submission - What is asked for.
 * @returns The resolved run and its views.
 * @throws {ValidationError} 422 naming the rule broken, or the view slot that does not resolve.
 */
export async function checkSubmission(projectId: string, submission: SceneGenerationSubmission): Promise<CheckedSubmission> {
  const views = submission.imageAssetIds ?? [];
  const plan = planSceneGeneration({
    mode: submission.mode,
    model: submission.model,
    prompt: submission.prompt,
    params: submission.params,
    imageCount: views.length,
  });
  if (!plan.ok) throw new ValidationError(problemMessage(plan.problem));
  return { plan, images: await resolveProjectImageInputs(projectId, views) };
}

/**
 * What a checked submission is held for: the estimate of the settings it sends.
 * @param checked - The checked submission.
 * @returns The credits.
 * @throws {Error} When the model's pricing formula does not produce a finite price.
 */
export async function estimateOf(checked: CheckedSubmission): Promise<number> {
  return estimateTaskCredits(checked.plan.entry.name, { params: checked.plan.params, prompt: checked.plan.prompt ?? undefined });
}

/**
 * Start a 3D generation whose estimate is held: the task, its row and the job.
 * @param userId - Who submits it.
 * @param projectId - The project.
 * @param spaceId - The 3D Space it was submitted in.
 * @param submission - What is asked for.
 * @param held - The task id the hold is under, and the checked submission.
 * @param held.taskId - The id the task row takes.
 * @param held.checked - What {@link checkSubmission} returned.
 * @returns The task, its row and `pending`, or `failed` when queueing failed after the row opened.
 * @throws {AppError} 507 with no storage left, or the original error when anything fails before the row opened.
 */
export async function startSceneGeneration(
  userId: string,
  projectId: string,
  spaceId: string,
  submission: SceneGenerationSubmission,
  held: { taskId: string; checked: CheckedSubmission },
): Promise<SceneGenerationAnswer> {
  const { taskId } = held;
  const { plan, images } = held.checked;
  const params = jobParams(plan, submission.prompt, images);
  const label = plan.prompt ?? images[0]?.displayName ?? plan.entry.display_name;

  let created = false;
  let rowId: string | undefined;
  let queued: { rowId: string; jobId: string | undefined };
  try {
    await assertStorageAllowance(projectId, "generate");
    const task = await admitGeneration(userId, projectId, spaceId, "three_d", "append", params, plan.entry.name, "task", taskId);
    created = true;
    rowId = await sceneTaskService.openGeneration({
      projectId,
      spaceId,
      startedByUserId: userId,
      budgetMs: getNodeTaskConfig().default_budget_ms,
      label,
      taskId: task.id,
      origin: submission.origin,
    });
    const job = await tasksQueue().add(
      "execute-task",
      {
        taskId: task.id,
        userId,
        // The requesting browser's choice; the worker has no cookie (inner#1442 §4.4.5).
        analyticsConsent: currentConsent(),
        projectId,
        spaceId,
        taskType: "three_d",
        model: plan.entry.name,
        // The asset ids are the list's and a retry's to read off the task row;
        // the worker validates what it is handed and drops a name it does not know.
        params: withoutAssetIds(params),
        source: "task",
        // No node: the result lands on the Space's own row, which the worker settles.
        targetNodeIds: [],
        sceneRowId: rowId,
        mode: "append" as const,
      },
      defaultJobOpts(),
    );
    queued = { rowId, jobId: job.id };
  } catch (err) {
    const opened = rowId;
    for (const settle of [
      (): Promise<unknown> => creditHoldService.releaseHold(taskId),
      (): Promise<unknown> => (created ? taskService.markFailed(taskId, "internal") : Promise.resolve()),
      async (): Promise<unknown> => {
        if (opened === undefined) return;
        const row = await nodeTaskService.findById(opened);
        if (row !== null) await sceneTaskService.settleGeneration(row, { outcome: "failed", errorCode: "internal" });
      },
    ]) {
      try {
        await settle();
      } catch (settleErr) {
        logger.error({ err: settleErr, taskId, projectId, spaceId }, "scene_generation_run_settle_failed");
      }
    }
    logger.error({ err, taskId, projectId, spaceId, model: plan.entry.name }, "scene_generation_run_failed");
    // An open row is the answer: it holds the cause and the list shows it.
    if (opened === undefined) throw err;
    await publishSpaceTasksQuietly(projectId, spaceId);
    return { task_id: taskId, row_id: opened, status: "failed" };
  }

  // The worker's `markRunning` records the id too; this one is for whoever has
  // to find the job in the queue before it starts.
  try {
    await taskService.setJobId(taskId, queued.jobId ?? "");
  } catch (err) {
    logger.error({ err, taskId, jobId: queued.jobId, projectId }, "scene_generation_job_id_not_recorded");
  }
  await publishSpaceTasksQuietly(projectId, spaceId);
  return { task_id: taskId, row_id: queued.rowId, status: "pending" };
}
