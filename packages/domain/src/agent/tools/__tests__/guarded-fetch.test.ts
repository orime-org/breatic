// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The seam between the shared HTTP transport and the SSRF guard.
 *
 * `guardedFetch` is handed to the transport as its fetch implementation, which
 * types it `typeof fetch` — a signature far wider than the guard beneath it can
 * honour. `SafeFetchOptions` carries headers, a per-hop deadline and a signal,
 * and nothing else. The gap between those two shapes is the whole subject here:
 * an untested seam that quietly dropped whatever did not fit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import {
  guardedFetch,
  UnsupportedRequestError,
} from "@domain/agent/tools/guarded-fetch.js";

describe("guardedFetch — the transport/SSRF seam", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses a method the guard cannot carry instead of downgrading it", async () => {
    // The failure this prevents is not an error — it is the absence of one. A
    // POST silently becoming a GET returns a plausible 200 from the wrong
    // request, and nothing downstream can tell. Refusing is the only outcome a
    // caller can act on.
    await expect(
      guardedFetch("https://example.test/api", { method: "POST" }),
    ).rejects.toThrow(UnsupportedRequestError);
  });

  it("refuses a body even on a method it would otherwise allow", async () => {
    await expect(
      guardedFetch("https://example.test/api", { body: "payload=1" }),
    ).rejects.toThrow(UnsupportedRequestError);
  });

  it("treats an absent method as GET and lets the request through", async () => {
    // Not a redundant case: reading `init.method` without a default would make
    // every transport-driven call — none of which set one — fail closed.
    //
    // The assertion is that the request was ISSUED, not merely that it failed
    // with something other than a refusal. The earlier version asserted
    // `rejects.not.toThrow(UnsupportedRequestError)` against a `.invalid`
    // hostname: it did a live DNS lookup on every run and would have passed on
    // any rejection at all, including one that meant the guard was broken.
    const issued = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    globalThis.fetch = issued as unknown as typeof fetch;

    const res = await guardedFetch("https://example.test/");

    expect(res.status).toBe(200);
    expect(issued).toHaveBeenCalledTimes(1);
    expect(issued.mock.calls[0]?.[0]).toBe("https://example.test/");
  });

  it("refuses a Request object rather than stringifying it into a broken URL", async () => {
    // `typeof fetch` accepts a Request, and the seam used to run it through
    // `String(input)` — which yields "[object Request]", drops the method,
    // body and headers it carries, and then dies in the URL parser. The error
    // that came out was a plain TypeError, so the transport did not recognise
    // it as final and replayed the same broken request three times.
    const req = new Request("https://example.test/api", { method: "POST" });

    await expect(guardedFetch(req)).rejects.toThrow(UnsupportedRequestError);
  });

  it("accepts a URL object, which stringifies to exactly the right thing", async () => {
    // The sibling of the case above, and the reason the fix is not "refuse
    // anything that is not a string": a URL is a faithful carrier of the one
    // thing this seam needs.
    const issued = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    globalThis.fetch = issued as unknown as typeof fetch;

    await guardedFetch(new URL("https://example.test/path?q=1"));

    expect(issued.mock.calls[0]?.[0]).toBe("https://example.test/path?q=1");
  });

  it("refuses headers given as a Headers instance instead of losing them", async () => {
    // `RequestInit.headers` takes three shapes and the guard beneath accepts
    // one. Casting the other two does not convert them — it yields an object
    // with no own keys, so the headers simply vanish and the request goes out
    // bare. An Authorization header disappearing quietly is worse than a
    // request that refuses to be sent.
    await expect(
      guardedFetch("https://example.test/", { headers: new Headers({ a: "b" }) }),
    ).rejects.toThrow(UnsupportedRequestError);
  });

  it("refuses headers given as an array of pairs", async () => {
    await expect(
      guardedFetch("https://example.test/", { headers: [["a", "b"]] }),
    ).rejects.toThrow(UnsupportedRequestError);
  });

  it("names its refusals with a type the transport can recognise as final", async () => {
    // The transport only skips its retries for errors the caller identifies as
    // deterministic. A plain Error would be replayed three times against the
    // same wall, which is what happened before this type existed.
    const err = await guardedFetch("https://example.test/", { method: "POST" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedRequestError);
  });
});
