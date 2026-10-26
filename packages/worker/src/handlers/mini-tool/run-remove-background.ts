// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getRawEnvVar } from "@breatic/core";
import {
  assetRepo, beginMiniToolStepAttempt, getFullModelConfig, miniToolStepStateSchema,
  readMiniToolExecutionPlan, recordMiniToolStepIdentity, recordMiniToolStepResult, upstreamStepRepo,
} from "@breatic/domain";
import type { StudioAssetEntity } from "@breatic/shared";
import { storeFromUrl } from "@worker/handlers/backend-upload.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";
import { runPrediction } from "@worker/providers/wavespeed.js";

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
 * @returns The actual registered winner and its live cover.
 * @throws {Error} When the persisted lane, planning, provider or canonical receipt cannot advance.
 */
export async function runMiniToolRemoveBackground(
  taskId: string,
  deadlineAt: number,
  retryStarting: boolean,
): Promise<{ asset: StudioAssetEntity; cover: StudioAssetEntity | null }> {
  const { task, execution } = await readMiniToolExecutionPlan(taskId);
  const [owned] = await upstreamStepRepo.ensureSteps(task.id, [{ kind: "generate", endpoint: execution.provider.model_id, itemIndex: 0 }]);
  if (owned === undefined || owned.kind !== "generate" || owned.endpoint !== execution.provider.model_id || owned.itemIndex !== 0) {
    throw new Error("Video removal lost its original provider step");
  }
  let step = owned;
  if (step.output[RECEIPT_KEY] !== undefined) return registeredAsset(assetIdentitySchema.parse(step.output[RECEIPT_KEY]));
  let state = step.output.miniToolStep === undefined ? null : miniToolStepStateSchema.parse(step.output.miniToolStep);
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
        requestBody: { ...execution.body }, deadlineAt: originalDeadline, chargeTo: "user",
      });
      if (!prepared.shouldSubmit || prepared.attempt === null) throw new Error("Provider submit intent requires reconciliation");
      attemptId = prepared.attempt.attemptId;
      step = prepared.step;
      state = miniToolStepStateSchema.parse(step.output.miniToolStep);
      originalDeadline = state.deadlineAt ?? originalDeadline;
    }
    const prediction = await runPrediction({ baseUrl: connection.base_url, apiKey }, execution.provider.model_id, execution.body, {
      storedTaskId: step.predictionId, externalTaskId: step.id, retryStarting, deadlineAt: originalDeadline,
      persistTaskId: async (predictionId): Promise<void> => {
        if (attemptId === null) throw new Error("Existing provider prediction cannot receive a replacement receipt");
        const receipt = await recordMiniToolStepIdentity({ taskId: task.id, stepId: step.id, attemptId, predictionId });
        if (receipt.conflict) throw new Error("Provider receipt conflicts with its original prediction");
      },
    });
    step = await recordMiniToolStepResult({
      taskId: task.id, stepId: step.id,
      identity: { kind: "provider", provider: "wavespeed", predictionId: prediction.taskId },
      outcome: "done", result: prediction.outputs,
    }, { kind: "generate", parse: (value) => ({ providerURL: providerOutputsSchema.parse(value)[0] }) });
    state = miniToolStepStateSchema.parse(step.output.miniToolStep);
  }
  if (state?.result?.outcome !== "done") throw new Error("Video removal has no completed provider result");
  const result = operationResultSchema.parse(state.result.result);
  const stored = await storeFromUrl(result.providerURL, {
    projectId: execution.projectId, actingUserId: task.userId, generationTaskId: task.id,
    assetSource: "ai", taskType: "video", ext: ".webm", contentType: "video/webm",
    deadlineAt: originalDeadline, knownAlpha: true,
  });
  noteSideEffects(stored, { taskId: task.id, stepId: step.id });
  const assetId = assetIdentitySchema.parse(stored.assetId);
  await upstreamStepRepo.recordInline(step.id, { [RECEIPT_KEY]: assetId }, 0);
  return registeredAsset(assetId);
}
