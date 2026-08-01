// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Transport-level behaviour of `httpRequest` / `httpRequestJson`.
 *
 * These drive the real retry loop through an injected fetch, because the value
 * of this layer is in the WIRING, not in any one predicate. A test that mocked
 * the loop away would keep passing while the wiring regressed.
 *
 * The loop is written directly against `fetch`. That was measured rather than
 * assumed: an earlier cut sat on the ky retry client and needed workarounds for
 * five of its defaults — suppressing its HTTP-error throwing also suppressed
 * retrying; its method whitelist gated the retry predicate instead of deferring
 * to it; `Retry-After` was dropped once the predicate took over; the predicate
 * was not consulted on the final attempt, so exhaustion could not be reported;
 * and it read a failing response's body, erasing the vendor error text the
 * worker logs. That client is gone, so the tests below assert OUR behaviour —
 * they are not checking a library's defaults. The probes that measured those
 * five behaviours were run against that library directly; they live in the
 * private engineering notes rather than in this repository.
 */

import { describe, it, expect, vi } from "vitest";

import { httpRequest, httpRequestJson } from "@shared/http/request.js";
import type { HttpRetryEvent } from "@shared/http/request.js";
import { MAX_RETRIES } from "@shared/http/constants.js";

/** A JSON response with the given status. */
function res(status: number, body: unknown = { ok: true }, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that plays back the given outcomes, one per call. */
function scriptedFetch(
  outcomes: Array<Response | Error | "hang">,
): { fetchImpl: typeof fetch; calls: () => number } {
  let call = 0;
  const fetchImpl = ((_url: string, init?: RequestInit): Promise<Response> => {
    const outcome = outcomes[call] ?? new Error(`probe: no outcome #${call}`);
    call += 1;
    if (outcome === "hang") {
      // Never settles on its own; the per-attempt timeout must abort it.
      // Honour the signal so the attempt actually ends rather than leaking.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          // Reject with the SIGNAL'S OWN REASON, the way a real fetch does.
          // This used to be a hardcoded `DOMException("aborted")`, which meant
          // the double did not behave like the thing it doubles — and the
          // transport's documented promise, that a cancellation surfaces as
          // the caller's own error rather than a generic abort, was never
          // actually exercised by anything.
          reject(
            init.signal?.reason instanceof Error
              ? init.signal.reason
              : new DOMException("aborted", "AbortError"),
          );
        });
      });
    }
    if (outcome instanceof Error) return Promise.reject(outcome);
    return Promise.resolve(outcome);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => call };
}

/** Options with the boring parts filled in; each test varies one thing. */
function opts(over: Partial<Parameters<typeof httpRequest>[2]> = {}): Parameters<typeof httpRequest>[2] {
  return {
    replaySafe: true,
    timeoutMs: 1000,
    label: "test",
    // Skip the between-attempt wait by default. Left real, this file's cases
    // spent most of their runtime asleep in jittered backoff — the suite ran
    // ~22s of which ~20s was nothing happening, right next to assertions that
    // count attempts. Cases that are ABOUT the wait pass their own sleep.
    sleepImpl: async (): Promise<void> => {},
    ...over,
  };
}

describe("httpRequest — replay authorization comes from the caller", () => {
  it("retries a 500 when the caller declared the request replay-safe", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(500), res(200)]);
    const out = await httpRequest("https://x.test/a", {}, opts({ fetchImpl }));
    expect(calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("does NOT retry a 500 when replaying is not safe", async () => {
    // The guard that preserves the 2026-07-07 duplicate-vendor-cost
    // decision: a submit that may already be running upstream is not
    // delivered twice.
    const { fetchImpl, calls } = scriptedFetch([res(500), res(200)]);
    const out = await httpRequest(
      "https://x.test/submit",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: false }),
    );
    expect(calls()).toBe(1);
    expect(out.status).toBe(500);
  });

  it("retries a 429 even when replaying is not safe", async () => {
    // 429 means the server never processed us, so the side-effect concern
    // does not apply. This is the ordering assertion of decideRetry seen
    // end-to-end through the real client.
    const { fetchImpl, calls } = scriptedFetch([res(429), res(200)]);
    const out = await httpRequest(
      "https://x.test/submit",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: false }),
    );
    expect(calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("retries a POST when the caller declares it replay-safe", async () => {
    // Proves the underlying method whitelist is held open: a POST with a
    // vendor idempotency key must be replayable (kling Tier A).
    const { fetchImpl, calls } = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/kling",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: true }),
    );
    expect(calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("never retries a 4xx, replay-safe or not", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(404), res(200)]);
    const out = await httpRequest("https://x.test/gone", {}, opts({ fetchImpl }));
    expect(calls()).toBe(1);
    expect(out.status).toBe(404);
  });
});

describe("httpRequest — outcome shape", () => {
  it("returns the last response once retries are exhausted, without throwing", async () => {
    // "Is an HTTP error a failure" is the caller's decision — the agent's
    // web-fetch tool needs the status, not an exception.
    const { fetchImpl, calls } = scriptedFetch([res(503), res(503), res(503)]);
    const out = await httpRequest("https://x.test/down", {}, opts({ fetchImpl }));
    expect(calls()).toBe(MAX_RETRIES + 1);
    expect(out.status).toBe(503);
  });

  it("rejects when no response was ever obtained", async () => {
    const boom = new TypeError("fetch failed");
    const { fetchImpl, calls } = scriptedFetch([boom, boom, boom]);
    await expect(
      httpRequest("https://x.test/dead", {}, opts({ fetchImpl })),
    ).rejects.toThrow(/fetch failed/);
    expect(calls()).toBe(MAX_RETRIES + 1);
  });

  it("succeeds on the first try without any replay", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(200)]);
    const out = await httpRequest("https://x.test/fast", {}, opts({ fetchImpl }));
    expect(calls()).toBe(1);
    expect(out.status).toBe(200);
  });
});

describe("httpRequest — per-attempt timeout (hole ② regression)", () => {
  it("gives each attempt a fresh deadline so attempt 2 can still succeed", async () => {
    // The pre-existing worker loop reused ONE AbortSignal.timeout across
    // retries: once attempt 1 timed out the signal was permanently
    // aborted, so every later attempt died instantly. This asserts the
    // opposite — a timed-out first attempt must not poison the second.
    const { fetchImpl, calls } = scriptedFetch(["hang", res(200)]);
    const out = await httpRequest(
      "https://x.test/slow",
      {},
      opts({ fetchImpl, timeoutMs: 60 }),
    );
    expect(calls()).toBe(2);
    expect(out.status).toBe(200);
  });
});

describe("httpRequest — caller cancellation", () => {
  it("stops immediately on caller abort and does not replay", async () => {
    const ac = new AbortController();
    const { fetchImpl, calls } = scriptedFetch(["hang", res(200)]);
    setTimeout(() => ac.abort(new Error("user pressed stop")), 40);
    await expect(
      httpRequest(
        "https://x.test/cancel",
        {},
        opts({ fetchImpl, signal: ac.signal, timeoutMs: 5000 }),
      ),
    ).rejects.toThrow(/user pressed stop/);
    expect(calls()).toBe(1);
  });
});

describe("httpRequest — telemetry", () => {
  it("reports each replay with its attempt, reason and status", async () => {
    const events: HttpRetryEvent[] = [];
    const { fetchImpl } = scriptedFetch([res(503), res(200)]);
    await httpRequest(
      "https://x.test/tele",
      {},
      opts({ fetchImpl, onEvent: (e) => events.push(e), label: "wavespeed" }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "retry",
      label: "wavespeed",
      attempt: 1,
      reason: "server_error",
      status: 503,
    });
  });

  it("reports a refusal so a non-replayed failure is still visible", async () => {
    const events: HttpRetryEvent[] = [];
    const { fetchImpl } = scriptedFetch([res(500), res(200)]);
    await httpRequest(
      "https://x.test/refused",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: false, onEvent: (e) => events.push(e) }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "exhausted",
      reason: "not_replay_safe",
      status: 500,
    });
  });

  it("reports exhaustion after the budget is spent", async () => {
    const events: HttpRetryEvent[] = [];
    const { fetchImpl } = scriptedFetch([res(503), res(503), res(503)]);
    await httpRequest(
      "https://x.test/spent",
      {},
      opts({ fetchImpl, onEvent: (e) => events.push(e) }),
    );
    const kinds = events.map((e) => `${e.type}:${e.reason}`);
    expect(kinds).toEqual([
      "retry:server_error",
      "retry:server_error",
      "exhausted:attempts_exhausted",
    ]);
  });

  it("runs without an onEvent sink", async () => {
    const { fetchImpl } = scriptedFetch([res(503), res(200)]);
    await expect(
      httpRequest("https://x.test/quiet", {}, opts({ fetchImpl })),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("httpRequest — injected fetch", () => {
  it("uses the injected implementation rather than the global one", async () => {
    // The agent's web-fetch passes an SSRF-guarding fetch; if this layer
    // ever bypassed it, every retry would be an unguarded egress.
    const spy = vi.fn(async () => res(200));
    await httpRequest(
      "https://x.test/injected",
      {},
      opts({ fetchImpl: spy as unknown as typeof fetch }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-enters the injected fetch on every replay", async () => {
    // Retrying below the guard (rather than above it) would let a
    // rebinding DNS answer through on the second attempt.
    let n = 0;
    const spy = vi.fn(async () => {
      n += 1;
      return n === 1 ? res(503) : res(200);
    });
    await httpRequest(
      "https://x.test/guarded",
      {},
      opts({ fetchImpl: spy as unknown as typeof fetch }),
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("httpRequest — fatal errors from the injected fetch", () => {
  /** A deterministic rejection a replay could never fix. */
  class BlockedError extends Error {
    constructor() {
      super("Blocked IP range 'private' for 10.0.0.1");
      this.name = "BlockedError";
    }
  }

  it("does not replay an error the caller declares fatal", async () => {
    // The agent's fetch tool guards against SSRF; a blocked address is
    // blocked on every attempt, so replaying it only burns time. Only the
    // caller knows which of its fetch implementation's errors are like this.
    const { fetchImpl, calls } = scriptedFetch([
      new BlockedError(),
      new BlockedError(),
      res(200),
    ]);
    await expect(
      httpRequest(
        "https://x.test/blocked",
        {},
        opts({ fetchImpl, isFatal: (e) => e instanceof BlockedError }),
      ),
    ).rejects.toThrow(/Blocked IP range/);
    expect(calls()).toBe(1);
  });

  it("still replays errors the predicate does not claim", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      new TypeError("fetch failed"),
      res(200),
    ]);
    const out = await httpRequest(
      "https://x.test/transient",
      {},
      opts({ fetchImpl, isFatal: (e) => e instanceof BlockedError }),
    );
    expect(calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("reports the fatal refusal through onEvent", async () => {
    const events: HttpRetryEvent[] = [];
    const { fetchImpl } = scriptedFetch([new BlockedError()]);
    await expect(
      httpRequest(
        "https://x.test/blocked",
        {},
        opts({
          fetchImpl,
          isFatal: (e) => e instanceof BlockedError,
          onEvent: (e) => events.push(e),
        }),
      ),
    ).rejects.toThrow(BlockedError);
    expect(events).toEqual([
      expect.objectContaining({ type: "exhausted", reason: "fatal_error" }),
    ]);
  });
});

describe("httpRequestJson", () => {
  it("parses a successful JSON body", async () => {
    const { fetchImpl } = scriptedFetch([res(200, { data: { id: "abc" } })]);
    const out = await httpRequestJson("https://x.test/j", {}, opts({ fetchImpl }));
    expect(out).toEqual({ data: { id: "abc" } });
  });

  it("rejects on a non-ok final status, carrying status and body", async () => {
    const { fetchImpl } = scriptedFetch([
      new Response("upstream exploded", { status: 502 }),
      new Response("upstream exploded", { status: 502 }),
      new Response("upstream exploded", { status: 502 }),
    ]);
    await expect(
      httpRequestJson("https://x.test/j", {}, opts({ fetchImpl, label: "topaz" })),
    ).rejects.toThrow(/topaz.*502.*upstream exploded/s);
  });

  it("rejects when the body is not JSON", async () => {
    const { fetchImpl } = scriptedFetch([
      new Response("<html>nope</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ]);
    await expect(
      httpRequestJson("https://x.test/j", {}, opts({ fetchImpl })),
    ).rejects.toThrow(/could not be parsed as JSON/);
  });
});
