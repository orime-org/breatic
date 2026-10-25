// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Telling a context overflow apart from every other model error (inner#1567, A4).
 *
 * The H1 and H2 bodies are what OpenRouter returned on 2026-10-25 for a first
 * request and for a second step that went over the window, copied verbatim
 * from the probe. A wrong "yes" folds memory for a rate limit or an empty
 * balance; a wrong "no" fails a turn that a fold would have saved.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { APICallError, RetryError } from "ai";
import { readContextOverflow } from "@server/agent/context-overflow.js";

const URL = "https://openrouter.ai/api/v1/chat/completions";

const H1_MESSAGE = "[Relace] This model's maximum context length is 1048576 tokens. However, your prompt contains at least 1048577 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=1048577)";
const H1_BODY = "{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"This model's maximum context length is 1048576 tokens. However, your prompt contains at least 1048577 input tokens, which exceeds this limit even without any output tokens. Please reduce the length of the input prompt. (parameter=input_tokens, value=1048577)\\\",\\\"type\\\":\\\"BadRequestError\\\",\\\"param\\\":\\\"input_tokens\\\",\\\"code\\\":400}}\",\"provider_name\":\"Relace\",\"is_byok\":false,\"provider_error_code\":\"400\"}},\"user_id\":\"org_REDACTED\"}";
const H2_MESSAGE = "[DigitalOcean] this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens";
const H2_BODY = "{\"error\":{\"message\":\"Provider returned error\",\"code\":400,\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"message\\\":\\\"this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens\\\",\\\"type\\\":\\\"invalid_request_error\\\"},\\\"message\\\":\\\"this model's maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens\\\",\\\"status_code\\\":400}\\n\",\"provider_name\":\"DigitalOcean\",\"is_byok\":false}},\"user_id\":\"org_REDACTED\"}";

/**
 * An error the way the SDK hands it over after a failed model call.
 * @param statusCode - The HTTP status the provider answered with.
 * @param message - The error message.
 * @param responseBody - The raw response body, when there was one.
 * @returns The error.
 */
function apiError(statusCode: number, message: string, responseBody?: string): APICallError {
  return new APICallError({
    message,
    url: URL,
    requestBodyValues: {},
    statusCode,
    ...(responseBody === undefined ? {} : { responseBody }),
  });
}

const h1 = (): APICallError => apiError(400, H1_MESSAGE, H1_BODY);
const h2 = (): APICallError => apiError(400, H2_MESSAGE, H2_BODY);
const rateLimited = (): APICallError => apiError(
  429,
  "Rate limit exceeded: free-models-per-min.",
  "{\"error\":{\"message\":\"Rate limit exceeded: free-models-per-min.\",\"code\":429}}",
);

describe("readContextOverflow", () => {
  describe("recognises an overflow", () => {
    it("reads H1 (first request) as an overflow whose count is a lower bound", () => {
      expect(readContextOverflow(h1())).toEqual({ tokens: 1048577, lowerBound: true });
    });

    it("reads H2 (second step) as an overflow with the exact prompt count", () => {
      expect(readContextOverflow(h2())).toEqual({ tokens: 2021458, lowerBound: false });
    });

    it("unwraps a RetryError that gave up on a non-retryable overflow after a rate limit", () => {
      const err = new RetryError({
        message: "Failed after 2 attempts. Last error: " + H1_MESSAGE,
        reason: "errorNotRetryable",
        errors: [rateLimited(), h1()],
      });
      expect(readContextOverflow(err)).toEqual({ tokens: 1048577, lowerBound: true });
    });

    it("unwraps a RetryError that ran out of retries with the overflow as its last error", () => {
      const err = new RetryError({
        message: "Failed after 3 attempts. Last error: " + H1_MESSAGE,
        reason: "maxRetriesExceeded",
        errors: [rateLimited(), rateLimited(), h1()],
      });
      expect(readContextOverflow(err)).toEqual({ tokens: 1048577, lowerBound: true });
    });

    it("unwraps a RetryError whose overflow is not the last error", () => {
      const err = new RetryError({
        message: "Failed after 2 attempts.",
        reason: "maxRetriesExceeded",
        errors: [h2(), rateLimited()],
      });
      expect(readContextOverflow(err)).toEqual({ tokens: 2021458, lowerBound: false });
    });

    it("recognises OpenRouter's error_type context_length_exceeded, without a count", () => {
      const body = JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: { error_type: "context_length_exceeded", provider_name: "Alibaba" },
        },
      });
      expect(readContextOverflow(apiError(400, "Provider returned error", body))).toEqual({ lowerBound: false });
    });

    it("recognises the overflow when only the response body carries the wording", () => {
      expect(readContextOverflow(apiError(400, "Provider returned error", H2_BODY))).toEqual({
        tokens: 2021458,
        lowerBound: false,
      });
    });

    it.each([
      [
        "Anthropic prompt is too long",
        "prompt is too long: 250000 tokens > 200000 maximum",
        250000,
      ],
      [
        "OpenAI resulted in",
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens. Please reduce the length of the messages.",
        130000,
      ],
      [
        "Gemini input token count",
        "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
        1200000,
      ],
    ])("reads the count from the %s wording", (_name, message, tokens) => {
      expect(readContextOverflow(apiError(400, message))).toEqual({ tokens, lowerBound: false });
    });
  });

  describe("leaves every other error alone", () => {
    it.each([
      ["a 429 rate limit", rateLimited()],
      [
        "a 402 payment error",
        apiError(
          402,
          "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1200.",
          "{\"error\":{\"message\":\"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1200.\",\"code\":402}}",
        ),
      ],
      [
        "a 413 request_too_large (bytes, not tokens)",
        apiError(
          413,
          "request_too_large: Request exceeds the maximum allowed number of bytes",
          "{\"type\":\"error\",\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum allowed number of bytes\"}}",
        ),
      ],
      ["a 413 payload too large", apiError(413, "Payload Too Large")],
      [
        "a 400 carrying request_too_large",
        apiError(400, "request_too_large: Request exceeds the maximum allowed number of bytes"),
      ],
      [
        "a plain 400 invalid parameter",
        apiError(
          400,
          "Invalid value for 'temperature': must be between 0 and 2",
          "{\"error\":{\"message\":\"Invalid value for 'temperature': must be between 0 and 2\",\"code\":400}}",
        ),
      ],
      ["a 400 rate limit wording", apiError(400, "rate limit reached for maximum context length is 1048576 tokens")],
      ["a 400 too many requests wording", apiError(400, "too many requests: maximum context length is 1048576 tokens")],
      ["a 400 too many tokens, please wait", apiError(400, "too many tokens, please wait before trying again")],
      ["a network TypeError", new TypeError("fetch failed")],
      ["a plain Error carrying the overflow wording", new Error(H2_MESSAGE)],
      ["a non-error value", "maximum context length is 1048576 tokens"],
      ["undefined", undefined],
    ])("does not treat %s as an overflow", (_name, err) => {
      expect(readContextOverflow(err)).toBeUndefined();
    });

    it("does not treat a RetryError of rate limits as an overflow", () => {
      const err = new RetryError({
        message: "Failed after 3 attempts.",
        reason: "maxRetriesExceeded",
        errors: [rateLimited(), rateLimited(), rateLimited()],
      });
      expect(readContextOverflow(err)).toBeUndefined();
    });
  });

  it("never reads a message with an exclusion phrase as an overflow, even with overflow wording", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("rate limit", "too many requests", "too many tokens, please wait"),
        fc.string(),
        fc.string(),
        (exclusion, before, after) => {
          const message = `${before}${exclusion}${after} maximum context length is 1048576 tokens, but the prompt contains 2021458 input tokens`;
          return readContextOverflow(apiError(400, message)) === undefined;
        },
      ),
    );
  });
});
