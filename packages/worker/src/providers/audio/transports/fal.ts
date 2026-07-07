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

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
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
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * request id the submit POST is skipped and polling resumes on queue URLs
 * reconstructed from that id; on a fresh run the server-returned request id
 * is persisted before polling starts (Tier B: no client id field is added
 * to the submit body).
 * @param _prompt - Audio description prompt (embedded in params)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (prompt, duration_seconds, prompt_influence, loop)
 * @param resume - Worker resume context; absent for legacy/direct callers
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
  resume?: ResumeContext,
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

  // Queue URLs returned by submit; on resume they are reconstructed from the
  // stored request id instead.
  let submitStatusUrl: string | undefined;
  let submitResponseUrl: string | undefined;

  /**
   * Submit the generation task to the fal.ai queue.
   * @returns The vendor request id
   * @throws {Error} if the response carries no request_id
   */
  const submit = async (): Promise<string> => {
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
    submitStatusUrl = submitData.status_url as string | undefined;
    submitResponseUrl = submitData.response_url as string | undefined;
    return requestId;
  };

  /**
   * Poll the fal.ai queue status by request id until it reaches a terminal
   * status, then fetch the result payload.
   * @param requestId - The vendor request id to poll
   * @returns The terminal result payload
   */
  const poll = async (requestId: string): Promise<Record<string, unknown>> => {
    const statusUrl = submitStatusUrl ??
      `${resolved.baseUrl}/${resolved.modelId}/requests/${requestId}/status`;
    const responseUrl = submitResponseUrl ??
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
    return requestWithRetry(responseUrl, { method: "GET", headers }, "fal");
  };

  const resultData = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: resume?.persistTaskId ?? (async (): Promise<void> => {}),
    poll,
  });

  const audioInfo = resultData.audio as Record<string, unknown> | undefined;
  const url = audioInfo?.url as string | undefined;
  if (!url) {
    throw new Error("No audio URL in fal.ai result");
  }

  return { url, model: resolved.modelName, cost: 0 };
}
