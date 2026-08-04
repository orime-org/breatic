// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Pins the one stretch of the deadline's journey that no source check can
 * see: from `requestWithRetry`'s fourth parameter into the transport's
 * options.
 *
 * The structural guard beside this file proves every call site still NAMES
 * its deadline. It cannot prove the deadline goes anywhere: sever the spread
 * inside `requestWithRetry` — flip its condition, rename the parameter — and
 * all 13 positional deadlines silently fall back to the transport's 300s
 * default while that guard, ESLint and tsc all stay green. Measured, on the
 * flipped condition. A source check reads text; only a behavioural test can
 * follow a value through a function, so this file mocks the transport and
 * asserts on what actually arrives.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@breatic/shared")>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

import { requestWithRetry } from "@worker/providers/http.js";

/** A minimal ok response for paths that only need the call to succeed. */
const okJson = (): Response =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("requestWithRetry hands the deadline to the transport", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => okJson());
  });

  it("forwards the fourth argument as timeoutMs, verbatim", async () => {
    await requestWithRetry("https://vendor.test/submit", { method: "POST" }, "vendor", 600_000);

    // toEqual on the whole options object: the value must arrive AND nothing
    // else may ride along. A wrong key here is a deadline the transport
    // never sees.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toEqual({
      replaySafe: false,
      timeoutMs: 600_000,
    });
  });

  it("omits the timeoutMs key entirely when no deadline was given", async () => {
    // The poll loop relies on this: absence is what lets the transport's own
    // default apply. `timeoutMs: undefined` would be accepted today, but the
    // contract is the key's absence, and this pins it.
    await requestWithRetry("https://vendor.test/status", { method: "GET" }, "vendor");

    expect(httpRequestMock.mock.calls[0]![2]).toEqual({ replaySafe: false });
  });

  it("passes url and init through untouched", async () => {
    const init = { method: "POST", headers: { a: "b" }, body: "{}" };
    await requestWithRetry("https://vendor.test/submit", init, "vendor", 1000);

    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://vendor.test/submit");
    expect(httpRequestMock.mock.calls[0]![1]).toBe(init);
  });

  it("still words a non-ok status with the vendor's body", async () => {
    httpRequestMock.mockImplementation(
      async () => new Response("quota exhausted", { status: 402 }),
    );

    await expect(
      requestWithRetry("https://vendor.test/submit", { method: "POST" }, "vendor", 1000),
    ).rejects.toThrow("vendor HTTP 402: quota exhausted");
  });
});
