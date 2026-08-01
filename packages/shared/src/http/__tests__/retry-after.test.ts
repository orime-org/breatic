// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The server's own `Retry-After` must become the actual wait.
 *
 * This relay had no end-to-end coverage: deleting the line that reads the
 * header left all 22 transport tests green, because they only asserted that
 * a retry happened, never how long it waited. A rate-limited vendor would
 * then have been hammered on our own sub-second jitter — the exact behaviour
 * the header exists to prevent, and the one thing a 429 is asking for.
 *
 * Observable now that the wait is injectable, which is the same seam the
 * upload tests needed to stop sleeping for real. One missing seam, two holes.
 */

import { describe, it, expect } from "vitest";

import { httpRequest } from "@shared/http/request.js";
import {
  MAX_RETRY_AFTER_INTERACTIVE_MS,
  MAX_RETRY_AFTER_BACKGROUND_MS,
} from "@shared/http/constants.js";

const URL_UNDER_TEST = "https://vendor.test/v1/generate";

/** Capture every backoff the transport asks for, without waiting. */
function recordingSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleepImpl: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

/** A fetch that plays back the given responses, one per call. */
function scriptedFetch(outcomes: readonly Response[]): typeof fetch {
  let call = 0;
  return ((): Promise<Response> => {
    const out = outcomes[call] ?? outcomes[outcomes.length - 1]!;
    call += 1;
    return Promise.resolve(out.clone());
  }) as unknown as typeof fetch;
}

/** A rate-limited response carrying the given Retry-After value. */
function rateLimited(retryAfter: string): Response {
  return new Response("{}", {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": retryAfter },
  });
}

describe("Retry-After relay", () => {
  it("waits exactly as long as the server asked", async () => {
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("5"),
      new Response("{}", { status: 200 }),
    ]);

    await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    // 5 seconds, not our own sub-second jitter. Deleting the header read
    // makes this a random value below 1000 and turns this test red.
    expect(waits).toEqual([5_000]);
  });

  it("gives up on an absurd Retry-After rather than serving a shortened one", async () => {
    // This used to clamp: a server asking for a day was served ten seconds, a
    // figure nobody had sent. It satisfied neither party — not the server,
    // whose recovery time we overrode, nor whoever was waiting.
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("86400"),
      new Response("{}", { status: 200 }),
    ]);

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toEqual([]);
    // The 429 itself comes back, so the caller can read the header and say
    // what the service actually asked for.
    expect(res.status).toBe(429);
  });

  it("serves a wait a background caller can accept, exactly as asked", async () => {
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("55"),
      new Response("{}", { status: 200 }),
    ]);

    await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toEqual([55_000]);
    expect(55_000).toBeLessThanOrEqual(MAX_RETRY_AFTER_BACKGROUND_MS);
  });

  it("refuses for an interactive caller a wait a background one would serve", async () => {
    // The same 20s answer, two callers, two right outcomes: a worker waits
    // because nobody is watching it; an upload fails because somebody is.
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("20"),
      new Response("{}", { status: 200 }),
    ]);

    const res = await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      interactive: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toEqual([]);
    expect(res.status).toBe(429);
    expect(20_000).toBeGreaterThan(MAX_RETRY_AFTER_INTERACTIVE_MS);
  });

  it("honours Retry-After even when replaying is NOT safe", async () => {
    // A 429 means the server did not process the request, so replaying it is
    // safe regardless of what the caller declared — and that is precisely the
    // case where backing off for the requested time matters most.
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("3"),
      new Response("{}", { status: 200 }),
    ]);

    await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: false,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toEqual([3_000]);
  });

  it("falls back to jittered backoff when the header is absent", async () => {
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      new Response("{}", { status: 503 }),
      new Response("{}", { status: 200 }),
    ]);

    await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toHaveLength(1);
    // Full jitter over the first-attempt ceiling: somewhere in [0, 1000).
    expect(waits[0]).toBeGreaterThanOrEqual(0);
    expect(waits[0]).toBeLessThan(1_000);
  });

  it("ignores a malformed Retry-After rather than treating it as zero", async () => {
    // `Date.parse` is lax enough to read "-5" as a date in the past (measured
    // on Node 24), which would clamp the wait to 0 and retry instantly.
    const { sleepImpl, waits } = recordingSleep();
    const fetchImpl = scriptedFetch([
      rateLimited("-5"),
      new Response("{}", { status: 200 }),
    ]);

    await httpRequest(URL_UNDER_TEST, {}, {
      replaySafe: true,
      timeoutMs: 1_000,
      bodyIdleTimeoutMs: 200,
      fetchImpl,
      sleepImpl,
      label: "probe",
    });

    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });
});
