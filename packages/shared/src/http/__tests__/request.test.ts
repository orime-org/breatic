// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Transport-level behaviour of `httpRequest`.
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
 * they are not checking a library's defaults.
 */

import { getEventListeners } from "node:events";

import { describe, it, expect } from "vitest";

import { httpRequest } from "@shared/http/request.js";
import { MAX_RETRIES, MAX_TIMER_MS } from "@shared/http/constants.js";

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
          // A hardcoded `DOMException("aborted")` would mean the double does
          // not behave like the thing it doubles, and the transport's promise
          // that a cancellation surfaces as the caller's own error would never
          // actually be exercised.
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

describe("httpRequest — it holds nothing once it returns", () => {
  it("leaves no listener on the caller's signal, however many responses go unread", async () => {
    // The reason this transport hands back a bare `Response` rather than a
    // wrapper. A wrapper that can be cancelled mid-read has to watch the
    // caller's signal, and watching means holding — so every response nobody
    // read pinned itself, and the whole response behind it, to a signal that
    // may live for a whole agent session. Measured on the version this
    // replaces: 200 unread responses left 200 listeners. Bare `fetch` leaves
    // one, and so must this.
    const stop = new AbortController();

    for (let i = 0; i < 50; i += 1) {
      const { fetchImpl } = scriptedFetch([res(404, { error: "nope" })]);
      const outcome = await httpRequest(
        `https://x.test/task/${i}`,
        {},
        opts({ fetchImpl, signal: stop.signal }),
      );
      expect(outcome.response.status).toBe(404);
      // Deliberately no read, no cancel, no close.
    }

    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  it("leaves no listener behind after a success either", async () => {
    const stop = new AbortController();
    const { fetchImpl } = scriptedFetch([res(200)]);
    await httpRequest("https://x.test/ok", {}, opts({ fetchImpl, signal: stop.signal }));
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  it("leaves no listener behind after every replay is spent", async () => {
    const stop = new AbortController();
    const { fetchImpl } = scriptedFetch([res(503), res(503), res(503)]);
    await httpRequest("https://x.test/down", {}, opts({ fetchImpl, signal: stop.signal }));
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  it("hands back the platform's own response, not a wrapper", async () => {
    // Callers read it with the methods they already know, and the transport
    // has no opinion about which one or whether at all.
    const { fetchImpl } = scriptedFetch([res(200, { id: "abc" })]);
    const { response } = await httpRequest("https://x.test/j", {}, opts({ fetchImpl }));

    expect(response).toBeInstanceOf(Response);
    expect(await response.json()).toEqual({ id: "abc" });
  });
});

describe("httpRequest — replay authorization comes from the caller", () => {
  it("retries a 500 when the caller declared the request replay-safe", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(500), res(200)]);
    const out = await httpRequest("https://x.test/a", {}, opts({ fetchImpl }));
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
    expect(out.attempts).toBe(2);
  });

  it("does NOT retry a 500 when replaying is not safe", async () => {
    // The guard that preserves the duplicate-vendor-cost decision: a submit
    // that may already be running upstream is not delivered twice.
    const { fetchImpl, calls } = scriptedFetch([res(500), res(200)]);
    const out = await httpRequest(
      "https://x.test/submit",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: false }),
    );
    expect(calls()).toBe(1);
    expect(out.response.status).toBe(500);
    expect(out.stopped).toBe("not_replay_safe");
  });

  it("retries a 429 even when replaying is not safe", async () => {
    // 429 means the server never processed us, so the side-effect concern
    // does not apply. This is decideRetry's ordering seen end to end.
    const { fetchImpl, calls } = scriptedFetch([res(429), res(200)]);
    const out = await httpRequest(
      "https://x.test/submit",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: false }),
    );
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
  });

  it("retries a POST when the caller declares it replay-safe", async () => {
    // Proves no method whitelist gates this: a POST carrying a vendor
    // idempotency key must be replayable.
    const { fetchImpl, calls } = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/kling",
      { method: "POST" },
      opts({ fetchImpl, replaySafe: true }),
    );
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
  });

  it("never retries a 4xx, replay-safe or not", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(404), res(200)]);
    const out = await httpRequest("https://x.test/missing", {}, opts({ fetchImpl }));
    expect(calls()).toBe(1);
    expect(out.response.status).toBe(404);
    expect(out.stopped).toBe("client_error");
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
      opts({ fetchImpl, replaySafe: true }),
    );

    expect(calls()).toBe(1);
    expect(out.response.status).toBe(503);
    expect(out.stopped).toBe("body_not_replayable");
  });

  it("still replays a body that can be delivered again", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/upload",
      { method: "POST", body: "payload" },
      opts({ fetchImpl, replaySafe: true }),
    );
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
  });
});

describe("httpRequest — outcome shape", () => {
  it("returns the last response once retries are exhausted, without throwing", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(500), res(500), res(500)]);
    const out = await httpRequest("https://x.test/down", {}, opts({ fetchImpl }));
    expect(calls()).toBe(MAX_RETRIES + 1);
    expect(out.response.status).toBe(500);
    expect(out.attempts).toBe(MAX_RETRIES + 1);
    expect(out.stopped).toBe("attempts_exhausted");
  });

  it("rejects when no response was ever obtained", async () => {
    const { fetchImpl } = scriptedFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    await expect(httpRequest("https://x.test/dns", {}, opts({ fetchImpl }))).rejects.toThrow(
      "fetch failed",
    );
  });

  it("succeeds on the first try without any replay", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(200)]);
    const out = await httpRequest("https://x.test/fast", {}, opts({ fetchImpl }));
    expect(calls()).toBe(1);
    expect(out.attempts).toBe(1);
    expect(out.stopped).toBe("nothing_to_retry");
  });

  it("reports nothing_to_retry for a 304, not the caller's declaration", async () => {
    // A conditional GET answered 304 is not ok, so it enters the loop — and
    // the `!replaySafe` arm sat ahead of the is-this-even-a-failure arm, so
    // the outcome blamed the caller's side-effect declaration for a response
    // that contains no failure at all.
    const { fetchImpl } = scriptedFetch([new Response(null, { status: 304 })]);
    const out = await httpRequest(
      "https://x.test/cached",
      {},
      opts({ fetchImpl, replaySafe: false }),
    );
    expect(out.response.status).toBe(304);
    expect(out.stopped).toBe("nothing_to_retry");
  });
});

describe("httpRequest — the server's wait comes back with the answer", () => {
  it("carries the figure the server named", async () => {
    const { fetchImpl } = scriptedFetch([
      new Response("slow down", { status: 429, headers: { "retry-after": "300" } }),
    ]);
    const out = await httpRequest("https://x.test/limited", {}, opts({ fetchImpl }));

    expect(out.stopped).toBe("retry_after_too_long");
    expect(out.retryAfterMs).toBe(300_000);
  });

  it("carries it on exhaustion too, whatever ended the request", async () => {
    // The contract is that the number the server asked for travels back. It
    // was attached only to the refusal that is ABOUT the wait, so a run that
    // spent its attempts on 503s and met a 429 with `Retry-After` on the last
    // one reported exhaustion with no figure at all — on the one occasion the
    // server had said explicitly when to come back.
    const { fetchImpl } = scriptedFetch([
      res(503),
      res(503),
      new Response("slow down", { status: 429, headers: { "retry-after": "90" } }),
    ]);
    const out = await httpRequest("https://x.test/limited", {}, opts({ fetchImpl }));

    expect(out.retryAfterMs).toBe(90_000);
  });

  it("reports null when the server named none", async () => {
    const { fetchImpl } = scriptedFetch([res(200)]);
    const out = await httpRequest("https://x.test/ok", {}, opts({ fetchImpl }));
    expect(out.retryAfterMs).toBeNull();
  });
});

describe("httpRequest — per-attempt deadline", () => {
  it("gives each attempt a fresh deadline so attempt 2 can still succeed", async () => {
    // The bug this pins: one `AbortSignal.timeout(...)` reused across a retry
    // loop is single-shot, so the first timeout aborts every later attempt
    // before it leaves the ground.
    const { fetchImpl, calls } = scriptedFetch(["hang", res(200)]);
    const out = await httpRequest("https://x.test/slow", {}, opts({ fetchImpl, timeoutMs: 30 }));
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
  });

  it("rejects a timeout past what a timer can hold, instead of silently becoming 1ms", async () => {
    // `setTimeout` clamps anything above 2^31-1 to ONE MILLISECOND, with only
    // a warning on stderr. A caller granting a 30-day deadline therefore got
    // the opposite of what it asked for: the attempt aborted almost
    // immediately, was classified as a timeout, and was replayed. Silently
    // doing the reverse of an instruction is worse than refusing it.
    const { fetchImpl } = scriptedFetch([res(200)]);
    await expect(
      httpRequest("https://x.test/slow", {}, opts({ fetchImpl, timeoutMs: MAX_TIMER_MS + 1 })),
    ).rejects.toThrow(/timeout/i);
  });

  it.each([Number.NaN, -1, 0])("rejects the unusable timeout %o", async (timeoutMs) => {
    const { fetchImpl } = scriptedFetch([res(200)]);
    await expect(
      httpRequest("https://x.test/slow", {}, opts({ fetchImpl, timeoutMs })),
    ).rejects.toThrow(/timeout/i);
  });
});

describe("httpRequest — caller cancellation", () => {
  it("stops immediately on caller abort and does not replay", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = scriptedFetch(["hang", res(200)]);
    const pending = httpRequest(
      "https://x.test/stopped",
      {},
      opts({ fetchImpl, signal: controller.signal, timeoutMs: 5_000 }),
    );
    controller.abort(new Error("user pressed stop"));

    await expect(pending).rejects.toThrow("user pressed stop");
    expect(calls()).toBe(1);
  });
});

describe("httpRequest — injected fetch", () => {
  it("uses the injected implementation rather than the global one", async () => {
    const { fetchImpl, calls } = scriptedFetch([res(200)]);
    await httpRequest("https://x.test/injected", {}, opts({ fetchImpl }));
    expect(calls()).toBe(1);
  });

  it("re-enters the injected fetch on every replay", async () => {
    // The agent's tools inject an SSRF guard, so retrying ABOVE it means each
    // replay is re-checked. Retrying inside a connection pool would not.
    const seen: string[] = [];
    const fetchImpl = ((url: string): Promise<Response> => {
      seen.push(url);
      return Promise.resolve(res(seen.length < 3 ? 503 : 200));
    }) as unknown as typeof fetch;

    await httpRequest("https://x.test/guarded", {}, opts({ fetchImpl }));
    expect(seen).toHaveLength(3);
  });

  it("refuses a stand-in that does not return a Response", async () => {
    // Checked before anything about the attempt is recorded. A duck-typed
    // stand-in used to be replayed three times and then handed to the caller
    // dressed as a response.
    const fetchImpl = (() => Promise.resolve({ status: 200, ok: true })) as unknown as typeof fetch;
    await expect(
      httpRequest("https://x.test/bad", {}, opts({ fetchImpl })),
    ).rejects.toThrow(/did not return a Response/);
  });
});

describe("httpRequest — deterministic failures the caller recognises", () => {
  /** A deterministic rejection a replay could never fix. */
  class BlockedError extends Error {
    constructor() {
      super("Blocked IP range 'private' for 10.0.0.1");
      this.name = "BlockedError";
    }
  }

  it("does not replay an error the caller declares fatal", async () => {
    // The agent's fetch tool guards against SSRF; a blocked address is blocked
    // on every attempt, so replaying it only burns time. Only the caller knows
    // which of its fetch implementation's errors are like this.
    const { fetchImpl, calls } = scriptedFetch([new BlockedError(), new BlockedError(), res(200)]);
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
    const { fetchImpl, calls } = scriptedFetch([new TypeError("fetch failed"), res(200)]);
    const out = await httpRequest(
      "https://x.test/transient",
      {},
      opts({ fetchImpl, isFatal: (e) => e instanceof BlockedError }),
    );
    expect(calls()).toBe(2);
    expect(out.response.status).toBe(200);
  });

  it("does not let a throwing predicate decide the request", async () => {
    // `isFatal` is the caller's, and a caller's function describes a request
    // rather than deciding it. A predicate that throws — reading a property
    // off an error shape it did not anticipate — used to propagate out in
    // place of the vendor's real failure, ending the request after one attempt.
    // A predicate that cannot answer has not answered "fatal".
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
        }),
      ),
    ).rejects.toThrow("ECONNRESET from the socket");

    expect(calls()).toBe(MAX_RETRIES + 1);
  });
});
