// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an understand adapter does (design 6.5): send one question with its media to one
 * upstream's native API through provider's own HTTP module, and read the answer. Routing,
 * retries, refusals and costs stay with the caller.
 */

import type { FinishReason, LanguageModelUsage, ProviderMetadata } from "ai";
import type { UpstreamDecl } from "@provider/config/schema.js";
import type { Cost } from "@provider/cost.js";
import { HttpStatus } from "@provider/http/errors.js";
import { deliver, readBody, SNIPPET_CHARS, type OutgoingRequest } from "@provider/http/request.js";
import { parsed } from "@provider/llm/switching.js";

/** One item uploaded to an upstream: its file's address, and its uri once the file is ready. */
export interface UploadedFile {
  url: string;
  uri?: string;
}

/** What one understand call keeps across its attempts (design 6.5). */
export interface UnderstandSession {
  /** The media uploaded to an upstream, by its base url and in item order, for later attempts to reuse. */
  uploads: Map<string, UploadedFile[]>;
  /** Clean-ups to start once the call ends, answered or not; none is waited for. */
  cleanups: (() => void)[];
}

/** One understand request on one upstream. */
export interface UnderstandCall {
  decl: UpstreamDecl;
  key: string;
  /** The id the upstream serves the model under. */
  modelId: string;
  /** The question, already cleaned. */
  question: string;
  media: { bytes: Uint8Array; contentType: string }[];
  maxOutputTokens: number;
  /** OpenRouter's backend pin for the model, when it has one. */
  backend?: { only: string[]; allow_fallbacks: boolean };
  deadlineAt: number;
  signal: AbortSignal;
  /** The size past which Gemini takes media through its Files API, in bytes. */
  inlineMaxBytes: number;
  /** How often an uploaded file's state is asked about, in ms. */
  filePollMs: number;
  session: UnderstandSession;
}

/** The upstream's answer as it came: its status, parsed body and text. */
export interface Answered {
  url: string;
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

/** What a 2xx answer says: the text, or an error it carries with nothing written. */
export type Reading = { text: string; finishReason: FinishReason } | { error: unknown } | { unreadable: string };

/**
 * The upstream answered something provider cannot use (design 3.5): a Files API step
 * that ended without what it promised, or a 2xx model answer that cannot be read. The
 * call stops there; `cost` is what that answer was billed, when it was a model answer.
 */
export class UnreadableAnswer extends Error {
  readonly cost?: Cost;

  /**
   * Record what the error carries.
   * @param reason - What was unusable.
   * @param cost - What the answer was billed, for a model answer.
   */
  constructor(reason: string, cost?: Cost) {
    super(reason);
    this.name = "UnreadableAnswer";
    if (cost !== undefined) this.cost = cost;
  }
}

/** How a 2xx answer is costed: its usage in the AI SDK's buckets and the metadata a cost reads. */
export interface Billing {
  usage: LanguageModelUsage;
  providerMetadata: ProviderMetadata;
  /** The id to look the cost up by later, for an upstream that has one. */
  generationId?: unknown;
}

/** One upstream kind's understand API. */
export interface UnderstandAdapter {
  /**
   * Ask the question, once.
   * @throws {NotSent | NoAnswer | Aborted} As provider's HTTP module classifies a failure to send.
   * @throws {BodyTooLarge} When a preparatory upload step's answer was larger than provider reads.
   * @throws {AnswerUnread} When the model answer's status arrived and its body could not be read.
   * @throws {HttpStatus | UnreadableAnswer} When a preparatory upload step failed or answered something unusable.
   * @throws {Error} For an item whose type the upstream cannot take.
   */
  ask(call: UnderstandCall): Promise<Answered>;
  /** Read a 2xx answer. */
  read(body: unknown): Reading;
  /** How a 2xx answer is costed. */
  billing(body: unknown): Billing;
}

/** The largest answer read, in bytes. */
const MAX_ANSWER_BYTES = 10 * 1024 * 1024;

/** An answer whose status arrived and whose body could not be read; the read's failure is its cause. */
export class AnswerUnread extends Error {
  readonly status: number;

  /**
   * Record what the error carries.
   * @param url - Where the request went.
   * @param status - The status that arrived.
   * @param cause - Why the body could not be read.
   */
  constructor(url: string, status: number, cause: unknown) {
    super(`The answer of ${url} (${status}) could not be read`, { cause });
    this.name = "AnswerUnread";
    this.status = status;
  }
}

/**
 * Send one request once and read its whole answer within the call's bounds; any status
 * comes back. Retries belong to the caller's route, never to this one delivery.
 * @param request - The request.
 * @param call - The call, for its deadline and signal.
 * @returns The answer.
 * @throws {NotSent | NoAnswer | Aborted} As provider's HTTP module classifies a failure to send.
 * @throws {AnswerUnread} When the status arrived and the body could not be read.
 */
export async function exchange(request: OutgoingRequest, call: Pick<UnderstandCall, "deadlineAt" | "signal">): Promise<Answered> {
  const bounds = { replaySafe: false, deadlineAt: call.deadlineAt, signal: call.signal };
  const response = await deliver(request, bounds);
  let bytes: Uint8Array;
  try {
    bytes = await readBody(request.url, response, MAX_ANSWER_BYTES, Math.max(1, call.deadlineAt - Date.now()), bounds);
  } catch (error) {
    throw new AnswerUnread(request.url, response.status, error);
  }
  const text = new TextDecoder().decode(bytes);
  return { url: request.url, status: response.status, body: parsed(text), text, headers: response.headers };
}

/**
 * Throw an answer whose status is not 2xx as HttpStatus, its headers kept for the route's Retry-After.
 * @param answered - The answer.
 * @throws {HttpStatus} When its status is not 2xx.
 */
export function assertSucceeded(answered: Answered): void {
  if (answered.status < 200 || answered.status >= 300) {
    throw new HttpStatus(answered.url, answered.status, answered.text.slice(0, SNIPPET_CHARS), answered.headers);
  }
}

/** The type an upstream is told for a media type it knows by another name; shared's VIDEO_FORMATS. */
const WIRE_TYPES: Readonly<Record<string, string>> = { "video/quicktime": "video/mov" };

/**
 * The type an item is sent as.
 * @param contentType - The item's type.
 * @returns The upstream's name for it.
 */
export function wireTypeOf(contentType: string): string {
  return WIRE_TYPES[contentType] ?? contentType;
}

/**
 * Media bytes as base64.
 * @param bytes - The bytes.
 * @returns Their base64.
 */
export function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * A call's usage filled in the AI SDK's buckets.
 * @param input - Prompt tokens.
 * @param cached - Prompt tokens read from cache.
 * @param output - Output tokens, reasoning included.
 * @param reasoning - Reasoning tokens.
 * @returns The usage in the AI SDK's buckets.
 */
export function usageOf(input: number, cached: number, output: number, reasoning: number): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached, cacheWriteTokens: 0 },
    outputTokens: output,
    outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
    totalTokens: input + output,
  };
}

/**
 * A token count off an answer.
 * @param value - The field.
 * @returns The count, or 0 when it is absent or not finite.
 */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
