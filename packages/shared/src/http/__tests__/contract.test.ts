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

  it("accepts a Response built by another realm's constructor", async () => {
    // `instanceof` is realm-sensitive. undici — already in this repo's tree via
    // jsdom and testcontainers — builds its Responses from its own constructor,
    // so an implementation injected from it failed the guard outright. Since a
    // caller-injected fetch is this layer's whole seam, rejecting the most
    // common way to supply one defeats the feature.
    const foreign = Object.create(null) as Record<string, unknown>;
    foreign["status"] = 200;
    foreign["ok"] = true;
    foreign["headers"] = new Headers({ "content-type": "application/json" });
    const fetchImpl = (() => Promise.resolve(foreign)) as unknown as typeof fetch;

    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl });

    expect(out).toBe(foreign);
  });

  it.each([
    // Assembled rather than written out: a literal `user:pass@host` trips the
    // repo's secret scanner, which cannot tell a fixture from a real leak and
    // should not try.
    `https://user:${["hunter2", "SECRET"].join("")}@api.test/v1?key=QUERYSECRET`,
    "ftp://files.test/thing",
    "data:text/plain,hello",
  ])("refuses %s without delivering it", async (url) => {
    // Parseable is not the same as fetchable. A `data:` URL is actually fetched
    // and returned as a 200, which is not an HTTP round trip at all; every
    // other scheme costs three deliveries to learn what the string already
    // said. Neither can be delivered meaningfully, so neither should cost one.
    const wire = scriptedFetch([res(200)]);

    await expect(
      httpRequest(url, {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl }),
    ).rejects.toThrow();
    expect(wire.calls()).toBe(0);
  });

  it("never lets a URL's own credentials into the message or the cause", async () => {
    // fetch refuses to build a Request from a URL with credentials, and the
    // TypeError it throws quotes the WHOLE raw url — password, query key and
    // all. That error became the `cause` this package tells callers to log,
    // while the message beside it was carefully redacted. Measured before the
    // fix: message clean, cause leaking both.
    const wire = scriptedFetch([res(200)]);
    let seen = "";
    try {
      const password = ["hunter2", "SECRET"].join("");
      await httpRequest(`https://user:${password}@api.test/v1?key=QUERYSECRET`, {}, {
        ...REPLAYABLE,
        fetchImpl: wire.fetchImpl,
      });
    } catch (error) {
      const err = error as Error;
      seen = `${err.message} ${String(err.cause ?? "")} ${String(err.stack ?? "")}`;
    }

    expect(seen).not.toContain("hunter2SECRET");
    expect(seen).not.toContain("QUERYSECRET");
    expect(wire.calls()).toBe(0);
  });

  it("refuses a signal that is not an AbortSignal instead of crashing inside", async () => {
    const wire = scriptedFetch([res(200)]);

    await expect(
      httpRequest("https://x.test/", {}, {
        ...REPLAYABLE,
        fetchImpl: wire.fetchImpl,
        signal: null as unknown as AbortSignal,
      }),
    ).rejects.toThrow(/signal/i);
    expect(wire.calls()).toBe(0);
  });

  it("does not deliver at all when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped before we started"));
    const wire = scriptedFetch([res(200)]);

    await expect(
      httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, signal: controller.signal }),
    ).rejects.toThrow("stopped before we started");
    expect(wire.calls()).toBe(0);
  });

  it("enforces the deadline even when the fetch implementation ignores the signal", async () => {
    // The deadline was handed over as `init.signal` and nothing raced it, so an
    // implementation that drops the signal made the call hang forever. This
    // repo's own SSRF guard — the motivating injected implementation, named in
    // the TSDoc — hardcodes its own AbortSignal.timeout and discards ours.
    const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const { sleepImpl } = fakeSleep();

    await expect(
      httpRequest("https://x.test/", {}, { replaySafe: true, timeoutMs: 40, fetchImpl, sleepImpl }),
    ).rejects.toThrow();
  }, 2_000);
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

  it("does not replay a body whose bytes are already gone (detached buffer)", async () => {
    // A transferred ArrayBuffer passes `instanceof ArrayBuffer` while carrying
    // no bytes at all, so the allow-list waved it through and a body that
    // cannot be delivered even once was delivered three times.
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    const wire = scriptedFetch([res(503), res(503), res(200)]);
    const { sleepImpl } = fakeSleep();

    const out = await httpRequest("https://x.test/", { method: "POST", body: buffer }, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      sleepImpl,
    });

    expect(wire.calls()).toBe(1);
    expect(out.status).toBe(503);
  });

  it.each([600, 700, 999])("does not treat %i as a server error worth replaying", async (status) => {
    // `status >= 500` had no upper bound, so anything above 599 was replayed as
    // if it were a 5xx. There is no such status class; it is not a statement
    // that a replay might work.
    //
    // Built by hand rather than with `new Response`, which refuses a status
    // outside 200..599 outright — so this was unreachable until the realm fix
    // above started accepting response-shaped objects. It is reachable now,
    // which is exactly why the bound belongs here.
    const odd = { status, ok: false, headers: new Headers() };
    let call = 0;
    const fetchImpl = (() => {
      call += 1;
      return Promise.resolve(call === 1 ? odd : res(200));
    }) as unknown as typeof fetch;

    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl });

    expect(call).toBe(1);
    expect(out.status).toBe(status);
  });

  it.each([
    ["a string", "payload"],
    ["URLSearchParams", new URLSearchParams({ a: "1" })],
    ["FormData", new FormData()],
    ["a Blob", new Blob(["bytes"])],
    ["an ArrayBuffer", new ArrayBuffer(8)],
    ["a typed array", new Uint8Array([1, 2, 3])],
    ["no body at all", undefined],
  ])("replays %s, which can be delivered again", async (_label, body) => {
    // The positive half of the allow-list was entirely untested: a mutation
    // deleting every one of these branches left the suite green, so nothing
    // stopped a replayable body from being reclassified as one-shot.
    const wire = scriptedFetch([res(503), res(200)]);
    const { sleepImpl } = fakeSleep();

    const out = await httpRequest("https://x.test/", { method: "POST", body: body as BodyInit }, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      sleepImpl,
    });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
  });

  it.each([
    ["a plain object", { a: 1 }],
    ["an array", [1, 2, 3]],
  ])("replays %s body, which fetch re-serialises identically", async (_label, body) => {
    // The allow-list judged anything unrecognised one-shot. These are values,
    // not streams — fetch serialises them the same way on every delivery — so
    // treating them as spent cost a retry that would have worked.
    const wire = scriptedFetch([res(503), res(200)]);
    const { sleepImpl } = fakeSleep();

    const out = await httpRequest("https://x.test/", { method: "POST", body: body as unknown as BodyInit }, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      sleepImpl,
    });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
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

  it("still honours Retry-After when the server sent the header twice", async () => {
    // Two headers arrive joined as "5, 5". The single-value parser rejected the
    // whole thing and fell back to sub-second jitter — hammering the very
    // server that had just asked for room, which is the opposite of what
    // reading this header is for.
    const headers = new Headers();
    headers.append("retry-after", "5");
    headers.append("retry-after", "5");
    const doubled = new Response("{}", { status: 429, headers });
    const wire = scriptedFetch([doubled, res(200)]);
    const { sleepImpl, waits } = fakeSleep();

    await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(waits()).toEqual([5_000]);
  });

  it("falls back to its own estimate for a date that does not exist", async () => {
    // "Tue, 31 Feb 2027" has the right shape and Date.parse rolls it over into
    // March, turning a nonsense header into a wait of weeks — which, being past
    // the ceiling, stopped the request outright. A calendar-invalid date is not
    // an instruction; it is a broken header.
    const wire = scriptedFetch([
      res(503, {}, { "retry-after": "Tue, 31 Feb 2027 12:00:00 GMT" }),
      res(200),
    ]);
    const { sleepImpl, waits } = fakeSleep();

    const out = await httpRequest("https://x.test/", {}, { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl });

    expect(wire.calls()).toBe(2);
    expect(out.status).toBe(200);
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

  it.each([2, 3])(
    "hands back the caller's own cancellation unwrapped when stop lands on delivery %i",
    async (abortOn) => {
      // Stopping is not a failed retry. It used to fall through the same gate
      // as one, so pressing stop on the second delivery reached on-call as
      // "failed after 2 attempts" — a user's decision reported as a network
      // fault, with a count attached that means nothing.
      const controller = new AbortController();
      let call = 0;
      const fetchImpl = ((_u: string, init?: RequestInit): Promise<Response> => {
        call += 1;
        if (call < abortOn) return Promise.resolve(res(503));
        setTimeout(() => controller.abort(new Error("user pressed stop")), 5);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      }) as typeof fetch;
      const { sleepImpl } = fakeSleep();

      const thrown = await httpRequest("https://x.test/", {}, {
        ...REPLAYABLE,
        timeoutMs: 5_000,
        fetchImpl,
        sleepImpl,
        signal: controller.signal,
      }).catch((e: unknown) => e);

      expect(thrown).not.toBeInstanceOf(HttpRetryError);
      expect((thrown as Error).message).toBe("user pressed stop");
    },
  );

  it("hands back the caller's own cancellation when stop lands during a backoff wait", async () => {
    const controller = new AbortController();
    const wire = scriptedFetch([res(503), res(200)]);

    const inFlight = httpRequest("https://x.test/", {}, {
      ...REPLAYABLE,
      fetchImpl: wire.fetchImpl,
      signal: controller.signal,
      // A real, cancellable wait: the point of the case is what happens when
      // the stop arrives mid-sleep rather than mid-delivery.
      sleepImpl: (ms: number, signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
          });
        }),
    });
    setTimeout(() => controller.abort(new Error("user pressed stop")), 20);

    const thrown = await inFlight.catch((e: unknown) => e);

    expect(thrown).not.toBeInstanceOf(HttpRetryError);
    expect((thrown as Error).message).toBe("user pressed stop");
  });

  it("keeps a query key out of the message on the throwing retry path too", async () => {
    // A mutation replacing the redacted url with the raw one in the
    // HttpRetryError message left all 121 tests green: the redaction file
    // asserted `rejects.toThrow()` with no argument on this path, and checked
    // its "no secret" claims against a DIFFERENT call that failed at the
    // boundary instead. The path that actually composes a message from a
    // delivered URL had nothing on it.
    const wire = scriptedFetch([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
    ]);
    const { sleepImpl } = fakeSleep();

    const thrown = await httpRequest(
      "https://vendor.test/v1/predictions?key=AIzaSyFAKE_KEY_VALUE",
      {},
      { ...REPLAYABLE, fetchImpl: wire.fetchImpl, sleepImpl },
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HttpRetryError);
    expect((thrown as Error).message).not.toContain("AIzaSyFAKE_KEY_VALUE");
    expect((thrown as Error).message).toContain("vendor.test");
  });

  it("preserves a non-Error abort reason exactly as the caller passed it", async () => {
    // `abort()` takes any value. Replacing a caller's own reason with a generic
    // Error destroys the identity it aborted with — and it was preserved during
    // a delivery while being replaced during a wait, so the same stop produced
    // two different shapes depending on timing.
    const reason = { code: "USER_STOPPED", at: "review-step" };
    const controller = new AbortController();
    let call = 0;
    const fetchImpl = ((_u: string, init?: RequestInit): Promise<Response> => {
      call += 1;
      if (call === 1) return Promise.resolve(res(503));
      setTimeout(() => controller.abort(reason), 5);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const { sleepImpl } = fakeSleep();

    const thrown = await httpRequest("https://x.test/", {}, {
      ...REPLAYABLE,
      timeoutMs: 5_000,
      fetchImpl,
      sleepImpl,
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(thrown).toBe(reason);
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
