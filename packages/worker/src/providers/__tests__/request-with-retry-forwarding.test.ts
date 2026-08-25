// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pins the stretches of a deadline's journey that no source check can see:
 * from `requestWithRetry`'s fourth parameter into the transport's options,
 * and from the worker config through `httpConfig` into `queryBilling`'s.
 *
 * The structural guard beside this file proves every call site still NAMES
 * its deadline. It cannot prove the deadline goes anywhere: sever the spread
 * inside `requestWithRetry` — flip its condition, rename the parameter — and
 * all 13 positional deadlines silently fall back to the transport's 300s
 * default while that guard, ESLint and tsc all stay green. Measured, on the
 * flipped condition. Likewise one hop of indirection is invisible to it:
 * rewire `billingTimeout` to a different config field inside `httpConfig`
 * and the call-site text the guard pins is untouched. A source check reads
 * text; only a behavioural test can follow a value through a function, so
 * this file mocks the transport and asserts on what actually arrives.
 *
 * `toStrictEqual` throughout, deliberately: `toEqual` treats a key holding
 * `undefined` as equal to the key's absence, which is exactly the
 * distinction the omitted-deadline case exists to pin — under `toEqual` an
 * always-present `timeoutMs,` passed every test here. Measured.
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

// The billing deadline reaches the transport via getWorkerConfig, so pinning
// that wire needs the config mocked. The two figures are DIFFERENT on
// purpose: a value can only identify a key if it is unique among the
// candidates, and the mutation this exists to catch is precisely
// billingTimeout being rewired to poll_max_wait.
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof coreModule>();
  return {
    ...actual,
    getWorkerConfig: () => ({
      poll_interval: 1_000,
      poll_max_wait: 999_999,
      billing_timeout: 30_000,
    }),
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

  it("forwards the fourth argument as timeoutMs, verbatim", async () => {
    await requestWithRetry("https://vendor.test/submit", { method: "POST" }, "vendor", 600_000);

    // Strict equality on the whole options object: the value must arrive AND
    // nothing else may ride along, not even as an undefined-valued key.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: false,
      timeoutMs: 600_000,
    });
  });

  it("omits the timeoutMs key entirely when no deadline was given", async () => {
    // The poll loop relies on this: absence is what lets the transport's own
    // default apply. Strict, because `toEqual` cannot tell an absent key from
    // `timeoutMs: undefined` — an always-present bare `timeoutMs,` in the
    // implementation passed this test's previous version. Measured.
    await requestWithRetry("https://vendor.test/status", { method: "GET" }, "vendor");

    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({ replaySafe: false });
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

describe("queryBilling hands the billing deadline to the transport", () => {
  const RESOLVED = {
    baseUrl: "https://api.vendor.test",
    apiKey: "billing-key",
  } as ResolvedModel;

  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ price: 1.5 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  });

  it("carries billing_timeout, not any sibling config figure", async () => {
    // The guard beside this file pins the call-site text
    // `httpConfig().billingTimeout` — and only that text. Rewiring
    // billingTimeout to poll_max_wait INSIDE httpConfig leaves the call site
    // untouched and every source check green; measured, 30s silently became
    // 300s. The mocked config gives the two fields different figures
    // precisely so that rewiring cannot hide behind an equal value.
    const cost = await queryBilling(RESOLVED, "task-123");

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://api.vendor.test/billings/search");
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: false,
      timeoutMs: 30_000,
    });
    expect(cost).toBe(1.5);
  });
});
