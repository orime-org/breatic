// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What an understand adapter does (design 6.5): send one question with its media to one
 * upstream's native API through provider's own HTTP module, and read the answer. Routing,
 * retries, refusals and costs stay with the caller.
 */

import type { FinishReason, LanguageModelUsage, ProviderMetadata } from "ai";
import type { UpstreamDecl } from "@provider/config/schema.js";
import { readBody, send, type OutgoingRequest } from "@provider/http/request.js";

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
}

/** The upstream's answer as it came: its status, parsed body and text. */
export interface Answered {
  url: string;
  status: number;
  body: unknown;
  text: string;
}

/** What a 2xx answer says: the text, or an error it carries with nothing written. */
export type Reading = { text: string; finishReason: FinishReason } | { error: unknown };

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
   * Ask the question.
   * @throws {NotSent | NoAnswer | Aborted | HttpStatus} As provider's HTTP module classifies the failure.
   */
  ask(call: UnderstandCall): Promise<Answered>;
  /** Read a 2xx answer. */
  read(body: unknown): Reading;
  /** How a 2xx answer is costed. */
  billing(body: unknown): Billing;
}

/** The largest answer read, in bytes. */
const MAX_ANSWER_BYTES = 10 * 1024 * 1024;

/**
 * Send one request and read its whole answer within the call's bounds; any status comes back.
 * @param request - The request.
 * @param call - The call, for its deadline and signal.
 * @returns The answer.
 * @throws {NotSent | NoAnswer | Aborted | BodyTooLarge} As provider's HTTP module classifies the failure.
 */
export async function exchange(request: OutgoingRequest, call: Pick<UnderstandCall, "deadlineAt" | "signal">): Promise<Answered & { headers: Headers }> {
  const bounds = { replaySafe: false, deadlineAt: call.deadlineAt, signal: call.signal };
  const response = await send(request, bounds);
  const bytes = await readBody(request.url, response, MAX_ANSWER_BYTES, Math.max(1, call.deadlineAt - Date.now()), bounds);
  const text = new TextDecoder().decode(bytes);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  return { url: request.url, status: response.status, body, text, headers: response.headers };
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
 * An empty usage to fill.
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
