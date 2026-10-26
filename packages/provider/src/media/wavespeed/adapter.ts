// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * WaveSpeed (design 6.2): a submit is `POST {base_url}/{model_id}` and may
 * answer the outputs at once; a prediction is asked about at
 * `GET /predictions/{id}/result`; what it cost is a billing search. The
 * upstream has no client key, so a send whose answer was lost cannot be
 * looked up (recovery `none`).
 */

import type { UpstreamDecl } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { HttpStatus } from "@provider/http/errors.js";
import { fetchJson } from "@provider/http/request.js";
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

/**
 * The `data` object of an answer.
 * @param body - The parsed answer.
 * @returns Its data, or an empty object.
 */
function dataOf(body: unknown): Record<string, unknown> {
  const data = (body as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

/**
 * Submit one prediction; never sent twice.
 * @param reach - The upstream.
 * @param endpoint - The model path.
 * @param body - The request body.
 * @param bounds - The deadline and signal.
 * @returns The prediction id, and the outputs when it finished at once.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {Error} When the answer carries neither an id nor outputs.
 */
export async function submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds): Promise<Submitted> {
  const answer = await fetchJson(
    { url: `${reach.decl.base_url}/${endpoint}`, method: "POST", headers: headers(reach), body: JSON.stringify(body) },
    { replaySafe: false, ...bounds, ...limits(bounds) },
  );
  const data = dataOf(answer.body);
  const id = typeof data.id === "string" && data.id !== "" ? data.id : undefined;
  const outputs = Array.isArray(data.outputs) && data.outputs.length > 0 ? (data.outputs as unknown[]) : undefined;
  if (id === undefined && outputs === undefined) throw new Error(`${reach.name} answered no prediction id and no outputs`);
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
  const data = dataOf(answer.body);
  if (data.status === "completed") return { state: "done", outputs: Array.isArray(data.outputs) ? (data.outputs as unknown[]) : [] };
  if (data.status === "failed") return { state: "failed", error: typeof data.error === "string" ? data.error : "unknown" };
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
    body = (await fetchJson(
      { url: `${reach.decl.base_url}/billings/search`, method: "POST", headers: headers(reach), body: JSON.stringify({ prediction_uuids: [predictionId] }) },
      { replaySafe: true, ...bounds, ...limits(bounds) },
    )).body;
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
