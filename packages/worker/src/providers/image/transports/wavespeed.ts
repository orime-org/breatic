// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * WaveSpeed AI image provider adapter.
 *
 * Handles the WaveSpeed v3 API format: submit a generation task via POST,
 * then poll for the result. Supports all image models as WaveSpeed acts
 * as a unified proxy.
 *
 * WaveSpeed API pattern:
 *
 *     POST {base_url}/{model_id}  →  {"data": {"id": "...", "outputs": [...]}}
 *     GET  {base_url}/predictions/{task_id}/result  →  poll until completed
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
 * Generate an image asynchronously via WaveSpeed API.
 *
 * Uses submit + poll pattern. The shared `requestWithRetry` handles
 * 429 exponential backoff. After completion, queries WaveSpeed billing
 * for actual cost.
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * task id the submit POST is skipped and polling resumes; on a fresh run the
 * server-returned task id is persisted before polling starts (WaveSpeed has
 * no client-side idempotency field, so only the returned id is stored).
 * @param prompt - Image description prompt
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

  /**
   * Submit response captured when WaveSpeed returns the outputs
   * synchronously, so `poll` can short-circuit without an extra GET.
   */
  let syncResult: Record<string, unknown> | null = null;

  /**
   * The vendor task id used for the billing lookup; stays null for a
   * synchronous response that carried no task id (billed as 0).
   */
  let billingTaskId: string | null = null;

  /**
   * Submit the generation task to WaveSpeed.
   * @returns The vendor task id (`""` sentinel for a synchronous response
   * that carried outputs but no task id — nothing to resume by)
   * @throws {Error} if the response carries neither a task id nor outputs
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
    if (taskId !== "") {
      billingTaskId = taskId;
    }
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
        interval: 2000,
        maxWait: 300_000,
        provider: "wavespeed",
      },
    );
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: async (id: string): Promise<void> => {
      // "" sentinel = sync-only response with no task id — nothing to resume by.
      if (id === "") {
        return;
      }
      await resume?.persistTaskId(id);
    },
    poll,
  });

  const outputUrl = extractOutputUrl(result);
  if (!outputUrl) {
    throw new Error("No output URL after WaveSpeed polling");
  }

  const cost = billingTaskId ? await queryBilling(resolved, billingTaskId) : 0;
  return { url: outputUrl, model: resolved.modelName, cost };
}
