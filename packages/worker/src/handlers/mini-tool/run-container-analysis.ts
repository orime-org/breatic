// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { getMiniToolsConfig } from "@breatic/core";
import { miniToolPeopleAnalysis, miniToolSceneAnalysis, openContainerOutputs, upstreamStepRepo,
  type miniToolAnalysisService } from "@breatic/domain";
import { assertBeforeDeadline, MINI_TOOL_JOB_MAX_OUTPUTS, miniToolPlanJobRequestSchema,
  type MiniToolPlanJobRequest, type MiniToolPlanRecipe } from "@breatic/shared";
import { chunkVideoOutputs, miniToolAnalysisRecordSchema, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { advanceRegisteredMiniToolPlanJob, type RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { readMiniToolAnalysisJson } from "@worker/handlers/mini-tool/read-analysis-json.js";

/** SQL owns the original source, accepted inputs and notification context. */
type Execution = miniToolAnalysisService.MiniToolAnalysisExecution;
/** A stored task-owned descriptor retains its actual position and original endpoint. */
type Step = Awaited<ReturnType<typeof upstreamStepRepo.listSteps>>[number];
/** Each analysis recipe names its original output index and output modality. */
interface AnalysisOutput { outputIndex: number; modality: "text" | "image"; recipe: MiniToolPlanRecipe }
/** The original step supplies cached JSON while its job supplies live canonical rows. */
interface AnalysisJob { step: Step; job: RegisteredMiniToolPlanJob }

/**
 * Restore a saved plan or open one new original job within the unchanged deadline.
 * @param execution - The SQL-owned accepted analysis.
 * @param deadlineAt - The original computation deadline.
 * @param position - The stable step and container chunk position.
 * @param outputs - The complete ordered recipes for this chunk.
 * @param initial - The first job's frozen runtime policy for subsequent chunks.
 * @returns The original owning step and registered terminal job.
 * @throws {Error} When preparation, persistence, progress or registration fails.
 */
async function advanceAnalysisJob(
  execution: Execution, deadlineAt: number, position: number, outputs: readonly AnalysisOutput[], initial?: MiniToolPlanJobRequest,
): Promise<AnalysisJob> {
  const { context, record, params } = execution;
  const steps = await upstreamStepRepo.listSteps(context.taskId);
  let step = steps.find((entry) => entry.position === position);
  let request: MiniToolPlanJobRequest;
  if (step?.output.miniToolPlanJob !== undefined) {
    request = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
  } else {
    assertBeforeDeadline(deadlineAt);
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
      outputs: outputs.map((output) => ({ modality: output.modality, namePrefix: "ANALYSIS" })),
    });
    assertBeforeDeadline(deadlineAt);
    if (grants.length !== outputs.length) throw new Error("Analysis outputs require their complete upload grants");
    request = miniToolPlanJobRequestSchema.parse({
      schemaVersion: 2, jobId: `task:${context.taskId}/chunk:${position}`, containerClass, deadlineAt, limits,
      inputs: [{ inputId: record.binding.assetId, storageKey: params.sourceKey }],
      outputs: outputs.map((output, index) => ({ ...grants[index], outputIndex: output.outputIndex, recipe: output.recipe })),
    });
  }
  if (step.kind !== "container_job" || step.endpoint !== request.containerClass) throw new Error("Analysis plan differs from its original container step");
  const job = await advanceRegisteredMiniToolPlanJob({
    taskId: context.taskId, stepId: step.id, chunkIndex: position,
    chargeTo: record.kind === "people" ? "platform" : "user", request,
  });
  if (job.report.state === "failed") throw new ContainerJobFailed(job.report.reason);
  return { step, job };
}

/**
 * Reuse an owned JSON value or read its canonical registered object within D.
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
  assertBeforeDeadline(analysis.job.request.deadlineAt);
  const read = await readMiniToolAnalysisJson(registered.asset.id, analysis.job.request.deadlineAt);
  await upstreamStepRepo.recordInline(analysis.step.id, { [key]: read.json }, 0);
  return read.json;
}

/**
 * Advance the accepted people or scene analysis through its original container steps.
 * @param execution - The original SQL-owned execution identity, source and context.
 * @param deadlineAt - The task's unchanged computation deadline.
 * @returns The complete owned result after its registered dependencies are available.
 * @throws {Error} When an original step, artifact or analysis cannot be completed.
 */
export async function runMiniToolContainerAnalysis(
  execution: Execution, deadlineAt: number,
): Promise<Extract<MiniToolAnalysisResult, { kind: "people" | "scene_cuts" }>> {
  const record = miniToolAnalysisRecordSchema.parse(execution.record);
  const input = record.analysisInput;
  const inputId = record.binding.assetId;
  if (input.kind === "tracked_mask") throw new Error("Tracked masks require their original provider analysis executor");
  if (input.kind === "scene_cuts") {
    const initial = await advanceAnalysisJob(execution, deadlineAt, 0, [
      { outputIndex: 0, modality: "text", recipe: { kind: "inspect_video", inputId } },
      { outputIndex: 1, modality: "text", recipe: { kind: "scene_cuts", inputId, range: input.range, profile: input.profile } },
    ]);
    return miniToolSceneAnalysis.assembleMiniToolSceneAnalysis(record, await analysisJson(initial, 0), await analysisJson(initial, 1));
  }
  const initial = await advanceAnalysisJob(execution, deadlineAt, 0, [
    { outputIndex: 0, modality: "text", recipe: { kind: "people", inputId, anchor: input.anchor, profile: input.profile, orientation: "display" } },
  ]);
  const observations = miniToolPeopleAnalysis.readMiniToolDisplayPeople(record, await analysisJson(initial, 0));
  const groups = chunkVideoOutputs(observations.candidates, MINI_TOOL_JOB_MAX_OUTPUTS);
  const jobs: RegisteredMiniToolPlanJob[] = [];
  for (const [index, candidates] of groups.entries()) {
    const outputs: AnalysisOutput[] = candidates.map((candidate) => ({
      outputIndex: candidate.detectionIndex, modality: "image", recipe: {
        kind: "frame", inputId, frameIndex: input.anchor.frameIndex, orientation: "display",
        crop: { sourceWidth: observations.width, sourceHeight: observations.height, rect: candidate.pixelCrop },
      },
    }));
    const next = await advanceAnalysisJob(execution, initial.job.request.deadlineAt, index + 1, outputs, initial.job.request);
    jobs.push(next.job);
  }
  return miniToolPeopleAnalysis.assembleMiniToolPeopleAnalysis(record, execution.params.sourceKey, observations, jobs);
}
