// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { getStorageAdapter } from "@breatic/core";
import { assetRepo, readMiniToolExecutionPlan, upstreamStepRepo } from "@breatic/domain";
import { assertBeforeDeadline, type StudioAssetEntity } from "@breatic/shared";
import { storeFromUrl } from "@worker/handlers/backend-upload.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { appendStep, prepareModelInput } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";
import { modelStepCategory, runModelStep } from "@worker/handlers/mini-tool/model-run-steps.js";
import { MiniToolStepFailed } from "@worker/handlers/mini-tool/step-failed.js";

const assetIdentitySchema = z.string().uuid();
const RECEIPT_KEY = "miniToolAsset:0";

/**
 * Resolve a canonical receipt through the registered winner that owns its metadata.
 * @param assetId - The durable registered asset identity.
 * @returns The live winner and its registered cover.
 * @throws {Error} When the receipt's registered winner is unavailable.
 */
async function registeredAsset(assetId: string): Promise<{ asset: StudioAssetEntity; cover: StudioAssetEntity | null }> {
  const asset = await assetRepo.findById(assetId);
  if (asset === null || asset.deletedAt !== null || asset.kind !== "video") throw new Error("Registered video removal output is unavailable");
  return { asset, cover: await assetRepo.findCoverOf(asset.id) };
}

/**
 * Resume one SQL-owned video removal and recover its registered canonical rows: one model step run through its provider
 * ticket (inner#1306 execution design §11.2, §11.5), then the returned link stored as the run's asset.
 * @param taskId - The original accepted planned task, never a replacement job body.
 * @param deadlineAt - Its original outer task deadline.
 * @param _retryStarting - Whether this pickup is a queue retry; the step's ticket carries what a retry needs.
 * @param onProviderReturned - The application records this pickup's durable return boundary before later IO.
 * @returns The actual registered winner and its live cover.
 * @throws {DeadlinePassed} When the model step would be appended after the deadline.
 * @throws {MiniToolStepFailed} When the model step failed for good.
 * @throws {StillRunning} While the preparation or the model runs.
 * @throws {Error} When the persisted lane, planning or canonical receipt cannot advance.
 */
export async function runMiniToolRemoveBackground(
  taskId: string,
  deadlineAt: number,
  _retryStarting: boolean,
  onProviderReturned?: (stepId: string) => void,
): Promise<{ asset: StudioAssetEntity; cover: StudioAssetEntity | null }> {
  const { task, execution } = await readMiniToolExecutionPlan(taskId);
  if (execution.tool !== "video.remove-bg") throw new Error("Planned container execution requires its container runner");
  const found = (await upstreamStepRepo.listSteps(task.id)).find((candidate) => candidate.kind === "generate");
  // A call opened after the deadline is never sent, so no step is appended for it.
  if (found === undefined) assertBeforeDeadline(deadlineAt);
  const step = found ?? await appendStep(task.id, { kind: "generate", endpoint: execution.model, itemIndex: 0 });
  if (step.kind !== "generate" || step.endpoint !== execution.model || step.itemIndex !== 0) throw new Error("Video removal lost its original model step");
  if (step.output[RECEIPT_KEY] !== undefined) {
    onProviderReturned?.(step.id);
    return registeredAsset(assetIdentitySchema.parse(step.output[RECEIPT_KEY]));
  }
  if (step.status === "failed") {
    onProviderReturned?.(step.id);
    const ended = step.output.modelStepError as { message?: string; category?: string } | undefined;
    throw new MiniToolStepFailed(ended?.message ?? ended?.category ?? "failed");
  }
  const answered = await runModelStep(task.id, step, {
    model: execution.model,
    // The model reads the prepared input; a failed-output retry names the original run's preparation in its body.
    input: async () => {
      const prepared = await prepareModelInput(execution, deadlineAt, execution.body.video.job.slice(0, -":prep:0".length));
      return { prompt: "", params: { ...execution.body, video: (await getStorageAdapter()).publicUrl(prepared) } };
    },
    category: (error) => modelStepCategory(error, undefined),
  }, deadlineAt, "remove_background");
  onProviderReturned?.(step.id);
  if ("failed" in answered) throw new MiniToolStepFailed(answered.failed);
  // Storing a finished prediction starts no new upstream work, so a pickup after the deadline still stores it (`planReadUntil`).
  const stored = await storeFromUrl(answered.link, {
    projectId: execution.projectId, actingUserId: task.userId, generationTaskId: task.id,
    assetSource: "ai", taskType: "video", ext: ".webm", contentType: "video/webm",
    deadlineAt: planReadUntil(deadlineAt), knownAlpha: true,
  });
  noteSideEffects(stored, { taskId: task.id, stepId: step.id });
  const assetId = assetIdentitySchema.parse(stored.assetId);
  await upstreamStepRepo.recordInline(step.id, { [RECEIPT_KEY]: assetId }, 0);
  return registeredAsset(assetId);
}
