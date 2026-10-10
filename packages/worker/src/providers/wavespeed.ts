// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * WaveSpeed, the one upstream every catalog model runs on (#2156).
 *
 * A run is one prediction:
 *
 *     POST {base_url}/{model_id}                     ->  {"data": {"id": "...", "outputs": [...]}}
 *     GET  {base_url}/predictions/{task_id}/result   ->  asked once per pickup
 *
 * The body is sent as the caller built it: the upstream field names come
 * from the model's declaration, not from here.
 */

import type { ResumeContext } from "@worker/providers/shared.js";
import { submitOrResume } from "@worker/providers/async-resume.js";
import { bearerHeaders, requestWithRetry, pollOnce, extractNested } from "@worker/providers/http.js";

/** Where predictions are sent and how long one may take. */
export interface WavespeedEndpoint {
  baseUrl: string;
  apiKey: string;
  /** Seconds. */
  timeout: number;
}

/** What a finished prediction answered. */
export interface PredictionRun {
  /** The prediction's `outputs`, in the order WaveSpeed gave them. */
  outputs: readonly unknown[];
  /** The prediction id to bill, or `""` for a sync answer that carried none. */
  taskId: string;
}

/**
 * The `outputs` of a WaveSpeed response, when it carries any.
 * @param data - A submit or poll response.
 * @returns The outputs, or undefined when there are none.
 */
function outputsOf(data: Record<string, unknown>): unknown[] | undefined {
  const outputs = extractNested(data, ["data", "outputs"]);
  return Array.isArray(outputs) && outputs.length > 0 ? outputs : undefined;
}

/**
 * Submit a prediction, or ask once about the one already submitted. Submit is
 * at-most-once across pickups (#1628): with a stored id the POST is skipped;
 * a fresh run stores the returned id before it asks. A submit response that
 * already carries outputs is the answer, and nothing is asked.
 * @param endpoint - Base url, key and timeout.
 * @param modelId - The WaveSpeed model path, e.g. `minimax/speech-2.8-hd`.
 * @param body - The request body, sent verbatim.
 * @param resume - Worker resume context: the stored id, and where a new one is stored.
 * @returns The prediction's outputs and its id.
 * @throws {StillRunning} when the prediction is still going, or the question
 *   about it got no usable answer.
 * @throws {Error} when the submit response carries neither an id nor outputs,
 *   or the prediction fails.
 */
export async function runPrediction(
  endpoint: WavespeedEndpoint,
  modelId: string,
  body: Readonly<Record<string, unknown>>,
  resume: ResumeContext,
): Promise<PredictionRun> {
  const headers = bearerHeaders(endpoint.apiKey);
  let syncAnswer: Record<string, unknown> | null = null;

  /**
   * Submit the prediction.
   * @returns The prediction id, or `""` for a sync answer without one.
   * @throws {Error} when the response carries neither an id nor outputs.
   */
  const submit = async (): Promise<string> => {
    const data = await requestWithRetry(
      `${endpoint.baseUrl}/${modelId}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      "wavespeed",
      endpoint.timeout * 1000,
    );
    const taskId = extractNested(data, ["data", "id"]) as string | undefined;
    if (outputsOf(data)) {
      syncAnswer = data;
      return taskId ?? "";
    }
    if (!taskId) throw new Error("No task ID or outputs in WaveSpeed response");
    return taskId;
  };

  /**
   * Ask once about the prediction, or hand back the sync answer.
   * @param taskId - The prediction id.
   * @returns The terminal response and the id it answered for.
   */
  const poll = async (taskId: string): Promise<{ data: Record<string, unknown>; taskId: string }> => ({
    data:
      syncAnswer ??
      (await pollOnce(`${endpoint.baseUrl}/predictions/${taskId}/result`, {
        headers,
        statusPath: ["data", "status"],
        successStatuses: new Set(["completed"]),
        failureStatuses: new Set(["failed"]),
        errorPath: ["data", "error"],
        provider: "wavespeed",
      })),
    taskId,
  });

  const result = await submitOrResume({
    storedTaskId: resume.storedTaskId,
    retryStarting: resume.retryStarting,
    label: resume.externalTaskId,
    submit,
    // A sync answer's "" is not an id: storing it would make a retry poll
    // a prediction that does not exist.
    persistId: async (id: string): Promise<void> => {
      if (id !== "") await resume.persistTaskId(id);
    },
    poll,
  });

  return { outputs: outputsOf(result.data) ?? [], taskId: result.taskId };
}
