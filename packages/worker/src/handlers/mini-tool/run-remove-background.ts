// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getRawEnvVar, getStorageAdapter, logger } from "@breatic/core";
import {
  assetRepo, beginMiniToolStepAttempt, type MiniToolStepJson, failMiniToolStep, getFullModelConfig, miniToolStepStateSchema,
  readMiniToolExecutionPlan, recordMiniToolStepIdentity, recordMiniToolStepResult, upstreamStepRepo,
} from "@breatic/domain";
import { assertBeforeDeadline, type StudioAssetEntity } from "@breatic/shared";
import { storeFromUrl } from "@worker/handlers/backend-upload.js";
import { planReadUntil } from "@worker/handlers/mini-tool/advance-plan-job.js";
import { appendStep, prepareModelInput } from "@worker/handlers/mini-tool/prepare-model-input.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";
import { runPrediction } from "@worker/providers/wavespeed.js";
import { UpstreamTaskFailed } from "@worker/providers/http.js";
import { StillRunning } from "@worker/handlers/still-running.js";

const providerOutputsSchema = z.tuple([z.string().url()]);
const operationResultSchema = z.strictObject({ providerURL: z.string().url() });
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
 * Resume one SQL-owned video removal and recover its registered canonical rows.
 * @param taskId - The original accepted planned task, never a replacement job body.
 * @param deadlineAt - Its original outer task deadline; an existing step keeps its stored deadline.
 * @param retryStarting - The existing pickup retry fact passed to the provider transport.
 * @param onProviderReturned - The application records this pickup's durable return boundary before later IO.
 * @returns The actual registered winner and its live cover.
 * @throws {DeadlinePassed} When the provider step would be appended after the deadline.
 * @throws {Error} When the persisted lane, planning, provider or canonical receipt cannot advance.
 */
export async function runMiniToolRemoveBackground(
  taskId: string,
  deadlineAt: number,
  retryStarting: boolean,
  onProviderReturned?: (stepId: string) => void,
): Promise<{ asset: StudioAssetEntity; cover: StudioAssetEntity | null }> {
  const { task, execution } = await readMiniToolExecutionPlan(taskId);
  if (execution.tool !== "video.remove-bg") throw new Error("Planned container execution requires its container runner");
  // The provider body takes the prepared model input; once a submit intent exists its stored body is the one sent.
  const found = (await upstreamStepRepo.listSteps(task.id)).find((candidate) => candidate.kind === "generate");
  let body: Record<string, MiniToolStepJson> | null = null;
  if (found?.output.miniToolStep === undefined) {
    // A failed-output retry names the original run's preparation in its body, or its own when the original never finished preparing.
    const prepared = await prepareModelInput(execution, deadlineAt, execution.body.video.job.slice(0, -":prep:0".length));
    body = { ...execution.body, video: (await getStorageAdapter()).publicUrl(prepared) };
  }
  // A call opened after the deadline is never submitted, so no step is appended for it.
  if (found === undefined) assertBeforeDeadline(deadlineAt);
  const owned = found ?? await appendStep(task.id, { kind: "generate", endpoint: execution.provider.model_id, itemIndex: 0 });
  if (owned.kind !== "generate" || owned.endpoint !== execution.provider.model_id || owned.itemIndex !== 0) {
    throw new Error("Video removal lost its original provider step");
  }
  let step = owned;
  if (step.output[RECEIPT_KEY] !== undefined) {
    if (step.output.miniToolStep !== undefined && miniToolStepStateSchema.parse(step.output.miniToolStep).result?.outcome === "done") onProviderReturned?.(step.id);
    return registeredAsset(assetIdentitySchema.parse(step.output[RECEIPT_KEY]));
  }
  let state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
  if (step.status === "failed" && state?.result?.outcome !== "done") {
    const message = state?.error?.message;
    if (typeof message !== "string") throw new Error("Original provider failure has no stored reason");
    onProviderReturned?.(step.id);
    throw new UpstreamTaskFailed("wavespeed", message);
  }
  let originalDeadline = state?.deadlineAt ?? deadlineAt;
  if (state === null || state.result === null) {
    const connection = getFullModelConfig("video").providers.wavespeed;
    const apiKey = getRawEnvVar(connection?.api_key_env ?? "");
    if (!connection?.base_url || !apiKey) throw new Error("Original WaveSpeed execution connection is unavailable");
    let attemptId: string | null = null;
    if (step.predictionId === null) {
      const held = state?.attempts.at(-1);
      const prepared = await beginMiniToolStepAttempt({
        taskId: task.id, stepId: step.id,
        attemptId: !retryStarting && held?.resolution.kind === "unresolved" ? held.attemptId : randomUUID(),
        requestBody: { ...(state?.requestBody ?? body) }, deadlineAt: originalDeadline, chargeTo: "user",
      });
      if (!prepared.shouldSubmit || prepared.attempt === null) throw new Error("Provider submit intent requires reconciliation");
      attemptId = prepared.attempt.attemptId;
      step = prepared.step;
      state = miniToolStepStateSchema.parse(step.output.miniToolStep);
      originalDeadline = state.deadlineAt ?? originalDeadline;
    }
    let prediction: Awaited<ReturnType<typeof runPrediction>>;
    try {
      const sent = state?.requestBody ?? body;
      if (sent === null) throw new Error("Video removal has no prepared provider body");
      prediction = await runPrediction({ baseUrl: connection.base_url, apiKey }, execution.provider.model_id, sent, {
        storedTaskId: step.predictionId, externalTaskId: step.id, retryStarting, deadlineAt: originalDeadline,
        persistTaskId: async (predictionId): Promise<void> => {
          if (attemptId === null) throw new Error("Existing provider prediction cannot receive a replacement receipt");
          const receipt = await recordMiniToolStepIdentity({ taskId: task.id, stepId: step.id, attemptId, predictionId });
          if (receipt.conflict) throw new Error("Provider receipt conflicts with its original prediction");
        },
      });
    } catch (err) {
      if (!(err instanceof StillRunning)) logger.error({ err, ctx: { taskId: task.id, stepId: step.id } }, "mini_tool_remove_background_provider_failed");
      if (err instanceof UpstreamTaskFailed) {
        await failMiniToolStep({ taskId: task.id, stepId: step.id, error: { message: err.upstreamError } });
        onProviderReturned?.(step.id);
      }
      throw err;
    }
    step = await recordMiniToolStepResult({
      taskId: task.id, stepId: step.id,
      identity: { kind: "provider", provider: "wavespeed", predictionId: prediction.taskId },
      outcome: "done", result: prediction.outputs,
    }, { kind: "generate", parse: (value) => ({ providerURL: providerOutputsSchema.parse(value)[0] }) });
    state = miniToolStepStateSchema.parse(step.output.miniToolStep);
  }
  if (state?.result?.outcome !== "done") throw new Error("Video removal has no completed provider result");
  onProviderReturned?.(step.id);
  const result = operationResultSchema.parse(state.result.result);
  // Storing a finished prediction starts no new provider work, so a pickup after the deadline still stores it (`planReadUntil`).
  const stored = await storeFromUrl(result.providerURL, {
    projectId: execution.projectId, actingUserId: task.userId, generationTaskId: task.id,
    assetSource: "ai", taskType: "video", ext: ".webm", contentType: "video/webm",
    deadlineAt: planReadUntil(originalDeadline), knownAlpha: true,
  });
  noteSideEffects(stored, { taskId: task.id, stepId: step.id });
  const assetId = assetIdentitySchema.parse(stored.assetId);
  await upstreamStepRepo.recordInline(step.id, { [RECEIPT_KEY]: assetId }, 0);
  return registeredAsset(assetId);
}
