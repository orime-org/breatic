// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import { requestWithRetry, pollUntilDone, extractNested } from "@worker/providers/http.js";
import { logger } from "@breatic/core";

/**
 * Build Topaz authentication headers.
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
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * process id the submit POST is skipped and polling resumes; on a fresh run
 * the server-returned process id is persisted before polling starts (Topaz
 * has no client-side idempotency field, so only the returned id is stored).
 * @param resolved - Resolved provider endpoint
 * @param headers - Auth headers
 * @param params - API parameters
 * @param sourceUrl - Source image URL
 * @param resume - Worker resume context; absent for legacy/direct callers
 * @returns Object with `url` and `model`
 * @throws {Error} if the task fails or returns no output
 */
async function generateAsyncPoll(
  resolved: ResolvedModel,
  headers: Record<string, string>,
  params: Record<string, unknown>,
  sourceUrl: string | undefined,
  resume?: ResumeContext,
): Promise<{ url: string; model: string }> {
  const url = `${resolved.baseUrl}/${resolved.modelId}`;
  const formData = buildFormData(params, sourceUrl);

  /**
   * Submit response captured when Topaz returns the output immediately,
   * so `poll` can short-circuit without a status round-trip.
   */
  let immediateResult: Record<string, unknown> | null = null;

  /**
   * Submit the enhancement task to Topaz.
   * @returns The vendor process id (`""` sentinel when the response carried
   * an immediate output and no process id — nothing to resume by)
   * @throws {Error} if the response carries neither a process_id nor output
   */
  const submit = async (): Promise<string> => {
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
        immediateResult = data;
        return "";
      }
      throw new Error("No process_id or output in Topaz async response");
    }
    return processId;
  };

  /**
   * Poll the Topaz process by id until it reaches a terminal status,
   * short-circuiting when the submit response carried an immediate output.
   * @param processId - The vendor process id to poll
   * @returns The terminal poll response (or the captured immediate response)
   */
  const poll = async (processId: string): Promise<Record<string, unknown>> => {
    if (immediateResult) {
      return immediateResult;
    }
    return pollUntilDone(
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
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: async (id: string): Promise<void> => {
      // "" sentinel = immediate output with no process id — nothing to resume by.
      if (id === "") {
        return;
      }
      await resume?.persistTaskId(id);
    },
    poll,
  });

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
 * @param _prompt - Image description (unused — Topaz enhances an existing source image)
 * @param resolved - Resolved provider endpoint
 * @param params - API-ready parameters from `buildRequest()`
 * @param resume - Worker resume context for at-most-once submit (#1628);
 * only used on the async endpoint path (the sync endpoint has no task id)
 * @returns Object with `url`, `model`, and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  _prompt: string,
  resolved: ResolvedModel,
  params: Record<string, unknown>,
  resume?: ResumeContext,
): Promise<{ url: string; model: string; cost: number }> {
  const headers = authHeaders(resolved.apiKey);
  const isAsync = resolved.modelId.endsWith("/async");

  const mutableParams = { ...params };
  const sourceUrl = mutableParams.source_url as string | undefined;
  delete mutableParams.source_url;

  const cost = await estimateCost(resolved, headers, mutableParams, sourceUrl);

  const result = isAsync
    ? await generateAsyncPoll(resolved, headers, mutableParams, sourceUrl, resume)
    : await generateSync(resolved, headers, mutableParams, sourceUrl);

  return { ...result, cost };
}
