// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
  extractNested,
} from "@worker/providers/http.js";

/**
 * Extract the first output URL from a WaveSpeed API response.
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
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * task id the submit POST is skipped and polling resumes; a fresh submit
 * persists the returned task id before polling starts.
 * @param _prompt - Text prompt (embedded in params as `text`)
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (already converted by `buildRequest`)
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
  const headers = bearerHeaders(resolved.apiKey);
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  // Submit response that already carried outputs (sync short-circuit):
  // poll() returns it directly instead of hitting the predictions endpoint.
  let syncResult: Record<string, unknown> | null = null;

  /**
   * Submit the generation task to WaveSpeed.
   * @returns The vendor task id, or `""` when the response already carries
   *   outputs but no task id (sync result — nothing to persist or poll)
   * @throws {Error} if the response carries neither a task id nor outputs
   */
  const submit = async (): Promise<string> => {
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

    // Synchronous result available
    if (extractOutputUrl(data)) {
      syncResult = data;
    }

    const taskId = extractNested(data, ["data", "id"]) as string | undefined;
    if (!taskId) {
      if (syncResult) {
        return "";
      }
      throw new Error("No task ID or outputs in WaveSpeed response");
    }
    return taskId;
  };

  /**
   * Poll the WaveSpeed prediction by task id until it reaches a terminal
   * status, short-circuiting when the submit response was synchronous.
   * @param taskId - The vendor task id to poll
   * @returns The terminal poll response (or the captured sync response)
   */
  const poll = async (taskId: string): Promise<Record<string, unknown>> => {
    if (syncResult) {
      return syncResult;
    }
    return pollUntilDone(`${resolved.baseUrl}/predictions/${taskId}/result`, {
      headers,
      statusPath: ["data", "status"],
      successStatuses: new Set(["completed"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["data", "error"],
      interval: 2000,
      maxWait: 300_000,
      provider: "wavespeed",
    });
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    // Skip the "" sentinel from the sync short-circuit: there is no vendor
    // task to resume, and persisting "" would poison retry resume.
    persistId: async (id: string): Promise<void> => {
      if (id !== "" && resume) {
        await resume.persistTaskId(id);
      }
    },
    poll,
  });

  const outputUrl = extractOutputUrl(result);
  if (!outputUrl) {
    throw new Error("No output URL after WaveSpeed polling");
  }

  return { url: outputUrl, model: resolved.modelName, cost: 0 };
}
