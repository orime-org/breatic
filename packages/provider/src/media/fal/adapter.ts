// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * fal's queue: a submit is `POST {base_url}/{model_id}` and answers a request
 * id with the addresses of its status and result, which fal says to use as
 * given; the result is the model's own answer, its files under the binding's
 * `output_field`; what a request cost is its billing events on the platform
 * API (`billing_url`), which the key reads only with billing permission. fal
 * has no client key, so a send whose answer was lost cannot be looked up
 * (recovery `none`).
 */

import { z } from "zod";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { answerText, fetchJson, isSuccess, parsed, send } from "@provider/http/request.js";
import { limits, outputField, type AskContext, type Asked, type MediaAdapter, type Reach, type Refusal, type RequestBounds, type StepCodec, type Submitted } from "@provider/media/adapter.js";
import type { MediaWarning } from "@provider/media/runner.js";

/** How far back a billing lookup reaches; a task's lookups all fall within two hours and the cost wait after it. */
const BILLING_WINDOW_MS = 30 * 24 * 3600 * 1000;

/** What a billing permission refusal costs a lookup: it cannot change by asking again. */
const NO_BILLING_PERMISSION = "FAL_KEY cannot read billing events; it needs the FULL preset or a policy with billing:usage:read, auth:keys:read and account:users:read";

/**
 * The headers of every request.
 * @param reach - The upstream.
 * @returns Key auth and a JSON body type.
 */
function headers(reach: Reach): Record<string, string> {
  return { authorization: `Key ${reach.key}`, "content-type": "application/json" };
}

/** A submit answer, as far as it is read. */
const queuedSchema = z.looseObject({ request_id: z.string().min(1), status_url: z.string().min(1), response_url: z.string().min(1) });

/** A status answer, as far as it is read: an error is present only when the request failed. */
const statusSchema = z.looseObject({ status: z.string(), error: z.unknown().optional() });

/** A billing events answer, as far as it is read. */
const eventsSchema = z.looseObject({ billing_events: z.array(z.looseObject({ cost_total: z.number() })) });

/**
 * Submit one step; resent only on a 408 or 429, which fal did not process.
 * A 2xx whose answer cannot be read is NoAnswer: sent, outcome unknown.
 * @param reach - The upstream.
 * @param endpoint - The model id.
 * @param body - The request body.
 * @param bounds - The deadline and signal.
 * @returns The request id, and the status and result addresses as the handle.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when a 2xx answer cannot be read.
 */
async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted> {
  const url = `${reach.decl.base_url}/${endpoint}`;
  const options = { replaySafe: false, ...bounds };
  const response = await send({ url, method: "POST", headers: headers(reach), body: JSON.stringify(body) }, options);
  const { maxBodyBytes, idleMs } = limits(bounds);
  let text: string;
  try {
    text = await answerText(url, response, maxBodyBytes, idleMs, options);
  } catch (error) {
    throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} accepted the submit and its answer could not be read`, error));
  }
  if (!isSuccess(response.status)) throw new HttpStatus(url, response.status, text);
  const read = queuedSchema.safeParse(parsed(text));
  if (!read.success) throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} answered no request id and addresses it could read`));
  return { predictionId: read.data.request_id, outputs: undefined, handle: { status_url: read.data.status_url, response_url: read.data.response_url } };
}

/**
 * The value at a dotted path of an answer.
 * @param value - The answer.
 * @param path - The path.
 * @returns The value there, or undefined.
 */
function at(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, key) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined), value);
}

/**
 * The file addresses under a result's output field: one file or a list of them.
 * @param result - The model's answer.
 * @param field - The binding's output field.
 * @returns The addresses, in order.
 */
function filesAt(result: unknown, field: string): unknown[] {
  const found = at(result, field);
  return (Array.isArray(found) ? found : [found]).map((file) => (typeof file === "object" && file !== null ? (file as { url?: unknown }).url : undefined));
}

/**
 * fal's words for a failure, as text.
 * @param detail - The error or detail fal gave.
 * @returns The text.
 */
function wordsOf(detail: unknown): string {
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

/**
 * Ask once about a request: its status, and its result once it completed.
 * A completed request that carries an error failed; a result fal refuses with
 * a 4xx is the model's own refusal and fails the run; a 429 or 5xx result is
 * thrown for the runner to ask again.
 * @param reach - The upstream.
 * @param _predictionId - The request id; the handle's addresses name it.
 * @param bounds - The deadline and signal.
 * @param context - The binding, the handle and the step's kind.
 * @returns Whether it is running, done with its outputs, or failed with fal's words.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {Error} When the ticket carries no handle, which every fal submit hands back.
 */
async function ask(reach: Reach, _predictionId: string, bounds: RequestBounds, context: AskContext): Promise<Asked> {
  const handle = context.handle;
  if (handle?.status_url === undefined || handle.response_url === undefined) throw new Error(`${reach.name} has no status and result addresses for this request`);
  const read = { replaySafe: true, ...bounds, ...limits(bounds) };
  const status = statusSchema.safeParse(await fetchJson({ url: handle.status_url, method: "GET", headers: headers(reach) }, read));
  if (!status.success || status.data.status !== "COMPLETED") return { state: "running" };
  if (status.data.error !== undefined && status.data.error !== null) return { state: "failed", error: wordsOf(status.data.error) };
  let result: unknown;
  try {
    result = await fetchJson({ url: handle.response_url, method: "GET", headers: headers(reach) }, read);
  } catch (error) {
    if (error instanceof HttpStatus && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
      return { state: "failed", error: wordsOf((parsed(error.body) as { detail?: unknown } | undefined)?.detail ?? error.bodySnippet) };
    }
    throw error;
  }
  if (context.kind !== "generate") return { state: "done", outputs: [result] };
  return { state: "done", outputs: filesAt(result, context.binding.output_field ?? "") };
}

/**
 * What a request cost, from its billing events over the last 30 days. A key
 * without billing permission makes the cost missing at once: asking again
 * cannot change that.
 * @param reach - The upstream.
 * @param predictionId - The request id.
 * @param bounds - The deadline and signal.
 * @param lastAttempt - Whether no later lookup follows: no event is then missing, not pending.
 * @returns The cost and anything to log.
 */
async function billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }> {
  /**
   * The answer when billing did not say: pending, or missing on the last attempt.
   * @param reason - Why.
   * @returns The cost.
   */
  const unknown = (reason: string): Cost =>
    lastAttempt ? { state: "missing", reason } : { state: "pending", lookup: { upstream: reach.name, predictionId } };
  const start = new Date(Date.now() - BILLING_WINDOW_MS).toISOString();
  const query = new URLSearchParams({ request_id: predictionId, start });
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.billing_url ?? reach.decl.base_url}/models/billing-events?${query.toString()}`, method: "GET", headers: headers(reach) },
      { replaySafe: true, ...bounds, ...limits(bounds) },
    );
  } catch (error) {
    const detail = { upstream: reach.name, predictionId, error: String(error) };
    if (error instanceof HttpStatus && (error.status === 401 || error.status === 403)) {
      return { cost: { state: "missing", reason: NO_BILLING_PERMISSION }, warnings: [{ code: "billing_query_rejected", detail }] };
    }
    const code = error instanceof HttpStatus ? "billing_query_rejected" : "billing_query_failed";
    return { cost: unknown(code), warnings: [{ code, detail }] };
  }
  const read = eventsSchema.safeParse(body);
  if (!read.success || read.data.billing_events.length === 0) {
    return { cost: unknown("billing_query_empty"), warnings: [{ code: "billing_query_empty", detail: { upstream: reach.name, predictionId } }] };
  }
  return { cost: { state: "known", usd: read.data.billing_events.reduce((sum, e) => sum + e.cost_total, 0), source: "billing" }, warnings: [] };
}

/** fal's account lock for an exhausted balance (probed 2026-11-01, a 403). */
const LOCKED = /^User is locked/;
/** fal's answer for an application it does not host (its docs and an unauthenticated probe, a 404). */
const NO_APPLICATION = /^Application ".*" not found$/;

/**
 * What a refused submit says, read fal's way.
 * @param error - The refusal.
 * @returns `insufficient_balance` for the account lock, `model_not_found` for an unknown application, otherwise nothing.
 */
function refusal(error: HttpStatus): Refusal {
  const detail = (parsed(error.body) as { detail?: unknown } | null | undefined)?.detail;
  if (typeof detail !== "string") return undefined;
  if (error.status === 403 && LOCKED.test(detail)) return "insufficient_balance";
  if (error.status === 404 && NO_APPLICATION.test(detail)) return "model_not_found";
  return undefined;
}

/**
 * Mureka's upload on fal: the source sent with its purpose, the upload's id read back.
 * @param purpose - `reference` or `melody`.
 * @returns The step's codec.
 */
function upload(purpose: string): StepCodec {
  return {
    body: (context) => ({ file_url: context.source(), purpose }),
    output: (outputs, context) => ({ param: context.param, id: outputField(outputs, "id") }),
  };
}

/** fal, as the runner and cost lookups reach it. */
export const falAdapter: MediaAdapter = {
  submit,
  ask,
  billed,
  refusal,
  gone: () => false,
  steps: {
    upload_reference: upload("reference"),
    upload_melody: upload("melody"),
    vocal: {
      body: (context) => ({ audio_url: context.source() }),
      output: (outputs, context) => ({ param: context.param, id: outputField(outputs, "vocal_id") }),
    },
  },
};
