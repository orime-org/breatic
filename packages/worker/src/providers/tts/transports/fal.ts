/**
 * fal.ai TTS transport -- async submit + poll.
 *
 * Handles fal.ai-hosted TTS models (e.g. F5 TTS voice cloning).
 * Uses fal's queue API: submit -> poll status -> fetch result URL.
 *
 * API reference: https://fal.ai/models/fal-ai/f5-tts/api
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
 * Submit a TTS task to fal.ai and poll for result.
 * @param _prompt - Text prompt (embedded in params)
 * @param resolved - Resolved model with provider connection details
 * @param params - Request payload (text, ref_audio_url, ref_text)
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
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
