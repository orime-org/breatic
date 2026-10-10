// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pins the one stretch of a deadline's journey a reading of the call sites
 * cannot see: from `requestWithRetry`'s fourth parameter, and `queryBilling`'s
 * third, into the transport's options. A task's deadline arrives there as a
 * signal (inner#1367); sever the spread and every upstream call silently loses
 * it while tsc stays green.
 *
 * `toStrictEqual` throughout, deliberately: `toEqual` treats a key holding
 * `undefined` as equal to the key's absence, which is exactly the distinction
 * the omitted-signal case exists to pin.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import type * as coreModule from "@breatic/core";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getWorkerConfig: () => ({
      poll_interval: 1_000,
    }),
    // The billing fixtures here carry no billing line, which `queryBilling`
    // says so about. Reaching the real logger from a test that never called
    // `initCore` throws, and what these cases are about is the deadline.
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
});

import { requestWithRetry, queryBilling } from "@worker/providers/http.js";
import type { ResolvedModel } from "@worker/providers/shared.js";

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

  // A task's deadline arrives as a signal so a resend cannot stretch it
  // (inner#1367); no per-delivery timeout of the vendor's own rides along.
  it("forwards the fourth argument as the signal, verbatim", async () => {
    const signal = new AbortController().signal;
    await requestWithRetry("https://vendor.test/submit", { method: "POST" }, "vendor", signal);

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({ replaySafe: false, signal });
  });

  it("omits the signal key entirely when none was given", async () => {
    await requestWithRetry("https://vendor.test/status", { method: "GET" }, "vendor");

    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({ replaySafe: false });
  });

  it("passes url and init through untouched", async () => {
    const init = { method: "POST", headers: { a: "b" }, body: "{}" };
    await requestWithRetry("https://vendor.test/submit", init, "vendor");

    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://vendor.test/submit");
    expect(httpRequestMock.mock.calls[0]![1]).toBe(init);
  });

  it("still words a non-ok status with the vendor's body", async () => {
    httpRequestMock.mockImplementation(
      async () => new Response("quota exhausted", { status: 402 }),
    );

    await expect(
      requestWithRetry("https://vendor.test/submit", { method: "POST" }, "vendor"),
    ).rejects.toThrow("vendor HTTP 402: quota exhausted");
  });
});

describe("queryBilling hands the task deadline to the transport", () => {
  const RESOLVED = {
    baseUrl: "https://api.vendor.test",
    apiKey: "billing-key",
  } as ResolvedModel;

  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(
      async () =>
        // The vendor's own shape, captured live on 2026-09-03. What each field
        // means is `query-billing.test.ts`'s subject; this one needs a response
        // the parser accepts so the deadline assertions below are reached.
        new Response(
          JSON.stringify({
            code: 200,
            data: {
              items: [{ billing_type: "deduct", order: { price: 1.5, state: "done" } }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
  });

  it("carries the task's signal and no figure of its own", async () => {
    const signal = new AbortController().signal;
    const cost = await queryBilling(RESOLVED, "task-123", signal);

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://api.vendor.test/billings/search");
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({ replaySafe: false, signal });
    expect(cost).toBe(1.5);
  });
});
