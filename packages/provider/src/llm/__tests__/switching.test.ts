// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { HttpStatus } from "../../http/errors.js";
import { InBandError, pauseBeforeRetry } from "../switching.js";

/**
 * A refusal from the AI SDK with these response headers.
 * @param headers - The headers.
 * @returns The error.
 */
const sdkRefusal = (headers: Record<string, string>): APICallError =>
  new APICallError({ message: "busy", url: "https://x.example", requestBodyValues: {}, statusCode: 429, responseHeaders: headers });

describe("how long a retry waits", () => {
  it("moves on at once when Retry-After-Ms asks for more than a minute, from either kind of error", async () => {
    expect(await pauseBeforeRetry(sdkRefusal({ "retry-after-ms": "120000" }), 1, undefined)).toBe("switch");
    expect(await pauseBeforeRetry(new HttpStatus("https://x.example", 429, "", new Headers({ "retry-after-ms": " 120000 " })), 1, undefined)).toBe("switch");
  });

  it("waits the milliseconds Retry-After-Ms asks for", async () => {
    const started = Date.now();
    expect(await pauseBeforeRetry(sdkRefusal({ "retry-after-ms": "50" }), 1, undefined)).toBe("retry");
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("reads Retry-After when Retry-After-Ms is not a whole number", async () => {
    expect(await pauseBeforeRetry(sdkRefusal({ "retry-after-ms": "soon", "retry-after": "3600" }), 1, undefined)).toBe("switch");
  });

  it("backs off on its own when the refusal names no wait", async () => {
    expect(await pauseBeforeRetry(new Error("lost"), 1, undefined)).toBe("retry");
  });
});

describe("an error carried in an answer", () => {
  it("writes the vendor's error into its words, or names it when it has no JSON form", () => {
    expect(new InBandError({ code: 502 }).message).toContain("{\"code\":502}");
    expect(new InBandError(undefined).message).toContain("undefined");
  });
});
