// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Submitting a 3D generation from a 3D Space (inner#1691 design 4.2).
 *
 * Steps 1 to 5 are the Canvas generation's (`holdRun`): editor
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
  estimateTaskCredits,
  planSceneGeneration,
  resolveProjectImageInputs,
  sceneTaskService,
  type ProjectImageInput,
  type SceneGenerationPlan,
  type SceneGenerationProblem,
} from "@breatic/domain";
import {
  SCENE_OBJECT_NAME_MAX,
  t,
  type ParamViolation,
  type SceneGenerationAnswer,
  type SceneGenerationBody,
} from "@breatic/shared";
import { assertStorageAllowance } from "@server/modules/asset/storageQuota.service.js";
import { assertServable } from "@server/modules/task/model-servable.js";
import { admitGeneration } from "@server/modules/task/admit-generation.service.js";
import { recordJobId, settleUnqueuedRun } from "@server/modules/task/generation-task.js";
import { publishSpaceTasksQuietly } from "@server/modules/task/publish-counts.js";
import { tasksQueue } from "@server/modules/task/tasks-queue.js";

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
    case "text":
      return t("server.three_d.setting_text", { param: v.param, value: shown(v.value) });
    case "bounds":
      return t("server.three_d.setting_bounds", { param: v.param, min: shown(v.min ?? null), max: shown(v.max ?? null), value: v.value });
    case "max_length":
    case "prompt_max_length":
      return t("server.three_d.setting_too_long", { param: v.param, max: v.max, length: v.length });
    case "min_length":
      // Named by its control's label, the one the dialog shows (the canvas panels' key family).
      return t("server.canvas.param_too_short", { name: t(`canvas.generatePanel.param.${v.param}`) });
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
 * A row's label: the text cut to what a scene object's name holds, since
 * placing the model names the object by it.
 * @param text - The cleaned prompt, the front view's name or the model's.
 * @returns The label.
 */
function rowLabel(text: string): string {
  // The name rule counts UTF-16 units; whole characters keep a pair together.
  let label = "";
  for (const character of text) {
    if (label.length + character.length > SCENE_OBJECT_NAME_MAX) break;
    label += character;
  }
  return label.trim();
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
 * @throws {AppError} 503 when no upstream here can serve the model, naming the variables it needs.
 */
export async function checkSubmission(projectId: string, submission: SceneGenerationBody): Promise<CheckedSubmission> {
  const views = submission.image_asset_ids ?? [];
  const plan = planSceneGeneration({
    mode: submission.mode,
    model: submission.model,
    prompt: submission.prompt,
    params: submission.params,
    imageCount: views.length,
  });
  if (!plan.ok) throw new ValidationError(problemMessage(plan.problem));
  // A model no upstream here can serve is refused before anything is held or queued.
  assertServable(plan.entry.name, plan.entry.display_name);
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
  submission: SceneGenerationBody,
  held: { taskId: string; checked: CheckedSubmission },
): Promise<SceneGenerationAnswer> {
  const { taskId } = held;
  const { plan, images } = held.checked;
  const params = jobParams(plan, submission.prompt, images);
  const label = rowLabel(plan.prompt ?? images[0]?.displayName ?? plan.entry.display_name);

  let rowId: string | undefined;
  let queued: { rowId: string; jobId: string | undefined };
  try {
    await assertStorageAllowance(projectId, "generate");
    const task = await admitGeneration(userId, projectId, spaceId, "three_d", "append", params, plan.entry.name, "task", taskId);
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
    await settleUnqueuedRun(
      taskId,
      projectId,
      "internal",
      async () => {
        if (opened !== undefined) await sceneTaskService.settleById(opened, { outcome: "failed", errorMessage: "internal" });
      },
      "scene_generation",
    );
    logger.error({ err, taskId, projectId, spaceId, model: plan.entry.name }, "scene_generation_run_failed");
    // An open row is the answer: it holds the cause and the list shows it.
    if (opened === undefined) throw err;
    await publishSpaceTasksQuietly(projectId, spaceId);
    return { task_id: taskId, row_id: opened, status: "failed" };
  }

  await recordJobId(taskId, queued.jobId, projectId, "scene_generation");
  await publishSpaceTasksQuietly(projectId, spaceId);
  return { task_id: taskId, row_id: queued.rowId, status: "pending" };
}
