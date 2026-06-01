/**
 * DashScope (Alibaba Cloud) image provider adapter.
 *
 * Handles the DashScope international API for Qwen image models. Uses
 * Alibaba's own async task format: submit a task, then poll for results.
 *
 * DashScope API pattern:
 *
 *     POST {base_url}/services/aigc/text2image/image-synthesis
 *     Headers: Authorization: Bearer {api_key}, X-DashScope-Async: enable
 *     Request: {"model": "{model_id}", "input": {"prompt": "..."}, "parameters": {...}}
 *     Response: {"output": {"task_id": "...", "task_status": "PENDING"}}
 *
 *     GET {base_url}/tasks/{task_id}
 *     Response: {"output": {"task_status": "SUCCEEDED", "results": [{"url": "..."}]}}
 *
 * Models served: (none currently — retained for provider infrastructure)
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import {
  bearerHeaders,
  pollUntilDone,
  extractNested,
} from "@worker/providers/http.js";

/**
 * Build DashScope image generation request body.
 * @param prompt - Image description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (size, image, seed, etc.)
 * @returns Request body for the DashScope API
 */
function buildRequestBody(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const inputData: Record<string, unknown> = { prompt };
  if ("image" in params) {
    inputData.ref_image = params.image;
  }

  const parameters: Record<string, unknown> = {};
  if ("size" in params) {
    parameters.size = params.size;
  }
  if ("seed" in params && params.seed !== -1) {
    parameters.seed = params.seed;
  }

  return {
    model: resolved.modelId,
    input: inputData,
    parameters,
  };
}

/**
 * Build DashScope authorization headers with async mode enabled.
 * @param apiKey - Bearer token
 * @returns Headers with X-DashScope-Async: enable
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    ...bearerHeaders(apiKey),
    "X-DashScope-Async": "enable",
  };
}

/**
 * Extract image URL from DashScope task result.
 * @param data - Parsed JSON response
 * @returns Image URL string, or undefined
 */
function extractImageUrl(data: Record<string, unknown>): string | undefined {
  const results = extractNested(data, ["output", "results"]) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(results) && results.length > 0) {
    return results[0]!.url as string | undefined;
  }
  return undefined;
}

/**
 * Extract cost from DashScope task result usage field.
 * @param data - Parsed JSON response from task status endpoint
 * @returns Cost in USD, or 0 if usage data is missing
 */
function extractCost(data: Record<string, unknown>): number {
  const usage = data.usage as Record<string, unknown> | undefined;
  const totalCost = usage?.total_cost;
  if (totalCost !== undefined && totalCost !== null) {
    return Number(totalCost);
  }
  return 0;
}

/**
 * Generate an image asynchronously via DashScope API.
 *
 * Submits a task then polls until completion using the shared polling utility.
 * @param prompt - Image description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const body = buildRequestBody(prompt, resolved, params);
  const headers = authHeaders(resolved.apiKey);

  const submitUrl = `${resolved.baseUrl}/services/aigc/text2image/image-synthesis`;
  const response = await fetch(submitUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(resolved.timeout * 1000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DashScope API HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const taskId = extractNested(data, ["output", "task_id"]) as string | undefined;

  if (!taskId) {
    throw new Error(`DashScope returned no task_id. Response: ${JSON.stringify(data)}`);
  }

  // Poll for result using bearer headers without the async flag
  const pollHeaders: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
  };

  const result = await pollUntilDone(
    `${resolved.baseUrl}/tasks/${taskId}`,
    {
      headers: pollHeaders,
      statusPath: ["output", "task_status"],
      successStatuses: new Set(["SUCCEEDED"]),
      failureStatuses: new Set(["FAILED"]),
      errorPath: ["output", "message"],
      interval: 3000,
      maxWait: 300_000,
      provider: "dashscope",
    },
  );

  const url = extractImageUrl(result);
  if (!url) {
    throw new Error("DashScope task succeeded but no URL");
  }

  const cost = extractCost(result);
  return { url, model: resolved.modelName, cost };
}
