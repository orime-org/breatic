// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * fal.ai audio transport -- async submit + poll.
 *
 * Handles fal.ai-hosted audio models (e.g. ElevenLabs SFX V2 on fal).
 * Uses fal's queue API: submit -> poll status -> fetch result URL.
 *
 * API reference: https://fal.ai/docs/model-apis/model-endpoints/queue
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import {
  requestWithRetry,
  pollUntilDone,
} from "@worker/providers/http.js";

/**
 * Build fal.ai authorization headers.
 * @param apiKey - fal.ai API key
 * @returns Headers dict with Key auth and JSON content type
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Submit an audio generation task to fal.ai and poll for result.
 * @param _prompt - Audio description prompt (embedded in params)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (prompt, duration_seconds, prompt_influence, loop)
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const headers = authHeaders(resolved.apiKey);

  // Build fal.ai request -- wrap params in "input" envelope
  // Map our param names to fal's expected names
  const falInput: Record<string, unknown> = {};
  if (params.prompt) {
    falInput.text = params.prompt;
  }
  if (params.duration_seconds !== undefined) {
    falInput.duration_seconds = params.duration_seconds;
  }
  if (params.prompt_influence !== undefined) {
    falInput.prompt_influence = params.prompt_influence;
  }
  if (params.loop !== undefined) {
    falInput.loop = params.loop;
  }

  const body = { input: falInput };
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  // Submit task
  const submitData = await requestWithRetry(
    submitUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "fal",
  );

  const requestId = submitData.request_id as string | undefined;
  if (!requestId) {
    throw new Error("No request_id in fal.ai submit response");
  }

  const statusUrl = (submitData.status_url as string) ??
    `${resolved.baseUrl}/${resolved.modelId}/requests/${requestId}/status`;
  const responseUrl = (submitData.response_url as string) ??
    `${resolved.baseUrl}/${resolved.modelId}/requests/${requestId}/response`;

  // Poll for completion
  await pollUntilDone(statusUrl, {
    headers,
    statusPath: ["status"],
    successStatuses: new Set(["COMPLETED"]),
    failureStatuses: new Set(["FAILED"]),
    errorPath: ["error"],
    interval: 2000,
    maxWait: 300_000,
    provider: "fal",
  });

  // Fetch result
  const resultData = await requestWithRetry(
    responseUrl,
    { method: "GET", headers },
    "fal",
  );

  const audioInfo = resultData.audio as Record<string, unknown> | undefined;
  const url = audioInfo?.url as string | undefined;
  if (!url) {
    throw new Error("No audio URL in fal.ai result");
  }

  return { url, model: resolved.modelName, cost: 0 };
}
