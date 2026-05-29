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

import type { ResolvedModel } from "@worker/providers/shared.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
} from "@worker/providers/http.js";

/**
 * Extract video URL from BytePlus API response.
 *
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
 *
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
 * @param prompt - Video description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters
 * @returns Object with `url`, `model`, and `cost`
 * @throws Error if the task fails or returns no output
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const headers = bearerHeaders(resolved.apiKey);
  const body: Record<string, unknown> = {
    model: resolved.modelId,
    prompt,
    ...params,
  };

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
    const cost = extractCost(data);
    return { url: immediateUrl, model: resolved.modelName, cost };
  }

  const taskId = data.task_id as string | undefined;
  if (!taskId) {
    throw new Error(`BytePlus returned no task_id. Response: ${JSON.stringify(data)}`);
  }

  // Poll for result
  const result = await pollUntilDone(
    `${resolved.baseUrl}/video/generations/${taskId}`,
    {
      headers,
      statusPath: ["status"],
      successStatuses: new Set(["succeeded"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["error", "message"],
      provider: "byteplus",
    },
  );

  const url = extractVideoUrl(result);
  if (!url) {
    throw new Error("BytePlus task succeeded but no video URL");
  }

  const cost = extractCost(result);
  return { url, model: resolved.modelName, cost };
}
