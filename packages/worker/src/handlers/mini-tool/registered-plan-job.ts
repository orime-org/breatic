// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { assetRepo, ingestReportService, miniToolStepStateSchema, openMiniToolPlanJob, recordMiniToolStepResult, upstreamStepRepo,
  type OpenMiniToolPlanJobInput } from "@breatic/domain";
import { miniToolPlanJobRequestSchema, readMiniToolPlanJobReport, type StudioAssetEntity, type MiniToolPlanJobRequest } from "@breatic/shared";
import { z } from "zod";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import type { EndedMiniToolPlanJob, Unopened } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";

/** Why every report of a staged output is refused whatever it is (frames-split §7.19). */
export type MiniToolOutputRefusal = "over_cap" | "empty";
/** A job whose terminal report is kept on its step, unregistered. */
export interface StagedMiniToolPlanJob {
  request: MiniToolPlanJobRequest;
  report: EndedMiniToolPlanJob;
  /** The refusal of a done report's output: the job's final failure, never retried. */
  refused: MiniToolOutputRefusal | null;
}
/** Actual registered rows retain their original global output indices. */
export interface RegisteredMiniToolPlanJob {
  request: MiniToolPlanJobRequest;
  report: EndedMiniToolPlanJob;
  assets: { outputIndex: number; asset: StudioAssetEntity }[];
}

/**
 * Require an actual terminal report bound to the original declared output set.
 * @param request - The complete first committed request.
 * @param value - Its received or previously stored terminal report.
 * @returns Validated actual usage and indexed output measurements.
 * @throws {Error} When the report is pending or differs from the original plan.
 */
function terminalReport(request: MiniToolPlanJobRequest, value: unknown): EndedMiniToolPlanJob {
  const report = readMiniToolPlanJobReport(request, value);
  if (report.state === "done" || report.state === "failed") return report;
  throw new Error("Planned job has no terminal report");
}

/**
 * The owning step of a job, as stored now.
 * @param taskId - The run.
 * @param stepId - The step.
 * @returns The step.
 * @throws {Error} When the step is gone.
 */
async function ownedStep(taskId: string, stepId: string): Promise<upstreamStepRepo.UpstreamStep> {
  const step = (await upstreamStepRepo.listSteps(taskId)).find((item) => item.id === stepId);
  if (step === undefined) throw new Error("Planned job lost its owning step");
  return step;
}

/**
 * Advance the original job and keep its terminal report on its step (frames-split §7.19): nothing is registered.
 * A report with a written output over the upload cap or empty is the job's final failure, recorded as failed, so its chunks
 * are not retired.
 * @param input - The task-owned candidate plan and original expense policy.
 * @param options - What the job consumed.
 * @param options.retire - Intermediate keys (a stitch's chunks) retired with a done result, never before (§7.15, §93 D5-10).
 * @returns The persisted report and its refusal, if any.
 * @throws {Error} When original-plan validation, progress or persistence fails.
 */
export async function advanceStagedMiniToolPlanJob(input: OpenMiniToolPlanJobInput, options?: { retire?: readonly string[] }): Promise<StagedMiniToolPlanJob>;
/**
 * Advance the original job and keep its terminal report on its step, submitting a job ingest holds no record of only when
 * opening is allowed (frames-split §7.19).
 * @param input - The task-owned candidate plan and original expense policy.
 * @param options - What the job consumed and whether it may be submitted.
 * @param options.retire - Intermediate keys (a stitch's chunks) retired with a done result, never before (§7.15, §93 D5-10).
 * @param options.open - Whether a job ingest holds no record of may be submitted now.
 * @returns The persisted report and its refusal, or `UNOPENED` when the job is not at ingest and may not be submitted.
 * @throws {Error} When original-plan validation, progress or persistence fails.
 */
export async function advanceStagedMiniToolPlanJob(input: OpenMiniToolPlanJobInput, options: { retire?: readonly string[]; open: boolean }): Promise<StagedMiniToolPlanJob | Unopened>;
/**
 * The implementation of both forms.
 * @param input - The task-owned candidate plan and original expense policy.
 * @param options - What the job consumed and whether it may be submitted.
 * @param options.retire - Intermediate keys retired with a done result, never before.
 * @param options.open - Whether a job ingest holds no record of may be submitted now; true when absent.
 * @returns The persisted report and its refusal, or `UNOPENED`.
 * @throws {Error} When original-plan validation, progress or persistence fails.
 */
export async function advanceStagedMiniToolPlanJob(input: OpenMiniToolPlanJobInput, options: { retire?: readonly string[]; open?: boolean } = {}): Promise<StagedMiniToolPlanJob | Unopened> {
  const { request, consumption } = await openMiniToolPlanJob(input);
  const step = await ownedStep(input.taskId, input.stepId);
  const state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
  if (state?.result !== null && state?.result !== undefined) {
    const code = state.result.error?.code;
    return { request, report: terminalReport(request, state.result.result), refused: code === "over_cap" || code === "empty" ? code : null };
  }
  const advanced = options.open === false ? await advanceMiniToolPlanJob(request, false) : await advanceMiniToolPlanJob(request);
  if ("unopened" in advanced) return advanced;
  const report = terminalReport(request, advanced);
  // A failed attempt's written outputs are staged too (the next attempt carries only the rest), so every report is checked.
  const refused = report.outputs.map((output) => ingestReportService.ingestReportRefusal(output.sizeBytes)).find((reason) => reason !== null) ?? null;
  await recordMiniToolStepResult({
    taskId: input.taskId, stepId: input.stepId, identity: consumption.identity, outcome: refused === null ? report.state : "failed", result: report,
    ...(refused !== null ? { error: { code: refused } } : report.state === "failed" ? { error: { code: report.reason } } : {}),
    ...(refused === null && report.state === "done" && options.retire !== undefined && options.retire.length > 0 ? { presentation: { retire: [...options.retire] } } : {}),
  }, { kind: "container_job", parse: (value) => terminalReport(request, value) });
  return { request, report, refused };
}

/**
 * Register every output a staged step's terminal report measured (frames-split §7.19), each once: a
 * registration is cached on the step, so registering again reads it back.
 * @param staged - The step.
 * @param staged.taskId - Its run.
 * @param staged.stepId - The step.
 * @param options - A video output's presentation deadline, counted from this registration; omitted for container analysis.
 * @param options.deadlineAt - The deadline.
 * @returns Each registered output's row, in declared order.
 * @throws {Error} When the step has no terminal report, or a registration is refused or unavailable.
 */
export async function registerMiniToolPlanJobOutputs(staged: { taskId: string; stepId: string }, options?: { deadlineAt: number }): Promise<RegisteredMiniToolPlanJob["assets"]> {
  let step = await ownedStep(staged.taskId, staged.stepId);
  const request = miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
  const state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
  if (state?.result === null || state?.result === undefined) throw new Error("Planned job has no staged report to register");
  const report = terminalReport(request, state.result.result);
  const assets: RegisteredMiniToolPlanJob["assets"] = [];
  for (const declared of request.outputs) {
    const measured = report.outputs.find((output) => output.outputIndex === declared.outputIndex);
    if (measured === undefined) continue;
    const cacheKey = `miniToolAsset:${declared.outputIndex}`;
    let assetId: string;
    if (step.output[cacheKey] === undefined) {
      const completed = { ...measured, outcome: "completed" as const };
      const outcome = options !== undefined && measured.contentType.startsWith("video/")
        ? await ingestReportService.applyIngestReport(completed, { presentation: { deadlineAt: options.deadlineAt } })
        : await ingestReportService.applyIngestReport(completed);
      noteSideEffects(outcome, { taskId: staged.taskId, stepId: staged.stepId, key: measured.storageKey });
      if (outcome.status !== "registered" && outcome.status !== "already_registered") {
        throw new Error(`Planned output registration failed: ${outcome.status}`);
      }
      assetId = z.uuid().parse(outcome.assetId);
      await upstreamStepRepo.recordInline(staged.stepId, { [cacheKey]: assetId }, 0);
      step = { ...step, output: { ...step.output, [cacheKey]: assetId } };
    } else {
      assetId = z.uuid().parse(step.output[cacheKey]);
    }
    const asset = await assetRepo.findById(assetId);
    if (asset === null || asset.deletedAt !== null) throw new Error("Registered planned output is unavailable");
    assets.push({ outputIndex: declared.outputIndex, asset });
  }
  return assets;
}

/**
 * Advance the original job and register its actual written output set at once: a container analysis, whose result is its
 * own and not part of a video tool run (frames-split §7.19).
 * @param input - The task-owned candidate plan and original expense policy.
 * @param options - What the job consumed.
 * @param options.retire - Intermediate keys retired with a done result, never before.
 * @returns The persisted report and canonical assets, including a failed job's subset.
 * @throws {Error} When original-plan validation, progress, persistence or registration fails.
 */
export async function advanceRegisteredMiniToolPlanJob(input: OpenMiniToolPlanJobInput, options: { retire?: readonly string[] } = {}): Promise<RegisteredMiniToolPlanJob> {
  const { request, report } = await advanceStagedMiniToolPlanJob(input, options);
  return { request, report, assets: await registerMiniToolPlanJobOutputs({ taskId: input.taskId, stepId: input.stepId }) };
}
