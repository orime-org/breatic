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

import { describe, it, expect } from "vitest";

import {
  guardedFetch,
  UnsupportedRequestError,
} from "@domain/agent/tools/guarded-fetch.js";

describe("guardedFetch — the transport/SSRF seam", () => {
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

  it("treats an absent method as GET, the way fetch itself does", async () => {
    // Not a redundant case: reading `init.method` without a default would make
    // every transport-driven call — none of which set one — fail closed.
    // A rejection here would mean the guard refuses its only real caller, so
    // this asserts it gets PAST the gate. It then fails on DNS, which is the
    // guard doing its job on a domain that does not resolve.
    await expect(guardedFetch("https://not-a-real-host.invalid/")).rejects.not.toThrow(
      UnsupportedRequestError,
    );
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
