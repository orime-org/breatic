// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * BytePlus ModelArk video provider adapter.
 *
 * Handles the BytePlus (Volcano Engine international) API for Seedance video
 * models. Uses submit + poll pattern.
 *
 * BytePlus Video API pattern:
 *
 *     POST {base_url}/video/generations
 *     Headers: Authorization: Bearer {api_key}
 *     Request: {"model": "{model_id}", "prompt": "...", ...}
 *     Response: {"task_id": "...", "status": "pending"}
 *
 *     GET {base_url}/video/generations/{task_id}
 *     Response: {"status": "succeeded", "data": [{"url": "..."}],
 *       "usage": {"total_cost": ...}}
 *
 * Models served: seedance-2.0, seedance-1.5-pro (t2v, i2v, extend)
 */

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
} from "@worker/providers/http.js";

/**
 * Extract video URL from BytePlus API response.
 * @param data - Parsed JSON response
 * @returns Video URL string, or undefined
 */
function extractVideoUrl(data: Record<string, unknown>): string | undefined {
  const items = data.data as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(items) && items.length > 0) {
    return items[0]!.url as string | undefined;
  }
  return undefined;
}

/**
 * Extract cost from BytePlus API response usage field.
 * @param data - Parsed JSON response
 * @returns Cost in USD, or 0 if usage data is missing
 */
function extractCost(data: Record<string, unknown>): number {
  const usage = data.usage as Record<string, unknown> | undefined;
  const totalCost = usage?.total_cost;
  return totalCost != null ? Number(totalCost) : 0;
}

/**
 * Generate a video asynchronously via BytePlus ModelArk API.
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * task id the submit POST is skipped and polling resumes; on a fresh run the
 * server-returned task id is persisted before polling starts (Tier B:
 * BytePlus has no idempotent client-side submit id, so nothing is added to
 * the submit body).
 * @param prompt - Video description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters
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
  const headers = bearerHeaders(resolved.apiKey);
  const body: Record<string, unknown> = {
    model: resolved.modelId,
    prompt,
    ...params,
  };

  // Submit response that already carried a video URL (immediate result):
  // poll() returns it directly instead of hitting the task endpoint.
  let syncResult: Record<string, unknown> | null = null;

  /**
   * Submit the generation task to BytePlus.
   * @returns The vendor task id, or `""` when the response already carries
   *   a video URL but no task id (immediate result — nothing to persist or poll)
   * @throws {Error} if the response carries neither a task id nor a video URL
   */
  const submit = async (): Promise<string> => {
    const data = await requestWithRetry(
      `${resolved.baseUrl}/video/generations`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(resolved.timeout * 1000),
      },
      "byteplus",
    );

    // Check for immediate result
    const immediateUrl = extractVideoUrl(data);
    if (immediateUrl) {
      syncResult = data;
      return (data.task_id as string | undefined) ?? "";
    }

    const taskId = data.task_id as string | undefined;
    if (!taskId) {
      throw new Error(`BytePlus returned no task_id. Response: ${JSON.stringify(data)}`);
    }
    return taskId;
  };

  /**
   * Poll the BytePlus task by id until it reaches a terminal status.
   * Returns the captured submit response directly for immediate results.
   * @param taskId - The vendor task id to poll
   * @returns The terminal poll response (or the immediate submit response)
   */
  const poll = (taskId: string): Promise<Record<string, unknown>> => {
    if (syncResult !== null) {
      return Promise.resolve(syncResult);
    }
    return pollUntilDone(`${resolved.baseUrl}/video/generations/${taskId}`, {
      headers,
      statusPath: ["status"],
      successStatuses: new Set(["succeeded"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["error", "message"],
      provider: "byteplus",
    });
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    // Skip the "" sentinel from the immediate-result short-circuit: there is
    // no vendor task to resume, and persisting "" would poison retry resume.
    persistId: async (id: string): Promise<void> => {
      if (id !== "" && resume) {
        await resume.persistTaskId(id);
      }
    },
    poll,
  });

  const url = extractVideoUrl(result);
  if (!url) {
    throw new Error("BytePlus task succeeded but no video URL");
  }

  const cost = extractCost(result);
  return { url, model: resolved.modelName, cost };
}
