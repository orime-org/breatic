// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Google Generative Language video provider adapter.
 *
 * Handles the Google API for VEO video models. Uses the long-running
 * operations pattern: submit via `generateVideos`, then poll the
 * returned operation until done.
 *
 * Google VEO API pattern:
 *
 *     POST {base_url}/models/{model_id}:generateVideos?key={api_key}
 *     Request: {"instances": [{"prompt": "..."}], "parameters": {...}}
 *     Response: {"name": "operations/abc123"}
 *
 *     GET {base_url}/{operation_name}?key={api_key}
 *     Response: {"done": true, "response": {"generateVideoResponse":
 *       {"generatedSamples": [{"video": {"uri": "..."}}]}}}
 *
 * Models served: veo-3.1 (t2v, i2v, extend)
 */

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import { requestWithRetry } from "@worker/providers/http.js";

const POLL_INTERVAL = 5000; // ms
const MAX_WAIT = 300_000; // ms (5 min)

/**
 * Build Google generateVideos request body.
 * @param prompt - Video description prompt
 * @param params - API-ready parameters (camelCase, from model family)
 * @returns Request body dict
 */
function buildRequestBody(
  prompt: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const mutable = { ...params };
  const instance: Record<string, unknown> = { prompt };

  // Move image to instance (I2V mode)
  if ("image" in mutable) {
    instance.image = { imageUri: mutable.image };
    delete mutable.image;
  }

  // Move video to instance (extend mode)
  if ("video" in mutable) {
    instance.video = { videoUri: mutable.video };
    delete mutable.video;
  }

  // Move referenceImages to instance
  if ("referenceImages" in mutable) {
    instance.referenceImages = mutable.referenceImages;
    delete mutable.referenceImages;
  }

  return {
    instances: [instance],
    parameters: mutable,
  };
}

/**
 * Extract video URL from Google operation result.
 * @param data - Parsed JSON response from completed operation
 * @returns Video URL string, or undefined
 */
function extractVideoUrl(data: Record<string, unknown>): string | undefined {
  const response = data.response as Record<string, unknown> | undefined;
  const videoResponse = response?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples = videoResponse?.generatedSamples as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(samples) && samples.length > 0) {
    const video = samples[0]!.video as Record<string, unknown> | undefined;
    return video?.uri as string | undefined;
  }
  return undefined;
}

/**
 * Sleep for the given milliseconds.
 * @param ms - Milliseconds to sleep
 * @returns A promise that resolves after the delay elapses
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a video asynchronously via Google VEO API.
 *
 * Uses long-running operations pattern with manual polling since
 * the Google API uses a `done` boolean instead of status strings.
 * Submit is at-most-once across BullMQ retries (#1628): the operation
 * name is persisted right after submit; with a stored operation name
 * the submit POST is skipped and polling resumes.
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
  const queryParams = `key=${resolved.apiKey}`;

  /**
   * Submit the VEO generation to Google.
   * @returns The long-running operation name (the vendor task id)
   * @throws {Error} if the response carries no operation name
   */
  const submit = async (): Promise<string> => {
    const body = buildRequestBody(prompt, { ...params });
    const data = await requestWithRetry(
      `${resolved.baseUrl}/models/${resolved.modelId}:generateVideos?${queryParams}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(resolved.timeout * 1000),
      },
      "google",
    );

    const operationName = data.name as string | undefined;
    if (!operationName) {
      throw new Error(`Google returned no operation name. Response: ${JSON.stringify(data)}`);
    }
    return operationName;
  };

  /**
   * Poll the Google operation by name until `done`.
   * @param operationName - The operation name returned by submit
   * @returns The terminal operation response
   * @throws {Error} on operation error or timeout
   */
  const poll = async (operationName: string): Promise<Record<string, unknown>> => {
    let elapsed = 0;
    while (elapsed < MAX_WAIT) {
      const result = await requestWithRetry(
        `${resolved.baseUrl}/${operationName}?${queryParams}`,
        { method: "GET", headers: {} },
        "google",
      );

      if (result.done) {
        const error = result.error as Record<string, unknown> | undefined;
        if (error) {
          throw new Error(
            `Google VEO task failed: ${(error.message as string) ?? "unknown"}`,
          );
        }
        return result;
      }

      await sleep(POLL_INTERVAL);
      elapsed += POLL_INTERVAL;
    }

    throw new Error(`Google VEO operation did not complete within ${MAX_WAIT / 1000}s`);
  };

  const result = await submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId: resume?.persistTaskId ?? (async (): Promise<void> => {}),
    poll,
  });

  const url = extractVideoUrl(result);
  if (!url) {
    throw new Error("Google VEO task done but no video URL");
  }

  const cost = resolved.costPerCall / 100;
  return { url, model: resolved.modelName, cost };
}
