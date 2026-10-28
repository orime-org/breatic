// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * WaveSpeed (design 6.2): a submit is `POST {base_url}/{model_id}` and may
 * answer the outputs at once; a prediction is asked about at
 * `GET /predictions/{id}/result`; what it cost is a billing search. The
 * upstream has no client key, so a send whose answer was lost cannot be
 * looked up (recovery `none`).
 */

import { z } from "zod";
import type { UpstreamDecl } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { fetchJson, readBody, send } from "@provider/http/request.js";
import type { MediaWarning } from "@provider/media/runner.js";
import { readBilling } from "@provider/media/wavespeed/billing.js";

/** One upstream as a call reaches it. */
export interface Reach {
  name: string;
  decl: UpstreamDecl;
  key: string;
}

/** The bounds of one request. */
export interface RequestBounds {
  /** Epoch ms after which nothing is sent; absent for a final ask. */
  deadlineAt?: number;
  signal?: AbortSignal;
}

/** What a submit answered. */
export interface Submitted {
  predictionId: string | undefined;
  /** The outputs, when the submit already finished. */
  outputs: unknown[] | undefined;
}

/** What one question about a prediction answered. */
export type Asked = { state: "running" } | { state: "done"; outputs: unknown[] } | { state: "failed"; error: string };

/** The largest JSON answer read from the upstream. */
const MAX_JSON_BYTES = 10 * 1024 * 1024;
/** How long a JSON answer may stall when no deadline bounds it (a final ask). */
const FINAL_ASK_IDLE_MS = 60_000;

/**
 * How the upstream says a cloned id it once gave is gone, by clone kind (the
 * error text probed 2026-09-28 for voice, 2026-09-29 for element). Mureka
 * answers an unknown vocal with the words it uses for any refused input, so
 * vocal has no rule.
 */
const GONE: Readonly<Partial<Record<string, (message: string, id: string) => boolean>>> = {
  voice: (message) => /Voice ID does not exist/.test(message),
  element: (message, id) => /Element id not found: (\S+)/.exec(message)?.[1] === id,
};

/**
 * The read limits of one JSON request.
 * @param bounds - The request's bounds.
 * @returns Byte and idle limits.
 */
function limits(bounds: RequestBounds): { maxBodyBytes: number; idleMs: number } {
  const idleMs = bounds.deadlineAt === undefined ? FINAL_ASK_IDLE_MS : Math.max(1, bounds.deadlineAt - Date.now());
  return { maxBodyBytes: MAX_JSON_BYTES, idleMs };
}

/**
 * The headers of every request.
 * @param reach - The upstream.
 * @returns Bearer auth and a JSON body type.
 */
function headers(reach: Reach): Record<string, string> {
  return { authorization: `Bearer ${reach.key}`, "content-type": "application/json" };
}

/** A submit answer, as far as it is read. */
const submittedSchema = z.looseObject({
  data: z.looseObject({ id: z.string().optional(), outputs: z.array(z.unknown()).nullish() }),
});

/**
 * A prediction's result answer, as far as it is read. Like today's poll, a part it cannot
 * read reads as absent: no readable status is still running, outputs that are not a list none.
 */
const resultSchema = z.looseObject({
  data: z.looseObject({
    status: z.string().optional().catch(undefined),
    outputs: z.array(z.unknown()).optional().catch(undefined),
    error: z.unknown().optional(),
  }).optional().catch(undefined),
});

/**
 * JSON text parsed, or undefined when it is not JSON.
 * @param text - The text.
 * @returns The value.
 */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Submit one prediction; resent only on a 408 or 429, which the upstream did not process.
 * A 2xx whose answer cannot be read (cut, not JSON, no id and no outputs) is NoAnswer: sent,
 * outcome unknown (design 3.4).
 * @param reach - The upstream.
 * @param endpoint - The model path.
 * @param body - The request body.
 * @param bounds - The deadline and signal.
 * @returns The prediction id, and the outputs when it finished at once.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted | BodyTooLarge} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when a 2xx answer cannot be read.
 */
export async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted> {
  const url = `${reach.decl.base_url}/${endpoint}`;
  const options = { replaySafe: false, ...bounds };
  const response = await send({ url, method: "POST", headers: headers(reach), body: JSON.stringify(body) }, options);
  const ok = response.status >= 200 && response.status < 300;
  const { maxBodyBytes, idleMs } = limits(bounds);
  let text: string;
  try {
    text = new TextDecoder().decode(await readBody(url, response, maxBodyBytes, idleMs, options));
  } catch (error) {
    if (!ok) throw error;
    throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} accepted the submit and its answer could not be read`, error));
  }
  if (!ok) throw new HttpStatus(url, response.status, text);
  const parsed = submittedSchema.safeParse(jsonOf(text));
  const id = parsed.success && parsed.data.data.id !== "" ? parsed.data.data.id : undefined;
  const outputs = parsed.success && (parsed.data.data.outputs ?? []).length > 0 ? parsed.data.data.outputs! : undefined;
  if (id === undefined && outputs === undefined) throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} answered no prediction id and no outputs it could read`));
  return { predictionId: id, outputs };
}

/**
 * Ask once about a prediction.
 * @param reach - The upstream.
 * @param predictionId - The prediction.
 * @param bounds - The deadline and signal.
 * @returns Whether it is running, done with its outputs, or failed with the upstream's words.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {SyntaxError} When a 2xx answer is not JSON.
 */
export async function ask(reach: Reach, predictionId: string, bounds: RequestBounds): Promise<Asked> {
  const answer = await fetchJson(
    { url: `${reach.decl.base_url}/predictions/${encodeURIComponent(predictionId)}/result`, method: "GET", headers: headers(reach) },
    { replaySafe: true, ...bounds, ...limits(bounds) },
  );
  const parsed = resultSchema.safeParse(answer);
  const data = parsed.success ? parsed.data.data : undefined;
  if (data === undefined) return { state: "running" };
  if (data.status === "completed") return { state: "done", outputs: data.outputs ?? [] };
  // As today's poll: the upstream's error as text whatever its type, "unknown" when it gave none.
  if (data.status === "failed") return { state: "failed", error: data.error === undefined || data.error === null ? "unknown" : String(data.error) };
  return { state: "running" };
}

/**
 * What a finished prediction cost, from the billing search.
 * @param reach - The upstream.
 * @param predictionId - The prediction.
 * @param bounds - The deadline and signal.
 * @param lastAttempt - Whether no later lookup follows: an answer without a total is then missing, not pending.
 * @returns The cost and anything to log.
 */
export async function billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }> {
  /**
   * The answer when billing did not say: pending, or missing on the last attempt.
   * @param reason - Why.
   * @returns The cost.
   */
  const unknown = (reason: string): Cost =>
    lastAttempt ? { state: "missing", reason } : { state: "pending", lookup: { upstream: reach.name, predictionId } };
  let body: unknown;
  try {
    body = await fetchJson(
      { url: `${reach.decl.base_url}/billings/search`, method: "POST", headers: headers(reach), body: JSON.stringify({ prediction_uuids: [predictionId] }) },
      { replaySafe: true, ...bounds, ...limits(bounds) },
    );
  } catch (error) {
    const code = error instanceof HttpStatus ? "billing_query_rejected" : "billing_query_failed";
    return { cost: unknown(code), warnings: [{ code, detail: { upstream: reach.name, predictionId, error: String(error) } }] };
  }
  const read = readBilling(body);
  if (read.kind === "none") {
    return { cost: unknown("billing_query_empty"), warnings: [...read.warnings, { code: "billing_query_empty", detail: { upstream: reach.name, predictionId } }] };
  }
  return { cost: { state: "known", usd: read.usd, source: "billing" }, warnings: read.warnings };
}

/** WaveSpeed's message for a model id it does not serve (measured 2026-10-26, a 400). */
const MODEL_NOT_FOUND = "Model not found.";

/**
 * Whether a refused submit says the upstream has no such model, rather than
 * refusing the request's params: both are 400s, told apart by the message.
 * @param error - The refusal.
 * @returns True for WaveSpeed's model-not-found answer.
 */
export function modelNotFound(error: HttpStatus): boolean {
  if (error.status !== 400) return false;
  try {
    return (JSON.parse(error.body) as { message?: unknown } | null)?.message === MODEL_NOT_FOUND;
  } catch {
    return false;
  }
}

/**
 * Whether the upstream's failure says a cached clone is gone.
 * @param kind - The clone's kind.
 * @param message - The upstream's words.
 * @param id - The clone's upstream id.
 * @returns True when the clone should be retired.
 */
export function gone(kind: string, message: string, id: string): boolean {
  return GONE[kind]?.(message, id) === true;
}
