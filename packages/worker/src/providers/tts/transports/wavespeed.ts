/**
 * WaveSpeed TTS transport -- async submit + poll.
 *
 * Handles all WaveSpeed-hosted TTS models (ElevenLabs V3, MiniMax Speech,
 * Gemini TTS, Qwen3 Voice Clone via WaveSpeed proxy).
 * Same submit+poll pattern as audio/image/video WaveSpeed transports.
 *
 * WaveSpeed API pattern:
 *
 *     POST {base_url}/{model_id}  ->  {"data": {"id": "...", "outputs": [...]}}
 *     GET  {base_url}/predictions/{task_id}/result  ->  poll until completed
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
  extractNested,
} from "@worker/providers/http.js";

/**
 * Extract the first output URL from a WaveSpeed API response.
 *
 * @param data - Parsed JSON response
 * @returns Output URL string, or undefined
 */
function extractOutputUrl(data: Record<string, unknown>): string | undefined {
  const outputs = extractNested(data, ["data", "outputs"]) as unknown[] | undefined;
  if (Array.isArray(outputs) && outputs.length > 0) {
    return outputs[0] as string;
  }
  return undefined;
}

/**
 * Generate speech asynchronously via WaveSpeed API.
 *
 * Uses submit + poll pattern. The shared `requestWithRetry` handles
 * 429 exponential backoff.
 *
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (already converted by `buildRequest`)
 * @returns Object with `url`, `model`, and `cost`
 * @throws Error if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const headers = bearerHeaders(resolved.apiKey);
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  const data = await requestWithRetry(
    submitUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "wavespeed",
  );

  const url = extractOutputUrl(data);
  const taskId = extractNested(data, ["data", "id"]) as string | undefined;

  // Synchronous result available
  if (url) {
    return { url, model: resolved.modelName, cost: 0 };
  }

  if (!taskId) {
    throw new Error("No task ID or outputs in WaveSpeed response");
  }

  // Poll for async result
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

  const outputUrl = extractOutputUrl(result);
  if (!outputUrl) {
    throw new Error("No output URL after WaveSpeed polling");
  }

  return { url: outputUrl, model: resolved.modelName, cost: 0 };
}
