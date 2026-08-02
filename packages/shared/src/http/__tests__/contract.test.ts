// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The transport's whole contract, one describe block per item.
 *
 * This file IS the acceptance checklist. The layer does six things and no
 * seventh; each block below pins one of them, and all six green is the
 * definition of done for this module. An adversarial finding that cannot be
 * traced to a block here is proposing a seventh function rather than reporting
 * a defect, and is not acted on.
 *
 * Everything drives the real loop through an injected fetch, because what is
 * worth pinning is the WIRING. A test that mocked the loop away would keep
 * passing while the wiring regressed.
 */

import { getEventListeners } from "node:events";

import { describe, it, expect } from "vitest";

import { httpRequest, HttpRetryError } from "@shared/http/request.js";
import { MAX_TIMER_MS } from "@shared/http/constants.js";

/** A JSON response with the given status. */
function res(
  status: number,
  body: unknown = { ok: true },
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records every call so a test can assert what actually reached the wire. */
interface Wire {
  fetchImpl: typeof fetch;
  calls: () => number;
  urls: () => string[];
  inits: () => RequestInit[];
}

/**
 * A fetch that plays back the given outcomes, one per call, recording each.
 *
 * `"hang"` never settles on its own, so the delivery's own deadline is what
 * ends it. It honours the signal and rejects with the SIGNAL'S OWN REASON, the
 * way a real fetch does — a hardcoded `DOMException` would mean the double does
 * not behave like the thing it doubles, and the promise that a cancellation
 * reaches the caller as its own error would never actually be exercised.
 */
function scriptedFetch(outcomes: Array<Response | Error | "hang">): Wire {
  let call = 0;
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = ((url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    inits.push(init ?? {});
    const outcome = outcomes[call] ?? new Error(`probe: no outcome #${call}`);
    call += 1;
    if (outcome === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            init.signal?.reason instanceof Error
              ? init.signal.reason
              : new DOMException("aborted", "AbortError"),
          );
        });
      });
    }
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }) as typeof fetch;
  return { fetchImpl, calls: (): number => call, urls: (): string[] => urls, inits: (): RequestInit[] => inits };
}

/** Options with the two caller-owned facts set to the permissive case. */
const REPLAYABLE = { replaySafe: true, timeoutMs: 1_000 } as const;

/** A sleep double that never actually waits, recording what it was asked. */
function fakeSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: () => number[] } {
  const waits: number[] = [];
  return {
    sleepImpl: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
    waits: (): number[] => waits,
  };
}

describe("item 1 — send the request the caller asked for", () => {
  it("hands fetch the caller's url unchanged", async () => {
    const wire = scriptedFetch([res(200)]);
    await httpRequest("https://api.example.com/v1/things?key=abc", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl });

    expect(wire.urls()).toEqual(["https://api.example.com/v1/things?key=abc"]);
  });

  it("hands fetch the caller's method, headers and body unchanged", async () => {
    const wire = scriptedFetch([res(200)]);
    await httpRequest(
      "https://api.example.com/x",
      { method: "POST", headers: { authorization: "Bearer t" }, body: "payload" },
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl },
    );

    const sent = wire.inits()[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.headers).toEqual({ authorization: "Bearer t" });
    expect(sent.body).toBe("payload");
  });

  it("replays the same url and body on a retry", async () => {
    const wire = scriptedFetch([res(503), res(200)]);
    const { sleepImpl } = fakeSleep();
    await httpRequest(
      "https://api.example.com/x",
      { method: "POST", body: "payload" },
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl },
    );

    expect(wire.urls()).toEqual(["https://api.example.com/x", "https://api.example.com/x"]);
    expect(wire.inits().map((i) => i.body)).toEqual(["payload", "payload"]);
  });

  it("uses the injected fetch rather than the global one, on every delivery", async () => {
    // The agent's tools inject an SSRF guard, so replaying ABOVE it means each
    // replay is re-checked. Replaying inside a connection pool would not be.
    const seen: string[] = [];
    const fetchImpl = ((url: string): Promise<Response> => {
      seen.push(url);
      return Promise.resolve(res(seen.length < 3 ? 503 : 200));
    }) as unknown as typeof fetch;
    const { sleepImpl } = fakeSleep();

    await httpRequest("https://x.test/guarded", {}, { ...REPLAYABLE, fetchImpl, sleepImpl });

    expect(seen).toHaveLength(3);
  });

  it("gives each delivery a fresh deadline, so the second can still succeed", async () => {
    // The bug this pins: one `AbortSignal.timeout(...)` reused across a retry
    // loop is single-shot, so the first timeout aborted every later delivery
    // before it left the ground.
    const wire = scriptedFetch(["hang", res(200)]);
    const { sleepImpl } = fakeSleep();
    const out = await httpRequest(
      "https://x.test/slow",
      {},
      { replaySafe: true, timeoutMs: 30, fetchImpl: wire.fetchImpl, sleepImpl },
    );

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it.each([
    "undefined/v1/predictions?key=SECRET",
    "/v1/predictions?key=SECRET",
    "vendor.test/v1?key=SECRET",
  ])("refuses %o without delivering it, and without echoing the key", async (url) => {
    // Learned while redacting the URL, and then sent anyway: three deliveries
    // and two backoffs against a string that can never resolve. Worse, the
    // rejection `fetch` produces carries the RAW url, so a key in the query
    // string travelled out in a message that never passed through redaction.
    const wire = scriptedFetch([res(200)]);
    let thrown = "";
    try {
      await httpRequest(url, {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl });
    } catch (error) {
      thrown = (error as Error).message;
    }

    expect(wire.calls()).toBe(0);
    expect(thrown).not.toContain("SECRET");
    expect(thrown).toMatch(/not a URL/i);
  });

  it.each([Number.NaN, -1, 0, MAX_TIMER_MS + 1])(
    "refuses the unusable timeout %o rather than silently inverting it",
    async (timeoutMs) => {
      // `setTimeout` clamps anything above 2^31-1 to ONE MILLISECOND, with only
      // a warning on stderr. A caller granting a 30-day deadline therefore got
      // the opposite of what it asked for.
      const wire = scriptedFetch([res(200)]);
      await expect(
        httpRequest("https://x.test/slow", {}, { replaySafe: true, timeoutMs, fetchImpl: wire.fetchImpl }),
      ).rejects.toThrow(/timeout/i);
      expect(wire.calls()).toBe(0);
    },
  );

  it("refuses a stand-in that does not return a Response", async () => {
    // Checked before anything about the delivery is recorded. A duck-typed
    // stand-in used to be replayed three times and then handed to the caller
    // dressed as a response.
    const fetchImpl = (() => Promise.resolve({ status: 200, ok: true })) as unknown as typeof fetch;

    await expect(
      httpRequest("https://x.test/bad", {}, { ...REPLAYABLE, fetchImpl }),
    ).rejects.toThrow(/did not return a Response/);
  });
});

describe("item 2 — decide whether a replay is warranted", () => {
  it.each([429, 408, 500, 502, 503, 504])("replays a %i", async (status) => {
    const wire = scriptedFetch([res(status), res(200)]);
    const { sleepImpl } = fakeSleep();
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it.each([400, 401, 403, 404, 409, 422])("does not replay a %i", async (status) => {
    const wire = scriptedFetch([res(status), res(200)]);
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl });

    expect(wire.calls()).toBe(1);
    expect(out.status).toBe(status);
  });

  it("replays a transport failure that produced no response", async () => {
    const wire = scriptedFetch([new Error("ECONNRESET"), res(200)]);
    const { sleepImpl } = fakeSleep();
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("does not replay when the caller says a second delivery has side effects", async () => {
    const wire = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/",
      { method: "POST" },
      { replaySafe: false, timeoutMs: 1_000, fetchImpl: wire.fetchImpl },
    );

    expect(wire.calls()).toBe(1);
    expect(out.status).toBe(503);
  });

  it.each([429, 408])(
    "replays a %i even when the caller says a second delivery has side effects",
    async (status) => {
      // 429 and 408 are the server stating it did NOT process the request, so
      // a replay cannot produce a second side effect — the caller's declaration
      // is about consequences that, here, provably did not happen.
      const wire = scriptedFetch([res(status), res(200)]);
      const { sleepImpl } = fakeSleep();
      const out = await httpRequest("https://x.test/", { method: "POST" }, {
        replaySafe: false,
        timeoutMs: 1_000,
        fetchImpl: wire.fetchImpl,
        sleepImpl,
      });

      expect(wire.calls()).toBe(2);
      expect(out.status).toBe(200);
    },
  );

  it.each([429, 408])("does not replay a one-shot body even on a %i", async (status) => {
    // Bytes that are gone outrank a protocol statement that a replay would be
    // welcome: there is nothing left to send.
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    });
    const wire = scriptedFetch([res(status), res(200)]);
    const out = await httpRequest("https://x.test/", { method: "POST", body: stream }, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
    });

    expect(wire.calls()).toBe(1);
    expect(out.status).toBe(status);
  });

  it("does not replay a body that was consumed by the first delivery", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const wire = scriptedFetch([res(503), res(200)]);
    const out = await httpRequest(
      "https://x.test/",
      { method: "POST", body: stream },
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl },
    );

    expect(wire.calls()).toBe(1);
    expect(out.status).toBe(503);
  });

  it("does not replay a failure the caller recognises as deterministic", async () => {
    // The agent's fetch tool guards against SSRF; a blocked address is blocked
    // on every delivery, so replaying only burns the budget. Only the caller
    // knows which of its own fetch implementation's errors are like this.
    class BlockedError extends Error {}
    const wire = scriptedFetch([new BlockedError("Blocked IP range"), new BlockedError("Blocked IP range"), res(200)]);

    await expect(
      httpRequest("https://x.test/blocked", {}, {
        ...REPLAYABLE,
        fetchImpl: wire.fetchImpl,
        isFatal: (e) => e instanceof BlockedError,
      }),
    ).rejects.toThrow(/Blocked IP range/);
    expect(wire.calls()).toBe(1);
  });

  it("still replays failures that predicate does not claim", async () => {
    class BlockedError extends Error {}
    const wire = scriptedFetch([new TypeError("fetch failed"), res(200)]);
    const { sleepImpl } = fakeSleep();

    const out = await httpRequest("https://x.test/transient", {}, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      sleepImpl,
      isFatal: (e) => e instanceof BlockedError,
    });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it("does not let a throwing predicate decide the request", async () => {
    // `isFatal` is the caller's, and a caller's function describes a request
    // rather than deciding it. A predicate that throws — reading a property off
    // an error shape it did not anticipate — used to propagate out in place of
    // the vendor's real failure, ending the request after one delivery. A
    // predicate that cannot answer has not answered "deterministic".
    const last = new TypeError("ECONNRESET from the socket");
    const wire = scriptedFetch([new TypeError("ECONNRESET"), new TypeError("ECONNRESET"), last]);
    const { sleepImpl } = fakeSleep();

    const thrown = await httpRequest("https://x.test/transient", {}, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      sleepImpl,
      isFatal: () => {
        throw new Error("the predicate itself is broken");
      },
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as HttpRetryError).cause).toBe(last);
    expect(wire.calls()).toBe(3);
  });
});

describe("item 3 — wait as long as the server said, or work it out when it did not", () => {
  it("waits exactly what Retry-After named, in seconds", async () => {
    const wire = scriptedFetch([res(429, {}, { "retry-after": "3" }), res(200)]);
    const { sleepImpl, waits } = fakeSleep();
    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(waits()).toEqual([3_000]);
  });

  it("honours a Retry-After of zero rather than falling back to its own guess", async () => {
    const wire = scriptedFetch([res(429, {}, { "retry-after": "0" }), res(200)]);
    const { sleepImpl, waits } = fakeSleep();
    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(waits()).toEqual([0]);
  });

  it("works out its own wait when the server named none", async () => {
    const wire = scriptedFetch([res(503), res(200)]);
    const { sleepImpl, waits } = fakeSleep();
    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(waits()).toHaveLength(1);
    expect(waits()[0]).toBeGreaterThanOrEqual(0);
    expect(waits()[0]).toBeLessThanOrEqual(1_000);
  });

  it("works out its own wait when the server named one it cannot use", async () => {
    const wire = scriptedFetch([res(503, {}, { "retry-after": "not-a-number" }), res(200)]);
    const { sleepImpl, waits } = fakeSleep();
    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(waits()).toHaveLength(1);
    expect(waits()[0]).toBeLessThanOrEqual(1_000);
  });
});

describe("item 4 — deliver at most three times", () => {
  it("stops after three deliveries when every one fails", async () => {
    const wire = scriptedFetch([res(503), res(503), res(503), res(200)]);
    const { sleepImpl } = fakeSleep();
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(wire.calls()).toBe(3);
    expect(out.status).toBe(503);
  });

  it("stops after three deliveries when no response is ever obtained", async () => {
    const wire = scriptedFetch([new Error("down"), new Error("down"), new Error("down")]);
    const { sleepImpl } = fakeSleep();

    await expect(
      httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl }),
    ).rejects.toBeInstanceOf(HttpRetryError);
    expect(wire.calls()).toBe(3);
  });
});

describe("item 5 — hand the response over, or throw", () => {
  it("returns the native Response object itself, not a wrapper", async () => {
    const original = res(200, { hello: "world" });
    const wire = scriptedFetch([original]);
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl });

    expect(out).toBe(original);
    expect(out).toBeInstanceOf(Response);
    await expect(out.json()).resolves.toEqual({ hello: "world" });
  });

  it("returns a failing response rather than throwing, because a response is an answer", async () => {
    const wire = scriptedFetch([res(404)]);
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl });

    expect(out.status).toBe(404);
  });

  it("returns the LAST response when every delivery failed", async () => {
    const wire = scriptedFetch([res(503), res(503), res(500)]);
    const { sleepImpl } = fakeSleep();
    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(out.status).toBe(500);
  });

  it("rethrows the original error untouched when the first delivery failed and no replay happened", async () => {
    const original = new Error("DNS lookup failed");
    const wire = scriptedFetch([original]);

    await expect(
      httpRequest("https://x.test/", { method: "POST" }, { replaySafe: false, timeoutMs: 1_000, fetchImpl: wire.fetchImpl }),
    ).rejects.toBe(original);
  });

  it("throws an error carrying the delivery count when replays happened and nothing came back", async () => {
    const last = new Error("ECONNRESET");
    const wire = scriptedFetch([new Error("ECONNRESET"), new Error("ECONNRESET"), last]);
    const { sleepImpl } = fakeSleep();

    const thrown = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl }).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as HttpRetryError).attempts).toBe(3);
    expect((thrown as HttpRetryError).cause).toBe(last);
  });

  it("hands the caller its own cancellation back, unwrapped, and stops there", async () => {
    const controller = new AbortController();
    const wire = scriptedFetch(["hang", res(200)]);
    const pending = httpRequest(
      "https://x.test/stopped",
      {},
      { replaySafe: true, timeoutMs: 5_000, fetchImpl: wire.fetchImpl, signal: controller.signal },
    );
    controller.abort(new Error("user pressed stop"));

    await expect(pending).rejects.toThrow("user pressed stop");
    expect(wire.calls()).toBe(1);
  });
});

describe("item 6 — hold nothing once the call is over", () => {
  it("leaves no listener on the caller's signal after returning a response", async () => {
    const controller = new AbortController();
    const wire = scriptedFetch([res(200)]);
    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, signal: controller.signal });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("leaves no listener behind however many responses go unread", async () => {
    // A response nobody reads is a response nobody holds. The version this
    // replaces kept a handle wired to the caller's signal, so 200 unread
    // responses meant 200 live listeners on a signal that may outlive the
    // request by hours.
    const controller = new AbortController();
    const wire = scriptedFetch(Array.from({ length: 20 }, () => res(200)));
    for (let i = 0; i < 20; i++) {
      await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, signal: controller.signal });
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("leaves no listener behind across several retries", async () => {
    const controller = new AbortController();
    const wire = scriptedFetch([res(503), res(503), res(200)]);
    const { sleepImpl } = fakeSleep();
    await httpRequest(
      "https://x.test/",
      {},
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl, signal: controller.signal },
    );

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("leaves no listener behind when it throws", async () => {
    const controller = new AbortController();
    const wire = scriptedFetch([new Error("down"), new Error("down"), new Error("down")]);
    const { sleepImpl } = fakeSleep();

    await httpRequest(
      "https://x.test/",
      {},
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl, signal: controller.signal },
    ).catch(() => undefined);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
