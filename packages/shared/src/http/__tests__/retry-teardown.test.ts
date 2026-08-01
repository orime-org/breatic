// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * A response the transport retries past must be torn down.
 *
 * Ownership was only ever defined for two of the three outcomes: an ok
 * response and the final non-ok one both go to a guard that holds the
 * teardown hook. The response we retry PAST had no owner at all — its body
 * was never read, never cancelled, never aborted — so it held its connection
 * until the peer gave up. Measured consequence is narrow (bodies under
 * undici's 64 KB buffer are drained into memory and the socket returns to the
 * pool either way), but the reachable case is real: the agent's fetch tool
 * takes an arbitrary URL from a conversation, declares itself replay-safe, and
 * retries 429/408/5xx — so a multi-megabyte error body pins a socket for the
 * life of the process.
 *
 * This pins the invariant rather than the symptom. "Connections leak" is not
 * observable in a unit test; "every attempt we walk away from gets aborted"
 * is.
 */

import { describe, it, expect } from "vitest";

import { httpRequest } from "@shared/http/request.js";

const URL_UNDER_TEST = "https://vendor.test/v1/generate";

describe("teardown of retried-past attempts", () => {
  it("aborts each attempt it walks away from", async () => {
    // One signal per attempt, recorded in order, so we can assert on which
    // ones were torn down and which one was handed to the caller.
    const signals: AbortSignal[] = [];
    let call = 0;
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal) signals.push(init.signal);
      call += 1;
      const status = call < 3 ? 503 : 200;
      return Promise.resolve(
        new Response(`{"attempt":${call}}`, {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl: async (): Promise<void> => undefined,
      label: "probe",
    });

    expect(call).toBe(3);
    expect(signals).toHaveLength(3);
    // The two we retried past must be aborted...
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    // ...and the one handed to the caller must NOT be, or its body would be
    // unreadable — the whole point of keeping the request alive past dispose().
    expect(signals[2]?.aborted).toBe(false);
    expect(await res.json()).toEqual({ attempt: 3 });
  });

  it("leaves the final attempt alive even when it is not ok", async () => {
    // The caller reads a failing vendor's error body out of this handle; the
    // teardown must not have reached it.
    const signals: AbortSignal[] = [];
    const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal) signals.push(init.signal);
      return Promise.resolve(
        new Response('{"error":"vendor is down"}', {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl: async (): Promise<void> => undefined,
      label: "probe",
    });

    expect(res.ok).toBe(false);
    expect(signals.at(-1)?.aborted).toBe(false);
    expect(await res.text()).toContain("vendor is down");
  });
});
