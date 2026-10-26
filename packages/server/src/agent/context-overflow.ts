// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling a provider's "the prompt is over the context window" apart from
 * every other failed model call (inner#1567, design 6.3).
 *
 * OpenRouter forwards each upstream's own wording and adds no common error
 * type of its own (the H1 and H2 probes carried none), so the wording is what
 * there is to go on. The wording list and its exclusions are OpenCode's, and
 * only an `APICallError` with status 400 is read: a 413 is a byte limit that a
 * fold cannot shrink, a 429 or a 402 is not about length at all, and an error
 * of our own carrying the same words is not a provider's answer.
 */

import { APICallError, RetryError } from "ai";

/*
 * The `patterns` and `exclusions` lists below are copied from OpenCode,
 * packages/ai/src/provider-error.ts at commit
 * 16cd50db2278fc9b780808e44d40d1ceaf2f5e80
 * (https://github.com/anomalyco/opencode), less its `request_too_large`
 * entry (a byte limit, not a token one), with its one CJK entry written as
 * escapes. Used under the MIT License:
 *
 * Copyright (c) 2025 opencode
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const patterns = [
  /prompt is too long/i,
  /input is too long for (?:the )?(?:requested|selected) model/i,
  // OpenCode Go
  /too large for the model'?s configured input limit/i,
  // Cloudflare Workers AI reports this as HTTP 413.
  /exceeded this model context window limit/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  // Amazon Nova on Bedrock reports this as a mid-stream validationException.
  /number of input tokens exceeds maximum length/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  // DeepInfra
  /requested input length \d+ exceeds maximum input length/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  // Novita omits the token counts.
  /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  // Hugging Face Text Generation Inference, e.g. Together
  /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  // Z.ai code 1261 arrives as `Prompt too long`, `Prompt exceeds max length` or `Prompt` followed by the Chinese for "too long".
  /prompt (?:too long|exceeds max length|\u8d85\u957f)/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /range of input length should be/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

const exclusions = [
  /^(throttling error|service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
  // Cohere reports an output limit above the model maximum as "too many tokens"; compaction cannot fix it.
  /max[_ ]tokens must be less than/i,
  // Bedrock phrases throttling as "Too many tokens[, per day], please wait..."; it is a 429 to retry, not overflow.
  /too many tokens(?: per day)?, please wait/i,
];
/* End of the lists copied from OpenCode. */

/** The prompt sizes the wordings state, first match wins; `tokens` reads one that is not stated outright. */
const COUNTS: Array<{ pattern: RegExp; lowerBound: boolean; tokens?: (found: RegExpExecArray) => number }> = [
  { pattern: /contains at least (\d+) input tokens/i, lowerBound: true },
  { pattern: /contains (\d+) input tokens/i, lowerBound: false },
  { pattern: /resulted in (\d+) tokens/i, lowerBound: false },
  { pattern: /prompt is too long: (\d+) tokens/i, lowerBound: false },
  { pattern: /input token count \(?(\d+)\)?/i, lowerBound: false },
  // OpenRouter's own check, which counts the output reserve in (H8):
  // "you requested about 145147 tokens (128763 of text input, 16384 in the output)".
  {
    pattern: /requested about (\d+) tokens \(.*?(\d+) in the output\)/i,
    lowerBound: false,
    tokens: (found) => Number(found[1]) - Number(found[2]),
  },
];

/** A recognised overflow, and the prompt size the provider stated, when it did. */
export interface ContextOverflow {
  /** The prompt's size in tokens, as the provider said it. */
  tokens?: number;
  /** The size is "at least" this many: the provider stopped counting at the window. */
  lowerBound: boolean;
}

/**
 * Whether a piece of provider text reads as an overflow.
 * @param text - A message or a response body.
 * @returns True when it matches the list and no exclusion.
 * @throws {never} Never.
 */
function readsAsOverflow(text: string): boolean {
  return !exclusions.some((pattern) => pattern.test(text)) && patterns.some((pattern) => pattern.test(text));
}

/**
 * The prompt size one of the texts states.
 * @param texts - The message and the body.
 * @returns The size, or nothing when none states it.
 * @throws {never} Never.
 */
function statedCount(texts: readonly string[]): ContextOverflow {
  for (const text of texts) {
    for (const { pattern, lowerBound, tokens } of COUNTS) {
      const found = pattern.exec(text);
      if (found?.[1] !== undefined) return { tokens: tokens === undefined ? Number(found[1]) : tokens(found), lowerBound };
    }
  }
  return { lowerBound: false };
}

/**
 * The OpenRouter error metadata a response body carries, when it is JSON.
 * @param body - The raw response body.
 * @returns Its `error.metadata`, or undefined.
 * @throws {never} Never.
 */
function metadataOf(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { metadata?: unknown } } | null;
    const metadata = parsed?.error?.metadata;
    return metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>) : undefined;
  } catch {
    // Not JSON: there is no metadata to read, and the wording check still runs.
    return undefined;
  }
}

/**
 * Read one provider error as an overflow.
 * @param err - A single error, not a retry wrapper.
 * @returns The overflow, or undefined when it is not one.
 * @throws {never} Never.
 */
function readOne(err: unknown): ContextOverflow | undefined {
  if (!APICallError.isInstance(err) || err.statusCode !== 400) return undefined;
  const texts = [err.message, ...(err.responseBody === undefined ? [] : [err.responseBody])];
  // OpenRouter's `error_type: "context_length_exceeded"` is in the body text,
  // where the wording list reads it.
  return texts.some(readsAsOverflow) ? statedCount(texts) : undefined;
}

/**
 * Whether a failed model call was turned away as over the context window.
 *
 * The SDK hands over the provider's own error when the first attempt failed
 * for good, and a `RetryError` holding every attempt's error once it retried;
 * any attempt that was an overflow makes the call one.
 * @param err - What the SDK handed over.
 * @returns The overflow, or undefined for any other failure.
 * @throws {never} Never.
 */
export function readContextOverflow(err: unknown): ContextOverflow | undefined {
  if (!RetryError.isInstance(err)) return readOne(err);
  for (const one of [err.lastError, ...err.errors]) {
    const found = readOne(one);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * What a failed model call says about itself, for log lines: the provider's
 * own words, which neither the SDK's message nor our reading of it replaces
 * (A8).
 * @param err - What the SDK handed over.
 * @returns The status, message, upstream and raw upstream error of the
 *   provider's answer, or the message alone when the error is not one.
 * @throws {never} Never.
 */
export function providerErrorOf(err: unknown): Record<string, unknown> {
  const one = RetryError.isInstance(err) ? err.lastError : err;
  if (!APICallError.isInstance(one)) return { message: one instanceof Error ? one.message : String(one) };
  const metadata = metadataOf(one.responseBody);
  return {
    statusCode: one.statusCode,
    message: one.message,
    provider_name: metadata?.provider_name,
    provider_error_code: metadata?.provider_error_code,
    raw: metadata?.raw,
  };
}

/**
 * The same, for a 400 the list did not recognise, so the list can learn a new
 * wording.
 * @param err - What the SDK handed over.
 * @returns What {@link providerErrorOf} reads, or undefined when the error is
 *   not a provider's 400.
 * @throws {never} Never.
 */
export function unrecognised400(err: unknown): Record<string, unknown> | undefined {
  const one = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(one) && one.statusCode === 400 ? providerErrorOf(one) : undefined;
}
