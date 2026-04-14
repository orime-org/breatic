/**
 * Topaz Labs official API transport adapter.
 *
 * Handles the Topaz Image API format:
 * - Sync endpoint: POST /enhance -> returns JSON with output URL
 * - Async endpoint: POST /enhance/async -> returns process_id, poll for result
 *
 * Authentication uses `X-API-Key` header (not Bearer token).
 *
 * API docs: https://developer.topazlabs.com/image-api/
 */

import type { ResolvedModel } from "../../shared.js";
import { requestWithRetry, pollUntilDone, extractNested } from "../../http.js";
import { logger } from "@breatic/core";

/**
 * Build Topaz authentication headers.
 *
 * @param apiKey - Topaz API key
 * @returns Headers with X-API-Key
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    "X-API-Key": apiKey,
    accept: "application/json",
  };
}

/**
 * Build URL-encoded form data for Topaz API.
 *
 * Converts all values to strings. Booleans become lowercase `"true"` / `"false"`.
 *
 * @param params - API parameters
 * @param sourceUrl - Source image URL
 * @returns URLSearchParams-compatible entries
 */
function buildFormData(
  params: Record<string, unknown>,
  sourceUrl: string | undefined,
): URLSearchParams {
  const form = new URLSearchParams();

  if (sourceUrl) {
    form.set("source_url", sourceUrl);
  }

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "boolean") {
      form.set(key, value ? "true" : "false");
    } else {
      form.set(key, String(value));
    }
  }

  return form;
}

/**
 * Estimate cost via Topaz estimate API before generation.
 *
 * Calls `POST /image/v1/estimate` to get the credit cost,
 * then converts credits to USD using `resolved.creditPrice`.
 *
 * @param resolved - Resolved provider endpoint
 * @param headers - Auth headers
 * @param params - API parameters
 * @param sourceUrl - Source image URL
 * @returns Estimated cost in USD, or 0 if estimate fails
 */
async function estimateCost(
  resolved: ResolvedModel,
  headers: Record<string, string>,
  params: Record<string, unknown>,
  sourceUrl: string | undefined,
): Promise<number> {
  const estimateUrl = `${resolved.baseUrl}/estimate`;
  const formData = buildFormData(params, sourceUrl);

  try {
    const response = await fetch(estimateUrl, {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) return 0;

    const data = (await response.json()) as Record<string, unknown>;
    const credits = (data.credits as number) ?? 0;
    return credits * (resolved.creditPrice ?? 0);
  } catch {
    logger.warn({ model: resolved.modelName }, "topaz_estimate_failed");
    return 0;
  }
}

/**
 * Submit to sync Topaz endpoint and get result URL.
 *
 * @param resolved - Resolved provider endpoint
 * @param headers - Auth headers
 * @param params - API parameters
 * @param sourceUrl - Source image URL
 * @returns Object with `url` and `model`
 */
async function generateSync(
  resolved: ResolvedModel,
  headers: Record<string, string>,
  params: Record<string, unknown>,
  sourceUrl: string | undefined,
): Promise<{ url: string; model: string }> {
  const url = `${resolved.baseUrl}/${resolved.modelId}`;
  const formData = buildFormData(params, sourceUrl);

  const resp = await requestWithRetry(
    url,
    {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "topaz",
  );

  const outputUrl = (resp.output_url ?? resp.url) as string | undefined;
  if (!outputUrl) {
    throw new Error("No output URL in Topaz sync response");
  }

  return { url: outputUrl, model: resolved.modelName };
}

/**
 * Submit to async Topaz endpoint and poll for result.
 *
 * @param resolved - Resolved provider endpoint
 * @param headers - Auth headers
 * @param params - API parameters
 * @param sourceUrl - Source image URL
 * @returns Object with `url` and `model`
 */
async function generateAsyncPoll(
  resolved: ResolvedModel,
  headers: Record<string, string>,
  params: Record<string, unknown>,
  sourceUrl: string | undefined,
): Promise<{ url: string; model: string }> {
  const url = `${resolved.baseUrl}/${resolved.modelId}`;
  const formData = buildFormData(params, sourceUrl);

  const data = await requestWithRetry(
    url,
    {
      method: "POST",
      headers,
      body: formData,
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "topaz",
  );

  const processId = data.process_id as string | undefined;

  if (!processId) {
    // If no process_id, check for immediate result
    const outputUrl = (data.output_url ?? data.url) as string | undefined;
    if (outputUrl) {
      return { url: outputUrl, model: resolved.modelName };
    }
    throw new Error("No process_id or output in Topaz async response");
  }

  // Poll for result
  const result = await pollUntilDone(
    `${resolved.baseUrl}/status/${processId}`,
    {
      headers,
      statusPath: ["status"],
      successStatuses: new Set(["completed"]),
      failureStatuses: new Set(["failed", "error"]),
      errorPath: ["error"],
      interval: 3000,
      maxWait: 300_000,
      provider: "topaz",
    },
  );

  const outputUrl = (extractNested(result, ["output_url"]) ?? extractNested(result, ["url"])) as string | undefined;
  if (!outputUrl) {
    throw new Error("No output URL after Topaz polling");
  }

  return { url: outputUrl, model: resolved.modelName };
}

/**
 * Generate an enhanced image via Topaz API.
 *
 * Uses the async endpoint for generative models (Redefine, Recovery V2),
 * and the sync endpoint for standard models (Standard V2, etc.).
 *
 * @param prompt - Image description (not used by Topaz standard models)
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters from `buildRequest()`
 * @returns Object with `url`, `model`, and `cost`
 * @throws Error if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const headers = authHeaders(resolved.apiKey);
  const isAsync = resolved.modelId.endsWith("/async");

  const mutableParams = { ...params };
  const sourceUrl = mutableParams.source_url as string | undefined;
  delete mutableParams.source_url;

  const cost = await estimateCost(resolved, headers, mutableParams, sourceUrl);

  const result = isAsync
    ? await generateAsyncPoll(resolved, headers, mutableParams, sourceUrl)
    : await generateSync(resolved, headers, mutableParams, sourceUrl);

  return { ...result, cost };
}
