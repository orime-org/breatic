/**
 * BytePlus ModelArk image provider adapter.
 *
 * Handles the BytePlus (Volcano Engine international) API for Seedream models.
 * Both generation and editing use the same `/images/generations` endpoint --
 * editing includes reference images in the request body.
 *
 * BytePlus API pattern:
 *
 *     POST {base_url}/images/generations
 *     Headers: Authorization: Bearer {api_key}
 *     Request: {"model": "{model_id}", "prompt": "...", "size": "1024*1024", ...}
 *     Response: {"data": [{"url": "..."}]}
 *
 * Models served: seedream-5.0-lite
 */

import type { ResolvedModel } from "@worker/providers/shared.js";
import { bearerHeaders } from "@worker/providers/http.js";

/**
 * Build BytePlus images/generations request body.
 *
 * @param prompt - Image description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (size, images, etc.)
 * @returns Request body for the BytePlus API
 */
function buildRequestBody(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolved.modelId,
    prompt,
  };

  if ("size" in params) {
    body.size = params.size;
  }
  if ("images" in params) {
    body.image_urls = params.images;
  }
  if ("image_urls" in params) {
    body.image_urls = params.image_urls;
  }

  return body;
}

/**
 * Extract image URL from BytePlus API response.
 *
 * @param data - Parsed JSON response
 * @returns Image URL string, or undefined
 */
function extractImageUrl(data: Record<string, unknown>): string | undefined {
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
  if (totalCost !== undefined && totalCost !== null) {
    return Number(totalCost);
  }
  return 0;
}

/**
 * Generate an image asynchronously via BytePlus ModelArk API.
 *
 * @param prompt - Image description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters
 * @returns Object with `url`, `model`, and `cost`
 * @throws Error if no image is returned
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const body = buildRequestBody(prompt, resolved, params);

  const response = await fetch(
    `${resolved.baseUrl}/images/generations`,
    {
      method: "POST",
      headers: bearerHeaders(resolved.apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`BytePlus API HTTP ${response.status}: ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  const url = extractImageUrl(data);
  if (!url) {
    throw new Error(`BytePlus API returned no image. Response: ${JSON.stringify(data)}`);
  }

  const cost = extractCost(data);
  return { url, model: resolved.modelName, cost };
}
