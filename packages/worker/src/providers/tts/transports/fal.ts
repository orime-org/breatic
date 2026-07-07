// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * fal.ai TTS transport -- async submit + poll.
 *
 * Handles fal.ai-hosted TTS models (e.g. F5 TTS voice cloning).
 * Uses fal's queue API: submit -> poll status -> fetch result URL.
 *
 * API reference: https://fal.ai/models/fal-ai/f5-tts/api
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
 * Submit a TTS task to fal.ai and poll for result.
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * request id the submit POST is skipped and polling resumes; a fresh submit
 * persists the returned request id before polling starts.
 * @param _prompt - Text prompt (embedded in params)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, ref_audio_url, ref_text)
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

  // Build fal.ai request -- map our params to F5 TTS expected format
  const falInput: Record<string, unknown> = {
    model_type: "F5-TTS",
  };
  if (params.text) {
    falInput.gen_text = params.text;
  }
  if (params.ref_audio_url) {
    falInput.ref_audio_url = params.ref_audio_url;
  }
  if (params.ref_text) {
    falInput.ref_text = params.ref_text;
  }

  const body = { input: falInput };
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  // Vendor-supplied queue URLs captured from the submit response (fresh run);
  // on resume the documented default shapes are derived from the stored id.
  let submitStatusUrl: string | undefined;
  let submitResponseUrl: string | undefined;

  /**
   * Submit the TTS task to the fal.ai queue.
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
    return requestWithRetry(
      responseUrl,
      { method: "GET", headers },
      "fal",
    );
  };

  const resultData = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: resume?.persistTaskId ?? (async (): Promise<void> => {}),
    poll,
  });

  // F5 TTS may return audio_url as string or audio as object with url
  const audioUrl = resultData.audio_url as string | undefined;
  const audioInfo = resultData.audio as Record<string, unknown> | string | undefined;
  const url = audioUrl ??
    (typeof audioInfo === "string" ? audioInfo : (audioInfo)?.url as string | undefined);

  if (!url) {
    throw new Error("No audio URL in fal.ai TTS result");
  }

  return { url, model: resolved.modelName, cost: 0 };
}
