// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { getMiniToolsConfig, logger } from "@breatic/core";
import { miniToolPeopleAnalysis, miniToolSceneAnalysis, openContainerOutputs, upstreamStepRepo,
  type miniToolAnalysisService } from "@breatic/domain";
import { assertBeforeDeadline, DeadlinePassed, MINI_TOOL_JOB_MAX_OUTPUTS, miniToolPlanJobRequestSchema,
  type MiniToolPlanJobRequest, type MiniToolPlanRecipe, type VideoPresentationLedger } from "@breatic/shared";
import { chunkVideoOutputs, miniToolAnalysisRecordSchema, presentationFrameCount, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { FullLedgerInvalid, peopleRecipeOf, readJobLedger, sceneCutsRecipeOf, sceneCutsResultOf } from "@worker/handlers/video-presentation-recipes.js";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { advanceRegisteredMiniToolPlanJob, type RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { readMiniToolAnalysisJson } from "@worker/handlers/mini-tool/read-analysis-json.js";

/** SQL owns the original source, accepted inputs and notification context. */
type Execution = miniToolAnalysisService.MiniToolAnalysisExecution;
/** A stored task-owned descriptor retains its actual position and original endpoint. */
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
/** Each analysis recipe names its original output index and output modality. */
export interface AnalysisOutput { outputIndex: number; modality: "text" | "image"; recipe: MiniToolPlanRecipe }
/** The original step supplies cached JSON while its job supplies live canonical rows. */
export interface AnalysisJob { step: Step; job: RegisteredMiniToolPlanJob }
/** The scene cuts placed on the presentation, cached in the step so a replay after D needs neither JSON nor ledger. */
interface ScenePlacement { placed: { frameIndex: number; pts: number }[]; clock: { frameCount: number; timescale: number } }
const SCENE_PLACEMENT = "miniToolScenePlacement";

/**
 * Restore a saved plan or open one new original job within the unchanged deadline.
 * @param execution - The SQL-owned accepted analysis.
 * @param deadlineAt - The original computation deadline.
 * @param position - The stable step and container chunk position.
 * @param outputs - The complete ordered recipes for this chunk, built only when the step has no stored request.
 * @param initial - The first job's frozen runtime policy for subsequent chunks.
 * @param inputs - The job's inputs, built only when the step has no stored request; the source when absent.
 * @returns The original owning step and registered terminal job.
 * @throws {ContainerJobFailed} When the job failed for good.
 * @throws {DeadlinePassed} When the deadline passed before a new job could open, or ingest ended the job at it.
 * @throws {Error} When preparation, persistence, progress or registration fails.
 */
export async function advanceAnalysisJob(
  execution: Execution, deadlineAt: number, position: number, outputs: () => Promise<readonly AnalysisOutput[]>, initial?: MiniToolPlanJobRequest,
  inputs?: () => Promise<MiniToolPlanJobRequest["inputs"]>,
): Promise<AnalysisJob> {
  const { context, record, params } = execution;
  const steps = await upstreamStepRepo.listSteps(context.taskId);
  let step = steps.find((entry) => entry.position === position);
  let request: MiniToolPlanJobRequest;
  if (step?.output.miniToolPlanJob !== undefined) {
    request = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
  } else {
    assertBeforeDeadline(deadlineAt);
    const planned = await outputs();
    const configuration = initial === undefined ? getMiniToolsConfig() : undefined;
    const containerClass = step?.endpoint ?? initial?.containerClass ?? configuration!.analyses[record.kind].container_class;
    const limits = initial?.limits ?? configuration!.plan_limits;
    if (step === undefined) {
      const prefix = steps.map(({ kind, endpoint, itemIndex }) => ({ kind, endpoint, itemIndex }));
      if (prefix.length !== position) throw new Error("Analysis steps require their complete original prefix");
      const stored = await upstreamStepRepo.ensureSteps(context.taskId, [...prefix,
        { kind: "container_job", endpoint: containerClass, itemIndex: position }]);
      step = stored.find((entry) => entry.position === position);
    }
    if (step === undefined || step.kind !== "container_job") throw new Error("Analysis has no original container step");
    assertBeforeDeadline(deadlineAt);
    const grants = await openContainerOutputs({
      projectId: context.projectId, actingUserId: context.userId, taskId: context.taskId, deadlineAt,
      outputs: planned.map((output) => ({ modality: output.modality, namePrefix: "ANALYSIS" })),
    });
    assertBeforeDeadline(deadlineAt);
    if (grants.length !== planned.length) throw new Error("Analysis outputs require their complete upload grants");
    request = miniToolPlanJobRequestSchema.parse({
      schemaVersion: 2, jobId: `task:${context.taskId}/chunk:${position}`, containerClass, deadlineAt, limits,
      inputs: inputs === undefined ? [{ inputId: record.binding.assetId, storageKey: params.sourceKey }] : await inputs(),
      outputs: planned.map((output, index) => ({ ...grants[index], outputIndex: output.outputIndex, recipe: output.recipe })),
    });
  }
  if (step.kind !== "container_job" || step.endpoint !== request.containerClass) throw new Error("Analysis plan differs from its original container step");
  const job = await advanceRegisteredMiniToolPlanJob({
    taskId: context.taskId, stepId: step.id, chunkIndex: position,
    chargeTo: record.kind === "people" ? "platform" : "user", request,
  });
  // A job ingest ended at the deadline is the analysis running out of time, as a deadline passed here is.
  if (job.report.state === "failed") throw job.report.reason === "expired" ? new DeadlinePassed() : new ContainerJobFailed(job.report.reason);
  return { step, job };
}

/**
 * Reuse an owned JSON value or read its canonical registered object. Reading a registered result starts no new work, so a
 * pickup after the deadline still reads it and hands it to the user (`planReadUntil`, as a run reads its finished jobs).
 * @param analysis - The original step and its registered outputs.
 * @param outputIndex - The original JSON output identity.
 * @returns The original JSON for subsequent owned content validation.
 * @throws {Error} When registration, reading or cache persistence fails.
 */
async function analysisJson(analysis: AnalysisJob, outputIndex: number): Promise<unknown> {
  const registered = analysis.job.assets.find((entry) => entry.outputIndex === outputIndex);
  if (registered === undefined) throw new Error("Analysis JSON has no canonical registered output");
  const key = `miniToolAnalysisJson:${outputIndex}`;
  if (Object.hasOwn(analysis.step.output, key)) {
    if (analysis.step.output[`miniToolAsset:${outputIndex}`] !== registered.asset.id) {
      throw new Error("Cached analysis JSON differs from its original registered output");
    }
    return analysis.step.output[key];
  }
  const read = await readMiniToolAnalysisJson(registered.asset.id, planReadUntil(analysis.job.request.deadlineAt));
  await upstreamStepRepo.recordInline(analysis.step.id, { [key]: read.json }, 0);
  return read.json;
}

/**
 * Read the full ledger the analysis froze (§93 D5, D4-7): bytes that fail the frozen receipt never recover in this run, so
 * the analysis ends as `source_ledger_invalid` (a new run freezes the repaired ledger); a transport failure keeps the retry.
 * Reading it starts no new work, so a pickup after the deadline still reads it (`planReadUntil`).
 * @param execution - The accepted analysis.
 * @param deadlineAt - The task deadline.
 * @returns The validated full ledger.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the bytes fail the receipt.
 * @throws {Error} When the read fails in transport or outlasts its bound.
 */
export async function frozenLedger(execution: Execution, deadlineAt: number): Promise<VideoPresentationLedger> {
  const { ledgerReceipts, presentationRef } = execution.params.analysis;
  try {
    return await readJobLedger(ledgerReceipts.source, planReadUntil(deadlineAt));
  } catch (error) {
    if (!(error instanceof FullLedgerInvalid)) throw error;
    logger.error({ err: error, ctx: { taskId: execution.context.taskId, toolInputId: presentationRef.source.toolInputId } }, "mini_tool_analysis_ledger_invalid");
    throw new UpstreamTaskFailed("container", "source_ledger_invalid");
  }
}

/**
 * The people recipe a stored people job carries (the anchor's entry and PNG target).
 * @param job - The people job.
 * @returns Its recipe.
 * @throws {Error} When the job is not a people job on an entry.
 */
function peopleRecipe(job: RegisteredMiniToolPlanJob): Extract<MiniToolPlanRecipe, { kind: "people"; entry: unknown }> {
  const recipe = job.request.outputs[0]?.recipe;
  if (recipe?.kind !== "people" || !("entry" in recipe)) throw new Error("People analysis requires its people recipe on the anchor entry");
  return recipe;
}

/**
 * Advance the accepted people or scene analysis through its original container steps, its recipes built from the frozen
 * full ledger with the D4 builders (§93 D5; design §7.17); scene cuts come back as presentation ordinals (§93 D5-8).
 * @param execution - The original SQL-owned execution identity, source and context.
 * @param deadlineAt - The task's unchanged computation deadline.
 * @returns The complete owned result after its registered dependencies are available.
 * @throws {UpstreamTaskFailed} With `source_ledger_invalid` when the frozen ledger fails its receipt.
 * @throws {Error} When an original step, artifact or analysis cannot be completed.
 */
export async function runMiniToolContainerAnalysis(
  execution: Execution, deadlineAt: number,
): Promise<Extract<MiniToolAnalysisResult, { kind: "people" | "scene_cuts" }>> {
  const record = miniToolAnalysisRecordSchema.parse(execution.record);
  const input = record.analysisInput;
  const inputId = record.binding.assetId;
  if (input.kind === "tracked_mask") throw new Error("Tracked masks require their original provider analysis executor");
  let ledger: Promise<VideoPresentationLedger> | undefined;
  /**
   * The frozen full ledger, read once and only when a recipe or placement needs it.
   * @returns It.
   * @throws {Error} When it cannot be read.
   */
  const frozen = (): Promise<VideoPresentationLedger> => (ledger ??= frozenLedger(execution, deadlineAt));
  if (input.kind === "scene_cuts") {
    const initial = await advanceAnalysisJob(execution, deadlineAt, 0, async () => [
      { outputIndex: 0, modality: "text", recipe: sceneCutsRecipeOf(await frozen(), input.range, inputId, input.profile) },
    ]);
    const observations = await analysisJson(initial, 0);
    let placement = initial.step.output[SCENE_PLACEMENT] as ScenePlacement | undefined;
    const fresh = placement === undefined;
    if (placement === undefined) {
      const recipe = initial.job.request.outputs[0]?.recipe;
      if (recipe?.kind !== "scene_cuts" || !("window" in recipe)) throw new Error("Scene analysis requires its scene_cuts recipe on entries");
      const full = await frozen();
      const cuts = (observations as { cuts?: { ordinal?: unknown }[] } | null)?.cuts;
      if (!Array.isArray(cuts)) throw new Error("Scene observations carry no cuts");
      placement = { placed: sceneCutsResultOf(full, recipe.window, cuts.map((cut) => Number((cut as { ordinal?: unknown } | null)?.ordinal))),
        clock: { frameCount: presentationFrameCount(full.plan.presentation), timescale: full.plan.presentation.timescale } };
    }
    const result = miniToolSceneAnalysis.assembleMiniToolSceneAnalysis(record, observations, placement.placed, placement.clock);
    if (fresh) await upstreamStepRepo.recordInline(initial.step.id, { [SCENE_PLACEMENT]: placement }, 0);
    return result;
  }
  const initial = await advanceAnalysisJob(execution, deadlineAt, 0, async () => [
    { outputIndex: 0, modality: "text", recipe: peopleRecipeOf(await frozen(), input.anchor, inputId, input.profile) },
  ]);
  const anchor = peopleRecipe(initial.job);
  const observations = miniToolPeopleAnalysis.readMiniToolDisplayPeople(record, await analysisJson(initial, 0), anchor.target);
  const groups = chunkVideoOutputs(observations.candidates, MINI_TOOL_JOB_MAX_OUTPUTS);
  const jobs: RegisteredMiniToolPlanJob[] = [];
  for (const [index, candidates] of groups.entries()) {
    // Each crop is the anchor's frame recipe on its entry (candidateCropRecipeOf), cropped in the display geometry.
    const outputs: AnalysisOutput[] = candidates.map((candidate) => ({
      outputIndex: candidate.detectionIndex, modality: "image", recipe: {
        kind: "frame", inputId, entry: anchor.entry, target: anchor.target,
        crop: { sourceWidth: observations.width, sourceHeight: observations.height, rect: candidate.pixelCrop },
      },
    }));
    const next = await advanceAnalysisJob(execution, initial.job.request.deadlineAt, index + 1, () => Promise.resolve(outputs), initial.job.request);
    jobs.push(next.job);
  }
  return miniToolPeopleAnalysis.assembleMiniToolPeopleAnalysis(record, execution.params.sourceKey, observations, jobs, anchor.entry);
}
