// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * WaveSpeed transport for ASR transcription (Whisper).
 *
 * Submits audio to WaveSpeed Whisper API and polls for transcription
 * result. Returns `{ text, cost }`.
 */

import type { ResolvedModel, ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import type { AnyUnderstandFamily } from "@worker/providers/understand/models/types.js";
import { isAsrFamily } from "@worker/providers/understand/models/types.js";
import {
  bearerHeaders,
  requestWithRetry,
  pollUntilDone,
  extractNested,
  queryBilling,
} from "@worker/providers/http.js";

/**
 * Transcribe audio via WaveSpeed Whisper API.
 *
 * Uses submit + poll pattern. The shared `requestWithRetry` handles
 * 429 exponential backoff. After completion, queries WaveSpeed billing
 * for actual cost.
 *
 * Submit is at-most-once across BullMQ retries (#1628): with a stored vendor
 * task id the submit POST is skipped and polling resumes; a fresh submit
 * persists the server-returned task id before polling starts. WaveSpeed has
 * no client-side idempotency field, so nothing is added to the submit body.
 * @param resolved - Resolved model with WaveSpeed connection details
 * @param family - Model family module with `buildRequest()`
 * @param prompt - Unused for transcription (guidance prompt passed via params)
 * @param params - Must include `audio` URL
 * @param resume - Worker resume context; absent for legacy/direct callers
 * @returns Object with `text` (transcription) and `cost`
 * @throws {Error} if the task fails or returns no output
 */
export async function generate(
  resolved: ResolvedModel,
  family: AnyUnderstandFamily,
  prompt: string,
  params: Record<string, unknown>,
  resume?: ResumeContext,
): Promise<{ text: string; cost: number }> {
  if (!isAsrFamily(family)) {
    throw new Error(
      `WaveSpeed transport requires an ASR model family with buildRequest(), ` +
      `but got a family without it for model '${resolved.modelName}'`,
    );
  }

  const [_prompt, apiParams] = await family.buildRequest(
    prompt,
    resolved.modelName,
    params,
  );

  const headers = bearerHeaders(resolved.apiKey);
  const submitUrl = `${resolved.baseUrl}/${resolved.modelId}`;

  // WaveSpeed may answer inline: the submit response itself can carry the
  // outputs, with no polling round to resume. submit() captures that answer
  // here and poll() returns it without an extra HTTP call.
  let immediateResult: { text: string; cost: number } | null = null;

  /**
   * Submit the transcription task to WaveSpeed.
   *
   * When WaveSpeed answers inline, the result is captured in
   * `immediateResult`; the vendor id (when present) is still returned so it
   * is persisted and a retried job resume-polls the completed task. An
   * inline answer without an id has nothing to resume by — the empty-string
   * sentinel returned for it is skipped by `persistId` and never polled
   * (`poll` short-circuits on `immediateResult`).
   * @returns The vendor task id (empty string only for an inline answer with no id)
   * @throws {Error} if the response carries neither outputs nor a task id
   */
  const submit = async (): Promise<string> => {
    const data = await requestWithRetry(
      submitUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(apiParams),
        signal: AbortSignal.timeout(resolved.timeout * 1000),
      },
      "wavespeed",
    );

    // Check for immediate result
    const outputs = extractNested(data, ["data", "outputs"]);
    const taskId = extractNested(data, ["data", "id"]) as string | undefined;

    if (outputs) {
      const text = typeof outputs === "string" ? outputs : String(outputs);
      const cost = taskId ? await queryBilling(resolved, taskId) : 0;
      immediateResult = { text, cost };
      return taskId ?? "";
    }

    if (!taskId) {
      throw new Error("No task ID or outputs in WaveSpeed response");
    }
    return taskId;
  };

  /**
   * Persist the vendor task id so a retried job can resume by it.
   *
   * Skips the empty-string sentinel (inline answer without a vendor id):
   * persisting it would make a later retry resume-poll a bogus id.
   * @param id - The vendor task id returned by `submit`
   * @returns Resolves once the id is persisted (or skipped)
   */
  const persistId = async (id: string): Promise<void> => {
    if (id === "") {
      return;
    }
    await resume?.persistTaskId(id);
  };

  /**
   * Poll the WaveSpeed prediction by id until it reaches a terminal status,
   * then extract the transcription text and query billing for actual cost.
   *
   * Returns the inline answer captured by `submit` (when present) without
   * an extra HTTP round.
   * @param taskId - The vendor task id to poll
   * @returns Object with `text` (transcription) and `cost`
   * @throws {Error} if the task fails or returns no output
   */
  const poll = async (taskId: string): Promise<{ text: string; cost: number }> => {
    if (immediateResult) {
      return immediateResult;
    }

    const result = await pollUntilDone(
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

    const resultOutputs = extractNested(result, ["data", "outputs"]);
    if (!resultOutputs) {
      throw new Error("No output after WaveSpeed polling");
    }

    const text = typeof resultOutputs === "string" ? resultOutputs : String(resultOutputs);
    const cost = await queryBilling(resolved, taskId);
    return { text, cost };
  };

  return submitOrResume({
    storedTaskId: resume?.storedTaskId ?? null,
    submit,
    persistId,
    poll,
  });
}
