// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * SandBase: a submit is `POST {base_url}/run` with the model id beside the
 * fields, and may answer a completed run at once; a run is asked about at
 * `GET /run/{id}`; what it cost is `GET /tasks/{id}/cost` once settled. Its
 * outputs may carry the file inline as a data URI, so its run answers are
 * read up to the caller's media limit. A run answered completed without outputs
 * is waited for up to the upstream's `empty_output_wait_ms`, its first such
 * answer kept in the step's handle. SandBase has no client key, so a send
 * whose answer was lost cannot be looked up: the runner's `recover` hands it
 * back to be sent again and warns `potential_duplicate_cost`.
 */

import { z } from "zod";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { BodyTooLarge, HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { answerText, fetchJson, isSuccess, parsed, send } from "@provider/http/request.js";
import {
  bearerHeaders as headers,
  billingFailure,
  inlineLimits,
  readOptions,
  minimaxVoiceGone,
  outputField,
  resellerVoiceClone,
  unbilled,
  type AskContext,
  type Asked,
  type MediaAdapter,
  type Reach,
  type Refusal,
  type RequestBounds,
  type Submitted,
} from "@provider/media/adapter.js";
import type { MediaWarning, StepKind } from "@provider/media/runner.js";

/** A run answer, from a submit or a question, as far as it is read. */
const runSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
  outputs: z.array(z.looseObject({ url: z.unknown() })).nullish(),
  error: z.unknown().optional(),
});

/**
 * A task cost answer, as far as it is read: `cost` is a decimal string or a finite number; anything else (null, "",
 * false, a list, "n/a") fails the read and leaves the cost pending.
 */
const costSchema = z.looseObject({
  settled: z.boolean(),
  cost: z.union([z.number().nonnegative(), z.string().trim().regex(/^\d+(\.\d+)?$/).transform(Number)]),
});

/** SandBase's error body. */
const errorSchema = z.looseObject({ error: z.string() });

/** What a run answer over the read limit fails with. */
const OVER_LIMIT = "the run's answer is larger than the media limit allows";

/** The handle key holding when, in epoch ms, the run first answered completed without outputs. */
const EMPTY_SINCE = "completed_empty_since";

/**
 * What a run answer says. The model's own call reads its output urls; an extra step reads
 * the output items whole, for the fields it needs (a voice clone's `custom_voice_id`).
 * @param body - The parsed answer.
 * @param kind - The kind of step the run serves.
 * @returns The id, and the outputs when completed with some, whether it completed without any, or SandBase's words when it failed.
 */
function readRun(body: unknown, kind: StepKind): { id: string | undefined; outputs?: unknown[]; empty?: true; error?: string } {
  const read = runSchema.safeParse(body);
  if (!read.success) return { id: undefined };
  const { id, status, outputs, error } = read.data;
  const named = id === "" ? undefined : id;
  if (status === "completed") {
    if ((outputs ?? []).length === 0) return { id: named, empty: true };
    return { id: named, outputs: kind === "generate" ? outputs!.map((o) => o.url) : outputs! };
  }
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
 * @param kind - The kind of step the run serves.
 * @returns The run id, and the outputs when it completed at once.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when a 2xx answer cannot be read and names no run.
 */
async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds, kind: StepKind): Promise<Submitted> {
  const url = `${reach.decl.base_url}/run`;
  const options = { replaySafe: false, ...bounds };
  const response = await send({ url, method: "POST", headers: headers(reach), body: JSON.stringify({ ...body, model: endpoint }) }, options);
  const { maxBodyBytes, idleMs } = inlineLimits(bounds);
  const named = response.headers.get("x-task-id") || response.headers.get("x-request-id") || undefined;
  let text: string;
  try {
    text = await answerText(url, response, maxBodyBytes, idleMs, options);
  } catch (error) {
    if (error instanceof BodyTooLarge) return { predictionId: named, outputs: undefined, error: OVER_LIMIT };
    if (named !== undefined) return { predictionId: named, outputs: undefined };
    throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} accepted the submit and its answer could not be read`, error));
  }
  if (!isSuccess(response.status)) throw new HttpStatus(url, response.status, text);
  const run = readRun(parsed(text), kind);
  const id = run.id ?? named;
  if (id === undefined && run.outputs === undefined && run.error === undefined) throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} answered no run id it could read`));
  return { predictionId: id, outputs: run.outputs, ...(run.error === undefined ? {} : { error: run.error }) };
}

/**
 * Ask once about a run. An answer over the read limit fails the run. A run completed without outputs
 * may still be storing them, so it is running until `empty_output_wait_ms` has passed since it first
 * answered so, and then failed.
 * @param reach - The upstream.
 * @param predictionId - The run id.
 * @param bounds - The deadline, signal and media limit.
 * @param context - The kind of step asked about and the handle of an earlier answer.
 * @returns Whether it is running (with the handle to keep the first time it answers completed without outputs), done with its outputs, or failed with SandBase's words.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {SyntaxError} When a 2xx answer is not JSON.
 */
async function ask(reach: Reach, predictionId: string, bounds: RequestBounds, context: AskContext): Promise<Asked> {
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
  const run = readRun(body, context.kind);
  if (run.error !== undefined) return { state: "failed", error: run.error };
  if (run.outputs !== undefined) return { state: "done", outputs: run.outputs };
  if (run.empty !== true) return { state: "running" };
  const since = context.handle?.[EMPTY_SINCE];
  // The handle changes only on the first such answer, so later polls hand back no new ticket.
  if (since === undefined) return { state: "running", handle: { ...context.handle, [EMPTY_SINCE]: String(Date.now()) } };
  const wait = reach.decl.empty_output_wait_ms;
  if (Date.now() - Number(since) >= wait) return { state: "failed", error: `SandBase completed the run with no output, still none after ${wait} ms` };
  return { state: "running" };
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
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.base_url}/tasks/${encodeURIComponent(predictionId)}/cost`, method: "GET", headers: headers(reach) },
      readOptions(bounds),
    );
  } catch (error) {
    const detail = { upstream: reach.name, predictionId, error: String(error) };
    // The cost endpoint does not know a run until it is billed.
    if (error instanceof HttpStatus && error.status === 404) return { cost: unbilled(reach, predictionId, lastAttempt, "billing_query_empty"), warnings: [{ code: "billing_query_empty", detail }] };
    const code = billingFailure(error);
    return { cost: unbilled(reach, predictionId, lastAttempt, code), warnings: [{ code, detail }] };
  }
  const read = costSchema.safeParse(body);
  if (!read.success) return { cost: unbilled(reach, predictionId, lastAttempt, "billing_query_empty"), warnings: [{ code: "billing_query_empty", detail: { upstream: reach.name, predictionId } }] };
  if (!read.data.settled) return { cost: unbilled(reach, predictionId, lastAttempt, "billing_unsettled"), warnings: [] };
  return { cost: { state: "known", usd: read.data.cost, source: "billing" }, warnings: [] };
}

/** SandBase's answer for a model it does not serve (a 404). */
const NO_MODEL = /^model not found/;

/** SandBase's answer for a model the account's plan does not cover (a 403, measured on a free account 2026-11-06). */
const NOT_ON_PLAN = "This model is not available to free users.";

/**
 * What a refused submit says, read SandBase's way.
 * @param error - The refusal.
 * @returns `insufficient_balance` for a 402 or a model the account's plan leaves out, `model_not_found` for an unknown
 *   model, otherwise nothing.
 */
function refusal(error: HttpStatus): Refusal {
  if (error.status === 402) return "insufficient_balance";
  const read = errorSchema.safeParse(parsed(error.body));
  if (error.status === 403 && read.success && read.data.error === NOT_ON_PLAN) return "insufficient_balance";
  if (error.status === 404 && read.success && NO_MODEL.test(read.data.error)) return "model_not_found";
  return undefined;
}

/** SandBase, as the runner and cost lookups reach it. */
export const sandbaseAdapter: MediaAdapter = {
  submit,
  ask,
  billed,
  refusal,
  gone: (kind, message) => kind === "voice" && minimaxVoiceGone(message),
  steps: {
    voice: resellerVoiceClone,
    speak: {
      body: (context) => ({ text: context.prompt, voice_id: context.voice() }),
      output: (outputs) => ({ urls: [outputField(outputs, "url")] }),
    },
  },
};
