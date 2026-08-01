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

import { httpRequest, httpRequestJson, HttpStatusError } from "@shared/http/request.js";
import type { HttpRetryEvent } from "@shared/http/request.js";
import { MAX_RETRIES, HTTP_ERROR_BODY_EXCERPT_CHARS } from "@shared/http/constants.js";

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

  it("does not replay a body that can only be delivered once", async () => {
    // `replaySafe` is the caller's fact about SIDE EFFECTS. Whether the bytes
    // can physically be sent a second time is the platform's fact, and the
    // transport owns it: a stream body is consumed by attempt 1, so the replay
    // hands fetch an already-disturbed stream, which rejects with a TypeError
    // about a "Response body". That was then classified as a network failure
    // and replayed again — so the caller was handed a TypeError about a
    // response instead of the 503 the server actually sent, after two
    // round-trips that never left the process.
    //
    // Measured against a real server before the fix: with a string body the
    // server saw 3 requests and the caller got its 503; with a stream body the
    // server saw 1 and the caller got the TypeError.
    const events: HttpRetryEvent[] = [];
    const { fetchImpl, calls } = scriptedFetch([res(503), res(200)]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });

    const out = await httpRequest(
      "https://x.test/upload",
      { method: "POST", body, duplex: "half" } as RequestInit,
      opts({ fetchImpl, replaySafe: true, onEvent: (e) => events.push(e) }),
    );

    expect(calls()).toBe(1);
    expect(out.status).toBe(503);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "exhausted", reason: "body_not_replayable" }),
    );
  });

  it("still replays a body that can be delivered again", async () => {
    // The control for the case above: a string body is re-readable, so nothing
    // about this request stops the transport replaying it.
    const { fetchImpl, calls } = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/upload",
      { method: "POST", body: "payload" },
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

  it("does not let a throwing predicate decide the request", async () => {
    // `isFatal` is caller-supplied, like `onEvent`, and the rule for both is
    // the same: a caller's broken callback describes the request, it does not
    // decide it. A predicate that throws — reading a property off an error
    // shape it did not anticipate — used to propagate out in place of the
    // vendor's real failure, ending the request after one attempt with no
    // terminal event at all. A predicate that cannot answer is not an answer
    // of "fatal"; the transport falls back to what it would have done without
    // one.
    const events: HttpRetryEvent[] = [];
    const { fetchImpl, calls } = scriptedFetch([
      new TypeError("ECONNRESET from the socket"),
      new TypeError("ECONNRESET from the socket"),
      new TypeError("ECONNRESET from the socket"),
    ]);

    await expect(
      httpRequest(
        "https://x.test/transient",
        {},
        opts({
          fetchImpl,
          isFatal: () => {
            throw new Error("the predicate itself is broken");
          },
          onEvent: (e) => events.push(e),
        }),
      ),
    ).rejects.toThrow("ECONNRESET from the socket");

    expect(calls()).toBe(MAX_RETRIES + 1);
    expect(events.at(-1)).toMatchObject({ type: "exhausted", reason: "attempts_exhausted" });
  });
});

describe("httpRequest — a broken telemetry sink cannot change the outcome", () => {
  it("succeeds even when every event throws", async () => {
    // Telemetry is the application's business. A sink with a bad serializer
    // must not turn a working request into a failure.
    const { fetchImpl } = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/noisy",
      {},
      opts({
        fetchImpl,
        onEvent: () => {
          throw new Error("the logger is broken");
        },
      }),
    );
    expect(out.status).toBe(200);
  });

  it("surfaces the real failure, not the sink's", async () => {
    const { fetchImpl } = scriptedFetch([new TypeError("ECONNRESET")]);
    await expect(
      httpRequest(
        "https://x.test/noisy",
        {},
        opts({
          fetchImpl,
          replaySafe: false,
          onEvent: () => {
            throw new Error("the logger is broken");
          },
        }),
      ),
    ).rejects.toThrow("ECONNRESET");
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

describe("httpRequestJson — what the failure carries", () => {
  /**
   * Drive a JSON request to its non-ok exit and hand back the error.
   * @param outcomes - What the injected fetch plays back.
   * @param over - Option overrides.
   * @returns The thrown error.
   */
  async function failure(
    outcomes: Array<Response | Error | "hang">,
    over: Partial<Parameters<typeof httpRequest>[2]> = {},
  ): Promise<HttpStatusError> {
    const { fetchImpl } = scriptedFetch(outcomes);
    try {
      await httpRequestJson("https://vendor.test/v1/tasks/9?key=SECRET", {}, opts({ fetchImpl, ...over }));
    } catch (error) {
      return error as HttpStatusError;
    }
    throw new Error("probe: expected the request to fail");
  }

  it("carries the wait the server named", async () => {
    // The whole point of the Retry-After rule is that a refusal hands the
    // server's own figure back so the layer above can say when to try again.
    // `httpRequest` implements that and this wrapper — the shape every vendor
    // transport and the poll loop actually call — used to drop it on the floor.
    const rateLimited = (): Response =>
      new Response("slow down", { status: 429, headers: { "retry-after": "45" } });
    const error = await failure([rateLimited(), rateLimited(), rateLimited()]);

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(45_000);
  });

  it("names the endpoint, with the query redacted", async () => {
    // A vendor with twenty endpoints produced twenty identical messages. The
    // body guard fixed exactly this and this path — the most frequently hit
    // one in the transport — kept naming only the provider.
    const error = await failure([new Response("nope", { status: 404 })], { label: "kling" });

    expect(error.message).toContain("kling");
    expect(error.message).toContain("vendor.test/v1/tasks/9");
    expect(error.message).not.toContain("SECRET");
    expect(error.url).not.toContain("SECRET");
  });

  it("bounds the excerpt it quotes from the body", async () => {
    // `maxBodyBytes` is left unset by every caller that chooses its own URL,
    // so the only bound on this body is what the peer sends. A vendor
    // answering with a multi-megabyte HTML error page produced a
    // multi-megabyte Error message, which then went to the application logger.
    const huge = `${"x".repeat(5_000)}TAIL`;
    const error = await failure([new Response(huge, { status: 502 })], { replaySafe: false });

    expect(error.message.length).toBeLessThan(2_000);
    expect(error.message).not.toContain("TAIL");
    expect(error.bodyExcerpt.length).toBeLessThanOrEqual(HTTP_ERROR_BODY_EXCERPT_CHARS);
  });

  it("says the body was unreadable rather than pretending it was empty", async () => {
    // `.text().catch(() => "")` erased three distinct failures — an idle
    // deadline, a byte-cap refusal, and a caller abort — into the same
    // `vendor HTTP 502: ` that a genuinely empty body produces.
    const hostile = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset by peer"));
      },
    });
    const error = await failure([new Response(hostile, { status: 502 })], { replaySafe: false });

    expect(error.message).toMatch(/body unreadable/i);
    expect(error.message).toContain("socket reset by peer");
  });
});
