// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * WaveSpeed 3D transport -- async submit + poll.
 *
 * Handles all WaveSpeed-hosted 3D models (Meshy, Hunyuan3D, Rodin,
 * Tripo3D, SAM). Same submit+poll pattern as image/audio/video
 * WaveSpeed transports.
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
  queryBilling,
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
 * Generate a 3D model asynchronously via WaveSpeed API.
 *
 * Uses submit + poll pattern. The shared `requestWithRetry` handles
 * 429 exponential backoff. After completion, queries WaveSpeed billing
 * for actual cost.
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored
 * vendor task id the submit POST is skipped and polling resumes; on a
 * fresh run the returned task id is persisted before polling starts.
 * WaveSpeed has no client-side idempotency field, so nothing is added
 * to the submit body (Tier B).
 * @param prompt - 3D object description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (already converted by `buildRequest`)
 * @param resume - Worker resume context; absent for legacy/direct callers
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
  resume?: ResumeContext,
): Promise<{ url: string; model: string; cost: number }> {
  // Strip null/undefined values — WaveSpeed rejects nullable fields
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v != null) body[k] = v;
  }
  if (prompt) {
    body.prompt = prompt;
  }

  const headers = bearerHeaders(resolved.apiKey);
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  // Submit response captured when it already carries outputs, so poll()
  // can short-circuit and preserve the pre-resume synchronous fast path.
  let syncResult: Record<string, unknown> | null = null;
  // The vendor task id poll() ran with (stored or fresh), used for the
  // post-poll billing query.
  let billedTaskId = "";

  /**
   * Submit the generation task to WaveSpeed.
   * @returns The vendor task id
   * @throws {Error} if the response carries no task id
   */
  const submit = async (): Promise<string> => {
    const data = await requestWithRetry(
      submitUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(resolved.timeout * 1000),
      },
      "wavespeed",
    );

    if (extractOutputUrl(data) !== undefined) {
      // Synchronous result available — poll() returns it without a GET.
      syncResult = data;
    }

    const taskId = extractNested(data, ["data", "id"]) as string | undefined;
    if (!taskId) {
      throw new Error(`WaveSpeed returned no task id. Response: ${JSON.stringify(data)}`);
    }
    return taskId;
  };

  /**
   * Poll the WaveSpeed task by id until it reaches a terminal status.
   *
   * Short-circuits when this run's submit already returned the outputs
   * synchronously. 3D tasks can take up to 10 minutes, hence the long
   * `maxWait`.
   * @param taskId - The vendor task id to poll
   * @returns The terminal poll (or synchronous submit) response
   */
  const poll = async (taskId: string): Promise<Record<string, unknown>> => {
    billedTaskId = taskId;
    if (syncResult) {
      return syncResult;
    }
    return pollUntilDone(
      `${resolved.baseUrl}/predictions/${taskId}/result`,
      {
        headers,
        statusPath: ["data", "status"],
        successStatuses: new Set(["completed"]),
        failureStatuses: new Set(["failed"]),
        errorPath: ["data", "error"],
        interval: 3000,
        maxWait: 600_000,
        provider: "wavespeed",
      },
    );
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: resume?.persistTaskId ?? (async (): Promise<void> => {}),
    poll,
  });

  const outputUrl = extractOutputUrl(result);
  if (!outputUrl) {
    throw new Error("No output URL after WaveSpeed polling");
  }

  const cost = await queryBilling(resolved, billedTaskId);
  return { url: outputUrl, model: resolved.modelName, cost };
}
