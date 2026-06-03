// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * KlingAI official video provider adapter.
 *
 * Handles the KlingAI v1 API for Kling video models (O3, V3 Motion).
 * Uses JWT authentication with access_key + secret_key, submit + poll pattern.
 *
 * KlingAI API pattern:
 *
 *     POST {base_url}/videos/text2video      (t2v / ref)
 *     POST {base_url}/videos/image2video      (i2v)
 *     POST {base_url}/videos/video2video      (edit)
 *     Body: {"model_name": "{model_id}", "prompt": "...", ...extra_params}
 *     Response: {"code": 0, "data": {"task_id": "..."}}
 *
 *     GET {base_url}/videos/{endpoint}/{task_id}
 *     Response: {"code": 0, "data": {"task_status": "succeed",
 *       "task_result": {"videos": [{"url": "..."}]}}}
 *
 * Models served: kling-o3-pro, kling-o3-std (t2v/i2v/ref/edit), kling-v3 motion
 */

import { createHmac } from "node:crypto";
import type { ResolvedModel } from "@worker/providers/shared.js";
import {
  requestWithRetry,
  pollUntilDone,
  extractNested,
} from "@worker/providers/http.js";

/**
 * Generate a JWT token from an `access_key:secret_key` string.
 *
 * The KlingAI API requires JWT authentication. If the `apiKey` does not
 * contain a colon, it is used directly as a pre-signed Bearer token.
 * @param apiKey - Combined `"access_key:secret_key"` or pre-signed JWT
 * @returns JWT token string
 */
function buildJwt(apiKey: string): string {
  if (!apiKey.includes(":")) {
    return apiKey;
  }

  const [accessKey, secretKey] = apiKey.split(":", 2) as [string, string];
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  /**
   * Base64url-encode raw bytes for use in a JWT segment.
   * @param data - Raw bytes to encode
   * @returns The base64url string (no padding)
   */
  const b64url = (data: Uint8Array): string =>
    Buffer.from(data).toString("base64url");

  const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = createHmac("sha256", secretKey).update(`${h}.${p}`).digest();

  return `${h}.${p}.${b64url(sig)}`;
}

/**
 * Build KlingAI authorization headers with JWT.
 * @param apiKey - Access key (may be `"access_key:secret_key"`)
 * @returns Headers dict
 */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${buildJwt(apiKey)}`,
    "Content-Type": "application/json",
  };
}

/**
 * Infer the API endpoint from request params.
 * @param params - API-ready params (after model family conversion)
 * @returns Endpoint suffix (e.g. `"text2video"`)
 */
function inferEndpoint(params: Record<string, unknown>): string {
  if ("video_url" in params) return "video2video";
  if ("image_url" in params) return "image2video";
  return "text2video";
}

/**
 * Extract the first video URL from KlingAI API response.
 * @param data - Parsed JSON response
 * @returns Video URL string, or undefined
 */
function extractVideoUrl(data: Record<string, unknown>): string | undefined {
  const videos = extractNested(data, ["data", "task_result", "videos"]) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(videos) && videos.length > 0) {
    return videos[0]!.url as string | undefined;
  }
  return undefined;
}

/**
 * Generate a video asynchronously via KlingAI official API.
 * @param prompt - Video description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (already converted by model family)
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
): Promise<{ url: string; model: string; cost: number }> {
  const endpoint = inferEndpoint(params);
  const headers = authHeaders(resolved.apiKey);

  const body: Record<string, unknown> = {
    model_name: resolved.modelId,
    prompt,
    ...params,
    ...resolved.extraParams,
  };

  const data = await requestWithRetry(
    `${resolved.baseUrl}/videos/${endpoint}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(resolved.timeout * 1000),
    },
    "klingai",
  );

  const taskId = extractNested(data, ["data", "task_id"]) as string | undefined;
  if (!taskId) {
    throw new Error(`KlingAI returned no task_id. Response: ${JSON.stringify(data)}`);
  }

  // Poll for result
  const result = await pollUntilDone(
    `${resolved.baseUrl}/videos/${endpoint}/${taskId}`,
    {
      headers,
      statusPath: ["data", "task_status"],
      successStatuses: new Set(["succeed"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["data", "task_status_msg"],
      provider: "klingai",
    },
  );

  const url = extractVideoUrl(result);
  if (!url) {
    throw new Error("KlingAI task succeeded but no video URL");
  }

  const cost = resolved.costPerCall / 100;
  return { url, model: resolved.modelName, cost };
}
