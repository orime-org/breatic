// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * KlingAI official video provider adapter.
 *
 * Handles the KlingAI v1 API for Kling video models (O3, V3 Motion).
 * Uses JWT authentication with access_key + secret_key, submit + poll pattern.
 *
 * KlingAI API pattern:
 *
 *     POST {base_url}/videos/text2video           (t2v)
 *     POST {base_url}/videos/image2video          (i2v / first_last)
 *     POST {base_url}/videos/multi-image2video    (ref)
 *     POST {base_url}/videos/video2video          (edit -- see MODE_ENDPOINTS)
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
import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
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
 * Which endpoint serves each generation mode (#1904).
 *
 * The kind of job decides the URL, so this is keyed by mode rather than by
 * model: another model doing the same kind of job posts to the same place.
 *
 * `image2video` is the one path four independent KlingAI clients agree on —
 * that is where the evidence is strongest, and it is where both frames ride.
 * `text2video` comes off the same lists; `multi-image2video` rests on a
 * narrower base (one client names it for reference jobs, several others
 * reference the path), and one of those four endpoint lists does not carry it
 * at all. `video2video` and the entry for motion control are **inherited, not
 * verified** — neither vendor endpoint list carries `video2video`, and motion
 * control's path could not be established.
 * Both keep exactly what the old param-name chain produced, so nothing moves
 * for the models that use them; #1910 tracks establishing the truth.
 */
const MODE_ENDPOINTS: Readonly<Record<string, string>> = {
  t2v: "text2video",
  i2v: "image2video",
  first_last: "image2video",
  ref: "multi-image2video",
  edit: "video2video",
  motion: "image2video",
};

/**
 * The endpoint a model's declared mode calls for.
 *
 * The mode is the model's own (`ResolvedModel.mode`): the job carries no
 * generation mode of its own — `job.data.mode` is the node's append/overwrite
 * write mode. A model may declare several modes, which is fine while they
 * agree on where to post; a model that declared two kinds of job could not be
 * routed from what the worker holds, and picking one silently would post to an
 * endpoint nobody asked for.
 * @param mode - The resolved model's declared mode, one or several.
 * @returns The endpoint suffix, e.g. `"image2video"`.
 * @throws {Error} when the model declares no mode, declares one with no
 *   endpoint, or declares modes that call for different endpoints.
 */
export function endpointForMode(mode: string | string[]): string {
  const modes = Array.isArray(mode) ? mode : [mode];
  if (modes.length === 0) {
    throw new Error("KlingAI: the model declares no mode, so no endpoint fits");
  }

  const endpoints = new Set(
    modes.map((m) => {
      const endpoint = MODE_ENDPOINTS[m];
      if (!endpoint) {
        throw new Error(`KlingAI: no endpoint is known for mode "${m}"`);
      }
      return endpoint;
    }),
  );

  if (endpoints.size > 1) {
    throw new Error(
      `KlingAI: the model's modes call for different endpoints: ${modes.join(", ")}`,
    );
  }

  return [...endpoints][0]!;
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
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * task id the submit POST is skipped and polling resumes; a fresh submit
 * carries a deterministic `external_task_id` (account-unique per Kling docs)
 * so a retried identical submit is deduped vendor-side, and the returned
 * task id is persisted before polling starts.
 * @param prompt - Video description prompt
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters (already converted by model family)
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
  const endpoint = endpointForMode(resolved.mode ?? []);
  const headers = authHeaders(resolved.apiKey);

  /**
   * Submit the generation task to KlingAI.
   * @returns The vendor task id
   * @throws {Error} if the response carries no task_id
   */
  const submit = async (): Promise<string> => {
    const body: Record<string, unknown> = {
      model_name: resolved.modelId,
      prompt,
      ...params,
      ...resolved.extraParams,
      // Tier A (#1628): deterministic client id → duplicate submits are
      // rejected by Kling instead of creating a second billed task.
      ...(resume ? { external_task_id: resume.externalTaskId } : {}),
    };

    const data = await requestWithRetry(
      `${resolved.baseUrl}/videos/${endpoint}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      "klingai",
      resolved.timeout * 1000,
    );

    const taskId = extractNested(data, ["data", "task_id"]) as string | undefined;
    if (!taskId) {
      throw new Error(`KlingAI returned no task_id. Response: ${JSON.stringify(data)}`);
    }
    return taskId;
  };

  /**
   * Poll the KlingAI task by id until it reaches a terminal status.
   * @param taskId - The vendor task id to poll
   * @returns The terminal poll response
   */
  const poll = (taskId: string): Promise<Record<string, unknown>> =>
    pollUntilDone(`${resolved.baseUrl}/videos/${endpoint}/${taskId}`, {
      headers,
      statusPath: ["data", "task_status"],
      successStatuses: new Set(["succeed"]),
      failureStatuses: new Set(["failed"]),
      errorPath: ["data", "task_status_msg"],
      provider: "klingai",
    });

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: resume?.persistTaskId ?? (async (): Promise<void> => {}),
    poll,
  });

  const url = extractVideoUrl(result);
  if (!url) {
    throw new Error("KlingAI task succeeded but no video URL");
  }

  const cost = resolved.costPerCall / 100;
  return { url, model: resolved.modelName, cost };
}
