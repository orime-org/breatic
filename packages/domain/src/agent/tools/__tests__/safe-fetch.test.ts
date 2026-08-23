// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `safeFetch` refuses, and what it tells the shared transport.
 *
 * These are the first tests this file has ever had. The SSRF guard is a
 * security control and it shipped with no automated coverage at all, so the
 * refusal cases below are characterisation.
 *
 * Which cases characterise the OLD behaviour and which only pin the new one
 * splits along a line that can be stated without counting anything. A case
 * that refuses BEFORE any request is made behaves identically on both
 * versions, because neither version reaches a request layer — those are
 * genuine cross-version characterisation. A case that needs a response to
 * come back cannot run against the pre-move module at all: that module gets
 * its response from the global `fetch`, which this very file stubs to throw,
 * so it fails with "a real fetch escaped". Those pin the behaviour going
 * forward; they do not testify that it is unchanged.
 *
 * There used to be a count here, and it went stale twice — once when a case
 * was added by the same commit that wrote the number, once when the IPv6 case
 * arrived. It is gone on purpose. The rule above is what the count was trying
 * to convey, it decides every case in this file including ones not written
 * yet, and unlike a number it cannot quietly rot.
 *
 * Two things about the handoff cannot be read off the call site, which is why
 * they are asserted behaviourally:
 *
 *   - `replaySafe: true` is what buys the retry this batch exists for. With
 *     `false` the transport replays 429 and 408 only, so the network blip that
 *     names this batch would still fail the tool on the first try.
 *   - The deadline must arrive as `timeoutMs`. It used to ride in as
 *     `init.signal`, and the transport replaces the caller's signal — left
 *     there it becomes a no-op and every delivery silently gets the
 *     transport's own default instead of the figure this module intends.
 *     Note the unit: `timeoutMs` bounds one DELIVERY, so the 30s no longer
 *     bounds a hop the way it did before the move.
 *
 * `redirect: "manual"` is asserted for a different reason: manual redirects
 * are why this module exists. Following them itself is what lets it re-check
 * DNS on every hop; hand that back to the platform and the guard covers the
 * first URL only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import { HttpRetryError } from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

const dnsLookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

// A real network call from a unit test would make these tests depend on the
// machine's connectivity AND would hide the very failure the handoff tests
// exist to catch: before the move, `safeFetch` calls the global `fetch`, so a
// test asserting on the transport mock would otherwise pass its request to the
// internet and fail for a confusing reason. This makes that mistake loud.
vi.stubGlobal("fetch", () => {
  throw new Error("a real fetch escaped: safeFetch must go through httpRequest");
});

import { safeFetch, SsrfError } from "@domain/agent/tools/safe-fetch.js";

/**
 * The deadline this module applies to one DELIVERY when the caller names none.
 *
 * Not one hop: a hop may be delivered more than once and each delivery gets
 * this full figure.
 */
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

/** A 2xx with no redirect, i.e. the hop loop's exit. */
const okResponse = (): Response => new Response("hello", { status: 200 });

/**
 * A redirect response pointing at `to`.
 * @param to - The Location header value.
 * @returns A 302 carrying that Location.
 */
const redirectTo = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });

describe("safeFetch refuses what it always refused", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => okResponse());
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("refuses a scheme that is not http or https", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetch("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfError);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("refuses a loopback, private, link-local or metadata address", async () => {
    // Written as IP literals, which the guard checks directly without DNS —
    // so these four also prove the literal path, not just the resolved one.
    for (const url of [
      "http://127.0.0.1:5432/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
    ]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfError);
    }
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("refuses an IPv6 literal, which reaches the guard by a different branch than IPv4 does", async () => {
    // The IPv4 literals above do NOT cover this, which is why it is its own
    // case. Measured on Node 24: `new URL("http://[::1]/").hostname` is
    // `"[::1]"` — brackets kept — and `ipaddr.isValid("[::1]")` is false, so
    // every IPv6 literal misses the `isValid` branch and is refused only by
    // the bracket-stripping one. Deleting that branch is what this case
    // exists to catch. Before it existed, nothing did.
    for (const url of [
      "http://[::1]/", // loopback
      "http://[fd00::1]/", // uniqueLocal
      "http://[::ffff:127.0.0.1]/", // ipv4Mapped; URL normalises it to [::ffff:7f00:1]
    ]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SsrfError);
    }
    // A literal is checked directly, so the resolver is never consulted.
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("refuses a denylisted hostname even when DNS answers with a public address", async () => {
    // The point of the denylist: DNS is not the only way a name reaches an
    // internal service, so a name on the list is refused before it is asked.
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    for (const host of ["localhost", "metadata.google.internal", "instance-data"]) {
      await expect(safeFetch(`http://${host}/`)).rejects.toBeInstanceOf(SsrfError);
    }
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);

    await expect(safeFetch("https://sneaky.example/")).rejects.toBeInstanceOf(SsrfError);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("refuses when ANY resolved address is private, not merely the first", async () => {
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(safeFetch("https://mixed.example/")).rejects.toBeInstanceOf(SsrfError);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("asks DNS for EVERY record, which is what makes the check above possible", async () => {
    // Separate from the case above, and asserted on the ARGUMENT rather than
    // on the outcome, because the mock hands back its array whatever it is
    // asked — so the case above still passes with `{ all: true }` deleted.
    // This case is the one that does not.
    //
    // The option is load-bearing in production. Without it `lookup(host)`
    // resolves to a single `{ address, family }` object, `for (const {
    // address } of addresses)` throws on a non-iterable, and web_fetch's
    // catch-all reports every hostname there is as a failure.
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

    await safeFetch("https://public.example/");

    expect(dnsLookupMock).toHaveBeenCalledWith("public.example", { all: true });
  });

  it("re-checks every hop, so a public host cannot redirect into the private range", async () => {
    // The whole reason this module follows redirects itself.
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    httpRequestMock.mockImplementationOnce(async () => redirectTo("http://127.0.0.1/"));

    await expect(safeFetch("https://public.example/")).rejects.toBeInstanceOf(SsrfError);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the redirect budget rather than following forever", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    httpRequestMock.mockImplementation(async () => redirectTo("https://public.example/next"));

    await expect(safeFetch("https://public.example/")).rejects.toBeInstanceOf(SsrfError);
    // Six HOPS: the initial one plus the five the budget allows. Each is one
    // call here because the transport is mocked; in production each hop is
    // up to three deliveries.
    expect(httpRequestMock).toHaveBeenCalledTimes(6);
  });

  it("hands back a 3xx with no Location instead of guessing where it meant", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const bare = new Response(null, { status: 302 });
    httpRequestMock.mockImplementation(async () => bare);

    await expect(safeFetch("https://public.example/")).resolves.toBe(bare);
  });
});

describe("safeFetch hands the request to the shared transport", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () => okResponse());
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  it("declares the hop replay-safe and passes the delivery deadline as a deadline", async () => {
    await safeFetch("https://public.example/page");

    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    // Strict equality on the whole options object: replaySafe flipping to
    // false takes away the retry this batch exists for, and a missing
    // timeoutMs swaps this module's figure for the transport's own default.
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: true,
      timeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS,
    });
  });

  it("passes the caller's delivery deadline through when given one", async () => {
    await safeFetch("https://public.example/page", { timeoutMs: 5_000 });

    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: true,
      timeoutMs: 5_000,
    });
  });

  it("sends the same wire shape, with manual redirects and no signal in the init", async () => {
    await safeFetch("https://public.example/page", {
      headers: { "User-Agent": "breatic-test" },
    });

    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://public.example/page");
    // Strict equality catches a leftover `signal` as well as a lost
    // `redirect` — the transport replaces the former and depends on the
    // latter staying put.
    expect(httpRequestMock.mock.calls[0]![1]).toStrictEqual({
      headers: { "User-Agent": "breatic-test" },
      redirect: "manual",
    });
  });

  it("addresses each hop by its own resolved URL, including a relative Location", async () => {
    httpRequestMock
      .mockImplementationOnce(async () => redirectTo("/moved"))
      .mockImplementationOnce(async () => okResponse());

    await safeFetch("https://public.example/start");

    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://public.example/start");
    expect(httpRequestMock.mock.calls[1]![0]).toBe("https://public.example/moved");
  });

  it("lets a transport failure through untouched", async () => {
    // The exit with nothing else guarding it: when no delivery produced a
    // response the transport throws, and this module must not swallow it or
    // rewrite it as an SsrfError — "the network never answered" is not a
    // verdict about where the URL points.
    const failure = new HttpRetryError(
      "http request to https://public.example failed after 3 attempts",
      3,
      new TypeError("fetch failed"),
    );
    httpRequestMock.mockImplementation(async () => {
      throw failure;
    });

    await expect(safeFetch("https://public.example/")).rejects.toBe(failure);
  });
});
