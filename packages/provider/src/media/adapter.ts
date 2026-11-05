// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What every media upstream's adapter answers to. The runner, cost lookups and
 * configuration checks reach an upstream only through one of these, picked by
 * the upstream's kind (`adapterOf` in `media/adapters.ts`).
 */

import type { MediaBinding, UpstreamDecl } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { BilledAnswerLost } from "@provider/errors.js";
import { HttpStatus, NoAnswer } from "@provider/http/errors.js";
import { answerText, isSuccess, send, type ReadOptions } from "@provider/http/request.js";
import { buildBody } from "@provider/media/body.js";
import type { MediaWarning, StepKind } from "@provider/media/runner.js";

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
  /** The largest file the caller takes; an answer that may carry files inline is read up to its base64 length. */
  maxMediaBytes?: number;
}

/** What a submit answered. */
export interface Submitted {
  predictionId: string | undefined;
  /** The outputs, when the submit already finished. */
  outputs: unknown[] | undefined;
  /** Data of the adapter's own that later questions about this prediction need; it survives a JSON round trip in the ticket. */
  handle?: Record<string, string>;
  /** Why the step fails although the upstream took it (an answer over the read limit, a run failed at once); it is billed under `predictionId`. */
  error?: string;
}

/** What one question about a prediction answered. */
export type Asked =
  /** `handle` replaces the step's handle for the next question; it survives a JSON round trip in the ticket. */
  | { state: "running"; handle?: Record<string, string> }
  | { state: "done"; outputs: unknown[] }
  | { state: "failed"; error: string };

/** What one step answered, for the steps after it and for billing. */
export interface StepOutput {
  /** The source param an upload or vocal id replaces, and that id. */
  param?: string;
  id?: string;
  voiceId?: string;
  /** An element's place in its pool, and its id. */
  index?: number;
  elementId?: string;
  urls?: string[];
  /** One url, as steps stored it before lists. */
  url?: string;
  /** Whether the id came from the caller's clone cache. */
  cached?: boolean;
  /** The prediction to bill. */
  prediction?: string;
  /** An element's description, as legacy rows stored it. */
  description?: string;
  error?: string;
}

/** What a step of a run needs to write its request and read its answer. */
export interface StepContext {
  /** The source url the step reads from its param. */
  source(): string;
  /** Our params and prompt of the run. */
  params: Readonly<Record<string, unknown>>;
  prompt: string;
  binding: MediaBinding;
  /** The voice id a clone step registers, unique per run. */
  customVoiceId: string;
  /** The cloned voice a speak step speaks with. */
  voiceId: string | undefined;
  /** For an element step: what its describe step wrote. */
  description: string | undefined;
  itemIndex: number | null;
  /** The param the step serves. */
  param: string | undefined;
}

/** How an adapter writes and reads one kind of extra step. */
export interface StepCodec {
  body(context: StepContext): Record<string, unknown>;
  /** @throws {Error} When the outputs lack what the step makes. */
  output(outputs: readonly unknown[], context: StepContext): StepOutput;
}

/** How a refused submit reads: a lasting answer of this upstream, or neither. */
export type Refusal = "model_not_found" | "insufficient_balance" | undefined;

/** What a question about a prediction needs besides its id. */
export interface AskContext {
  binding: MediaBinding;
  /** What the submit handed back for later questions, if it did. */
  handle: Record<string, string> | undefined;
  /** The kind of step asked about: the model's own call reads output files, an extra step its own fields. */
  kind: StepKind;
}

/** One media upstream kind. */
export interface MediaAdapter {
  /** Submit one step of a kind; resent only when the HTTP module knows the upstream did not process it. */
  submit(reach: Reach, endpoint: string, body: Record<string, unknown>, bounds: RequestBounds, kind: StepKind): Promise<Submitted>;
  /** Ask once about a prediction. */
  ask(reach: Reach, predictionId: string, bounds: RequestBounds, context: AskContext): Promise<Asked>;
  /** What a prediction cost: pending when billing has not said yet, missing on the last attempt. */
  billed(reach: Reach, predictionId: string, bounds: RequestBounds, lastAttempt: boolean): Promise<{ cost: Cost; warnings: MediaWarning[] }>;
  /** What a refused submit says, read this upstream's way. */
  refusal(error: HttpStatus): Refusal;
  /** Whether the upstream's failure words say a cached clone is gone. */
  gone(kind: string, message: string, id: string): boolean;
  /** The extra step kinds this upstream speaks, and how. */
  steps: Partial<Record<Exclude<StepKind, "generate" | "describe">, StepCodec>>;
}

/** The largest JSON answer read from a media upstream. */
const MAX_JSON_BYTES = 10 * 1024 * 1024;
/** How long a JSON answer may stall when no deadline bounds it (a final ask). */
const FINAL_ASK_IDLE_MS = 60_000;

/**
 * The read limits of one JSON request to a media upstream.
 * @param bounds - The request's bounds.
 * @returns Byte and idle limits.
 */
export function limits(bounds: RequestBounds): { maxBodyBytes: number; idleMs: number } {
  const idleMs = bounds.deadlineAt === undefined ? FINAL_ASK_IDLE_MS : Math.max(1, bounds.deadlineAt - Date.now());
  return { maxBodyBytes: MAX_JSON_BYTES, idleMs };
}

/**
 * The options of a replay-safe JSON read (a poll, a result or a billing query) within the JSON read limits.
 * @param bounds - The request's bounds.
 * @returns The options.
 */
export function readOptions(bounds: RequestBounds): ReadOptions {
  return { replaySafe: true, ...bounds, ...limits(bounds) };
}

/**
 * Submit a JSON body once (`replaySafe: false`) and read the answer's text within the JSON read limits.
 * @param reach - The upstream.
 * @param url - The submit address.
 * @param body - The request body.
 * @param headers - The request headers.
 * @param bounds - The deadline and signal.
 * @returns The text of a 2xx answer.
 * @throws {NotSent | NoAnswer | HttpStatus | Aborted} As the HTTP module classifies the failure.
 * @throws {NoAnswer} With a BilledAnswerLost cause carrying one missing cost, when the answer cannot be read.
 * @throws {HttpStatus} When the upstream answered a non-2xx status.
 */
export async function submitText(reach: Reach, url: string, body: Record<string, unknown>, headers: Record<string, string>, bounds: RequestBounds): Promise<string> {
  const options = { replaySafe: false, ...bounds };
  const response = await send({ url, method: "POST", headers, body: JSON.stringify(body) }, options);
  const { maxBodyBytes, idleMs } = limits(bounds);
  let text: string;
  try {
    text = await answerText(url, response, maxBodyBytes, idleMs, options);
  } catch (error) {
    throw new NoAnswer(url, new BilledAnswerLost(`${reach.name} accepted the submit and its answer could not be read`, error));
  }
  if (!isSuccess(response.status)) throw new HttpStatus(url, response.status, text);
  return text;
}

/** Room for the JSON around an inline file in an answer. */
const INLINE_ANSWER_ROOM_BYTES = 2048;

/**
 * The read limits of a request whose answer may carry a file inline: the caller's media
 * limit as base64 and the JSON around it, or the fixed limit when the caller gave none.
 * @param bounds - The request's bounds.
 * @returns Byte and idle limits.
 */
export function inlineLimits(bounds: RequestBounds): { maxBodyBytes: number; idleMs: number } {
  const read = limits(bounds);
  if (bounds.maxMediaBytes === undefined) return read;
  return { ...read, maxBodyBytes: Math.ceil(bounds.maxMediaBytes / 3) * 4 + INLINE_ANSWER_ROOM_BYTES };
}

/**
 * A step's first structured output field.
 * @param outputs - The prediction's outputs.
 * @param field - The field.
 * @returns Its value.
 * @throws {Error} When the output carries no such string.
 */
export function outputField(outputs: readonly unknown[], field: string): string {
  const first = outputs[0];
  const value = typeof first === "object" && first !== null ? (first as Record<string, unknown>)[field] : undefined;
  if (typeof value !== "string" || value === "") throw new Error(`No ${field} in the upstream answer`);
  return value;
}

/**
 * Every output as a url.
 * @param outputs - The prediction's outputs.
 * @returns The urls.
 * @throws {Error} When there is none, or one is not a url.
 */
export function outputUrls(outputs: readonly unknown[]): string[] {
  if (outputs.length === 0 || !outputs.every((u): u is string => typeof u === "string" && u !== "")) {
    throw new Error("The upstream answered no output url");
  }
  return [...outputs];
}

/**
 * What a billing lookup answers when the upstream did not say what a prediction cost.
 * @param reach - The upstream.
 * @param predictionId - The prediction.
 * @param lastAttempt - Whether no later lookup follows.
 * @param reason - Why the upstream did not say.
 * @returns Missing on the last attempt, otherwise a lookup to ask again with.
 */
export function unbilled(reach: Reach, predictionId: string, lastAttempt: boolean, reason: string): Cost {
  return lastAttempt ? { state: "missing", reason } : { state: "pending", lookup: { upstream: reach.name, predictionId } };
}

/**
 * The warning code of a billing query that failed.
 * @param error - What the query threw.
 * @returns `billing_query_rejected` when the upstream answered a status, `billing_query_failed` otherwise.
 */
export function billingFailure(error: unknown): "billing_query_rejected" | "billing_query_failed" {
  return error instanceof HttpStatus ? "billing_query_rejected" : "billing_query_failed";
}

/**
 * The headers of an upstream that takes its key as a bearer token.
 * @param reach - The upstream.
 * @returns Bearer auth and a JSON body type.
 */
export function bearerHeaders(reach: Reach): Record<string, string> {
  return { authorization: `Bearer ${reach.key}`, "content-type": "application/json" };
}

/**
 * Whether MiniMax's words say a voice id it once gave is gone (probed on WaveSpeed 2026-09-28); a
 * reseller passes MiniMax's error through.
 * @param message - The upstream's words.
 * @returns True when the voice is gone.
 */
export function minimaxVoiceGone(message: string): boolean {
  return /Voice ID does not exist/.test(message);
}

/**
 * MiniMax's clone on a reseller that makes the voice id and answers it. The clone's preview text is
 * not sent: the speak step after it says the run's text.
 */
export const resellerVoiceClone: StepCodec = {
  body: (context) => buildBody(context.binding, { params: context.params, prompt: "" }),
  output: (outputs) => ({ voiceId: outputField(outputs, "custom_voice_id") }),
};
