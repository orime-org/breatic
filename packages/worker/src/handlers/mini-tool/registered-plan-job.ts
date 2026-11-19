// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { assetRepo, ingestReportService, miniToolStepStateSchema, openMiniToolPlanJob, recordMiniToolStepResult, upstreamStepRepo,
  type OpenMiniToolPlanJobInput } from "@breatic/domain";
import { readMiniToolPlanJobReport, type StudioAssetEntity, type MiniToolPlanJobRequest } from "@breatic/shared";
import { miniToolAnalysisArtifactSchema } from "@breatic/shared/mini-tools";
import { advanceMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import type { EndedMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";

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
 * Advance the original job and register its actual written output set.
 * @param input - The task-owned candidate plan and original expense policy.
 * @param options - What the job consumed.
 * @param options.retire - Intermediate keys (a stitch's chunks) retired with a done result, never before (§7.15, §93 D5-10).
 * @returns The persisted report and canonical assets, including a failed job's subset.
 * @throws {Error} When original-plan validation, progress, persistence or registration fails.
 */
export async function advanceRegisteredMiniToolPlanJob(input: OpenMiniToolPlanJobInput, options: { retire?: readonly string[] } = {}): Promise<RegisteredMiniToolPlanJob> {
  const { request, consumption } = await openMiniToolPlanJob(input);
  let step = (await upstreamStepRepo.listSteps(input.taskId)).find((item) => item.id === input.stepId);
  if (step === undefined) throw new Error("Planned job lost its owning step");
  const state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
  let report: EndedMiniToolPlanJob;
  if (state?.result !== null && state?.result !== undefined) {
    report = terminalReport(request, state.result.result);
  } else {
    report = terminalReport(request, await advanceMiniToolPlanJob(request));
    step = await recordMiniToolStepResult({
      taskId: input.taskId, stepId: input.stepId, identity: consumption.identity, outcome: report.state, result: report,
      ...(report.state === "failed" ? { error: { code: report.reason } } : {}),
      ...(report.state === "done" && options.retire !== undefined && options.retire.length > 0 ? { presentation: { retire: [...options.retire] } } : {}),
    }, { kind: "container_job", parse: (value) => terminalReport(request, value) });
  }
  const assets: RegisteredMiniToolPlanJob["assets"] = [];
  for (const declared of request.outputs) {
    const measured = report.outputs.find((output) => output.outputIndex === declared.outputIndex);
    if (measured === undefined) continue;
    const cacheKey = `miniToolAsset:${declared.outputIndex}`;
    let assetId: string;
    if (step.output[cacheKey] === undefined) {
      const outcome = await ingestReportService.applyIngestReport({ ...measured, outcome: "completed" });
      noteSideEffects(outcome, { taskId: input.taskId, stepId: input.stepId, key: measured.storageKey });
      if (outcome.status !== "registered" && outcome.status !== "already_registered") {
        throw new Error(`Planned output registration failed: ${outcome.status}`);
      }
      assetId = miniToolAnalysisArtifactSchema.shape.assetId.parse(outcome.assetId);
      await upstreamStepRepo.recordInline(input.stepId, { [cacheKey]: assetId }, 0);
      step = { ...step, output: { ...step.output, [cacheKey]: assetId } };
    } else {
      assetId = miniToolAnalysisArtifactSchema.shape.assetId.parse(step.output[cacheKey]);
    }
    const asset = await assetRepo.findById(assetId);
    if (asset === null || asset.deletedAt !== null) throw new Error("Registered planned output is unavailable");
    assets.push({ outputIndex: declared.outputIndex, asset });
  }
  return { request, report, assets };
}
