// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * WaveSpeed transport for ASR transcription (Whisper).
 *
 * Submits audio to WaveSpeed Whisper API and polls for transcription
 * result. Returns `{ text, cost }`.
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import type { AnyUnderstandFamily } from "@worker/providers/understand/models/types.js";
import { isAsrFamily } from "@worker/providers/understand/models/types.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
  extractNested,
  queryBilling,
} from "@worker/providers/http.js";

/**
 * Transcribe audio via WaveSpeed Whisper API.
 *
 * Uses submit + poll pattern. The shared `requestWithRetry` handles
 * 429 exponential backoff. After completion, queries WaveSpeed billing
 * for actual cost.
 * @param resolved - Resolved model with WaveSpeed connection details
 * @param family - Model family module with `buildRequest()`
 * @param prompt - Unused for transcription (guidance prompt passed via params)
 * @param params - Must include `audio` URL
 * @returns Object with `text` (transcription) and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  resolved: ResolvedModel,
  family: AnyUnderstandFamily,
  prompt: string,
  params: Record<string, unknown>,
): Promise<{ text: string; cost: number }> {
  if (!isAsrFamily(family)) {
    throw new Error(
      `WaveSpeed transport requires an ASR model family with buildRequest(), ` +
      `but got a family without it for model '${resolved.modelName}'`,
    );
  }

  const [_prompt, apiParams] = await family.buildRequest(
    prompt,
    resolved.modelName,
    params,
  );

  const headers = bearerHeaders(resolved.apiKey);
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  const data = await requestWithRetry(
    submitUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify(apiParams),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "wavespeed",
  );

  // Check for immediate result
  const outputs = extractNested(data, ["data", "outputs"]);
  const taskId = extractNested(data, ["data", "id"]) as string | undefined;

  if (outputs) {
    const text = typeof outputs === "string" ? outputs : String(outputs);
    const cost = taskId ? await queryBilling(resolved, taskId) : 0;
    return { text, cost };
  }

  if (!taskId) {
    throw new Error("No task ID or outputs in WaveSpeed response");
  }

  // Poll for completion
  const result = await pollUntilDone(
    `${resolved.baseUrl}/predictions/${taskId}/result`,
    {
      headers,
      statusPath: ["data", "status"],
      successStatuses: new Set(["completed"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["data", "error"],
      interval: 2000,
      maxWait: 300_000,
      provider: "wavespeed",
    },
  );

  const resultOutputs = extractNested(result, ["data", "outputs"]);
  if (!resultOutputs) {
    throw new Error("No output after WaveSpeed polling");
  }

  const text = typeof resultOutputs === "string" ? resultOutputs : String(resultOutputs);
  const cost = await queryBilling(resolved, taskId);
  return { text, cost };
}
