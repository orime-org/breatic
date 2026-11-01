// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * SandBase: a submit is `POST {base_url}/run` with the model id beside the
 * fields, and may answer a completed run at once; a run is asked about at
 * `GET /run/{id}`; what it cost is `GET /tasks/{id}/cost` once settled. Its
 * outputs may carry the file inline as a data URI, so its run answers are
 * read up to the caller's media limit. SandBase has no client key, so a send
 * whose answer was lost cannot be looked up (recovery `none`).
 */

import { z } from "zod";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { BodyTooLarge, HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { answerText, fetchJson, isSuccess, parsed, send } from "@provider/http/request.js";
import { inlineLimits, limits, type Asked, type MediaAdapter, type Reach, type Refusal, type RequestBounds, type Submitted } from "@provider/media/adapter.js";
import type { MediaWarning } from "@provider/media/runner.js";

/**
 * The headers of every request.
 * @param reach - The upstream.
 * @returns Bearer auth and a JSON body type.
 */
function headers(reach: Reach): Record<string, string> {
  return { authorization: `Bearer ${reach.key}`, "content-type": "application/json" };
}

/** A run answer, from a submit or a question, as far as it is read. */
const runSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  outputs: z.array(z.looseObject({ url: z.unknown() })).nullish(),
  error: z.unknown().optional(),
});

/** A task cost answer, as far as it is read; `cost` is a decimal string. */
const costSchema = z.looseObject({ settled: z.boolean(), cost: z.coerce.number().nonnegative() });

/** SandBase's error body. */
const errorSchema = z.looseObject({ error: z.string() });

/** What a run answer over the read limit fails with. */
const OVER_LIMIT = "the run's answer is larger than the media limit allows";

/**
 * What a run answer says.
 * @param body - The parsed answer.
 * @returns The id, and the outputs when completed with some, or SandBase's words when it failed.
 */
function readRun(body: unknown): { id: string | undefined; outputs?: unknown[]; error?: string } {
  const read = runSchema.safeParse(body);
  if (!read.success) return { id: undefined };
  const { id, status, outputs, error } = read.data;
  const named = id === "" ? undefined : id;
  if (status === "completed" && (outputs ?? []).length > 0) return { id: named, outputs: outputs!.map((o) => o.url) };
  if (status === "failed" || status === "timeout") {
    const words = typeof error === "string" ? error : error === undefined || error === null ? `the run ended ${status}` : JSON.stringify(error);
    return { id: named, error: words };
  }
  return { id: named };
}

/**
 * Submit one run; resent only on a 408 or 429, which SandBase did not process.
 * An answer over the read limit fails the step, billed under the id its headers name;
 * a 2xx answer that cannot be read otherwise is submitted under that id, or NoAnswer
 * when the headers name none.
 * @param reach - The upstream.
 * @param endpoint - The model id.
 * @param body - The request body.
 * @param bounds - The deadline, signal and media limit.
 * @returns The run id, and the outputs when it completed at once.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when a 2xx answer cannot be read and names no run.
 */
async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted> {
  const url = `${reach.decl.base_url}/run`;
  const options = { replaySafe: false, ...bounds };
  const response = await send({ url, method: "POST", headers: headers(reach), body: JSON.stringify({ model: endpoint, ...body }) }, options);
  const { maxBodyBytes, idleMs } = inlineLimits(bounds);
  const named = response.headers.get("x-task-id") ?? response.headers.get("x-request-id") ?? undefined;
  let text: string;
  try {
    text = await answerText(url, response, maxBodyBytes, idleMs, options);
  } catch (error) {
    if (error instanceof BodyTooLarge) return { predictionId: named, outputs: undefined, error: OVER_LIMIT };
    if (named !== undefined) return { predictionId: named, outputs: undefined };
    throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} accepted the submit and its answer could not be read`, error));
  }
  if (!isSuccess(response.status)) throw new HttpStatus(url, response.status, text);
  const run = readRun(parsed(text));
  const id = run.id ?? named;
  if (id === undefined && run.outputs === undefined && run.error === undefined) throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} answered no run id it could read`));
  return { predictionId: id, outputs: run.outputs, ...(run.error === undefined ? {} : { error: run.error }) };
}

/**
 * Ask once about a run. An answer over the read limit fails the run.
 * @param reach - The upstream.
 * @param predictionId - The run id.
 * @param bounds - The deadline, signal and media limit.
 * @returns Whether it is running, done with its output urls, or failed with SandBase's words.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {SyntaxError} When a 2xx answer is not JSON.
 */
async function ask(reach: Reach, predictionId: string, bounds: RequestBounds): Promise<Asked> {
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.base_url}/run/${encodeURIComponent(predictionId)}`, method: "GET", headers: headers(reach) },
      { replaySafe: true, ...bounds, ...inlineLimits(bounds) },
    );
  } catch (error) {
    if (error instanceof BodyTooLarge) return { state: "failed", error: OVER_LIMIT };
    throw error;
  }
  const run = readRun(body);
  if (run.error !== undefined) return { state: "failed", error: run.error };
  // A completed run may still report no outputs while SandBase stores them.
  return run.outputs === undefined ? { state: "running" } : { state: "done", outputs: run.outputs };
}

/**
 * What a run cost, once SandBase settled it.
 * @param reach - The upstream.
 * @param predictionId - The run id.
 * @param bounds - The deadline and signal.
 * @param lastAttempt - Whether no later lookup follows: an unsettled cost is then missing, not pending.
 * @returns The cost and anything to log.
 */
async function billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }> {
  /**
   * The answer when SandBase did not say: pending, or missing on the last attempt.
   * @param reason - Why.
   * @returns The cost.
   */
  const unknown = (reason: string): Cost =>
    lastAttempt ? { state: "missing", reason } : { state: "pending", lookup: { upstream: reach.name, predictionId } };
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.base_url}/tasks/${encodeURIComponent(predictionId)}/cost`, method: "GET", headers: headers(reach) },
      { replaySafe: true, ...bounds, ...limits(bounds) },
    );
  } catch (error) {
    const detail = { upstream: reach.name, predictionId, error: String(error) };
    // The cost endpoint does not know a run until it is billed.
    if (error instanceof HttpStatus && error.status === 404) return { cost: unknown("billing_query_empty"), warnings: [{ code: "billing_query_empty", detail }] };
    const code = error instanceof HttpStatus ? "billing_query_rejected" : "billing_query_failed";
    return { cost: unknown(code), warnings: [{ code, detail }] };
  }
  const read = costSchema.safeParse(body);
  if (!read.success) return { cost: unknown("billing_query_empty"), warnings: [{ code: "billing_query_empty", detail: { upstream: reach.name, predictionId } }] };
  if (!read.data.settled) return { cost: unknown("billing_unsettled"), warnings: [] };
  return { cost: { state: "known", usd: read.data.cost, source: "billing" }, warnings: [] };
}

/** SandBase's answer for a model it does not serve (a 404). */
const NO_MODEL = /^model not found/;

/**
 * What a refused submit says, read SandBase's way.
 * @param error - The refusal.
 * @returns `insufficient_balance` for a 402, `model_not_found` for an unknown model, otherwise nothing.
 */
function refusal(error: HttpStatus): Refusal {
  if (error.status === 402) return "insufficient_balance";
  const read = errorSchema.safeParse(parsed(error.body));
  if (error.status === 404 && read.success && NO_MODEL.test(read.data.error)) return "model_not_found";
  return undefined;
}

/** SandBase, as the runner and cost lookups reach it; it has no extra steps. */
export const sandbaseAdapter: MediaAdapter = { submit, ask, billed, refusal, gone: () => false, steps: {} };
