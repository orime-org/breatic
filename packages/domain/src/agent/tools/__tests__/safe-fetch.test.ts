// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `safeFetch` is the only thing standing between the agent's `web_fetch`
 * tool and the server's own network. The tool takes a URL chosen by the
 * model, which a prompt can steer, and fetches it from inside our
 * infrastructure — so without this guard an attacker gets our server to
 * read `http://169.254.169.254/` (cloud instance credentials),
 * `http://127.0.0.1:5432/` (Postgres), or any internal admin page, and hand
 * the contents back.
 *
 * It had no tests. These pin down every rejection path it implements,
 * because the module is about to gain cancellation support and a security
 * boundary must not be edited without a net underneath it.
 *
 * The per-hop re-check (a public URL redirecting to a private address) is
 * the assertion that matters most: checking only the first URL is the
 * classic way this guard gets bypassed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

import { safeFetch, SsrfError } from "@domain/agent/tools/safe-fetch.js";

/** Point DNS at the given addresses for any hostname. */
function resolvesTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: 4 })));
}

/** Install a fetch that plays back one response per call. */
function serveFetch(responses: Response[]): { calls: () => string[] } {
  const urls: string[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL) => {
      urls.push(String(url));
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return Promise.resolve(r);
    }),
  );
  return { calls: (): string[] => urls };
}

/** A redirect response pointing at `location`. */
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  lookupMock.mockReset();
  resolvesTo("93.184.216.34"); // public by default
});

describe("safeFetch — scheme", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com"])(
    "rejects the non-http scheme %s",
    async (url) => {
      serveFetch([new Response("nope")]);
      await expect(safeFetch(url)).rejects.toThrow(SsrfError);
    },
  );

  it("allows http and https", async () => {
    serveFetch([new Response("ok")]);
    await expect(safeFetch("http://example.com/")).resolves.toBeInstanceOf(Response);
    serveFetch([new Response("ok")]);
    await expect(safeFetch("https://example.com/")).resolves.toBeInstanceOf(Response);
  });
});

describe("safeFetch — blocked hostnames", () => {
  it.each([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "instance-data.ec2.internal",
  ])("rejects the hostname %s even if DNS says it is public", async (host) => {
    // The denylist must win over DNS: a hostile resolver could map
    // `metadata` to a public address to slip past the IP check.
    resolvesTo("93.184.216.34");
    serveFetch([new Response("secret")]);
    await expect(safeFetch(`http://${host}/x`)).rejects.toThrow(SsrfError);
  });

  it("matches the denylist case-insensitively", async () => {
    serveFetch([new Response("secret")]);
    await expect(safeFetch("http://LOCALHOST/x")).rejects.toThrow(SsrfError);
    await expect(safeFetch("http://Metadata.Google.Internal/x")).rejects.toThrow(
      SsrfError,
    );
  });
});

describe("safeFetch — IP literals in the URL", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.5", "RFC 1918 private"],
    ["192.168.1.1", "RFC 1918 private"],
    ["172.16.0.1", "RFC 1918 private"],
    ["169.254.169.254", "cloud metadata"],
    ["0.0.0.0", "unspecified"],
    ["255.255.255.255", "broadcast"],
    ["224.0.0.1", "multicast"],
  ])("rejects %s (%s)", async (ip) => {
    serveFetch([new Response("secret")]);
    await expect(safeFetch(`http://${ip}/x`)).rejects.toThrow(SsrfError);
  });

  it.each([
    ["[::1]", "IPv6 loopback"],
    ["[fc00::1]", "IPv6 unique local"],
    ["[fe80::1]", "IPv6 link local"],
  ])("rejects %s (%s)", async (host) => {
    serveFetch([new Response("secret")]);
    await expect(safeFetch(`http://${host}/x`)).rejects.toThrow(SsrfError);
  });

  it("allows a public IP literal", async () => {
    serveFetch([new Response("ok")]);
    await expect(safeFetch("http://93.184.216.34/x")).resolves.toBeInstanceOf(
      Response,
    );
  });

  it("does not consult DNS for an IP literal", async () => {
    serveFetch([new Response("ok")]);
    await safeFetch("http://93.184.216.34/x");
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("safeFetch — DNS resolution", () => {
  it("rejects a hostname resolving to a private address", async () => {
    resolvesTo("10.1.2.3");
    serveFetch([new Response("secret")]);
    await expect(safeFetch("http://evil.test/x")).rejects.toThrow(SsrfError);
  });

  it("rejects when ANY of several addresses is private", async () => {
    // The bypass this closes: return one public and one internal address and
    // hope the checker only looks at the first.
    resolvesTo("93.184.216.34", "10.1.2.3");
    serveFetch([new Response("secret")]);
    await expect(safeFetch("http://mixed.test/x")).rejects.toThrow(SsrfError);
  });

  it("rejects when DNS returns no records", async () => {
    lookupMock.mockResolvedValue([]);
    serveFetch([new Response("x")]);
    await expect(safeFetch("http://void.test/x")).rejects.toThrow(SsrfError);
  });

  it("allows a hostname resolving only to public addresses", async () => {
    resolvesTo("93.184.216.34", "1.1.1.1");
    serveFetch([new Response("ok")]);
    await expect(safeFetch("http://good.test/x")).resolves.toBeInstanceOf(Response);
  });
});

describe("safeFetch — per-hop re-checking", () => {
  it("rejects a redirect from a public host to a private address", async () => {
    // THE central assertion. Checking only the initial URL is how this
    // class of guard is normally defeated.
    lookupMock.mockImplementation((host: string) =>
      Promise.resolve(
        host === "public.test"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "10.0.0.7", family: 4 }],
      ),
    );
    serveFetch([redirect("http://internal.test/admin"), new Response("secret")]);
    await expect(safeFetch("http://public.test/start")).rejects.toThrow(SsrfError);
  });

  it("rejects a redirect to a private IP literal", async () => {
    resolvesTo("93.184.216.34");
    serveFetch([redirect("http://169.254.169.254/latest/meta-data/")]);
    await expect(safeFetch("http://public.test/start")).rejects.toThrow(SsrfError);
  });

  it("never issues the request to the rejected hop", async () => {
    resolvesTo("93.184.216.34");
    const { calls } = serveFetch([redirect("http://127.0.0.1:5432/")]);
    await expect(safeFetch("http://public.test/start")).rejects.toThrow(SsrfError);
    // Only the first, allowed hop was fetched — the internal target was
    // never contacted at all.
    expect(calls()).toEqual(["http://public.test/start"]);
  });

  it("follows a public-to-public redirect and returns the final response", async () => {
    resolvesTo("93.184.216.34");
    const { calls } = serveFetch([
      redirect("https://example.com/final"),
      new Response("final body"),
    ]);
    const res = await safeFetch("http://example.com/start");
    await expect(res.text()).resolves.toBe("final body");
    expect(calls()).toEqual(["http://example.com/start", "https://example.com/final"]);
  });

  it("resolves a relative redirect against the current URL", async () => {
    resolvesTo("93.184.216.34");
    const { calls } = serveFetch([redirect("/moved"), new Response("ok")]);
    await safeFetch("https://example.com/deep/page");
    expect(calls()[1]).toBe("https://example.com/moved");
  });

  it("rejects a redirect chain longer than the hop cap", async () => {
    resolvesTo("93.184.216.34");
    serveFetch([redirect("https://example.com/loop")]); // always redirects
    await expect(safeFetch("https://example.com/start")).rejects.toThrow(
      /Too many redirects/,
    );
  });

  it("returns a 3xx that carries no Location header", async () => {
    resolvesTo("93.184.216.34");
    serveFetch([new Response(null, { status: 302 })]);
    const res = await safeFetch("https://example.com/x");
    expect(res.status).toBe(302);
  });

  it("returns 4xx and 5xx to the caller rather than treating them as redirects", async () => {
    resolvesTo("93.184.216.34");
    serveFetch([new Response("gone", { status: 404 })]);
    await expect(safeFetch("https://example.com/x")).resolves.toMatchObject({
      status: 404,
    });
  });
});

describe("safeFetch — request shape", () => {
  it("forwards caller headers and follows redirects manually", async () => {
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    await safeFetch("https://example.com/x", { headers: { "User-Agent": "probe" } });
    expect(spy).toHaveBeenCalledWith(
      "https://example.com/x",
      expect.objectContaining({
        headers: { "User-Agent": "probe" },
        // Manual redirect handling is what makes the per-hop check possible;
        // letting fetch follow them itself would skip every check after the
        // first.
        redirect: "manual",
      }),
    );
  });

  it("applies a deadline to every hop", async () => {
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    await safeFetch("https://example.com/x");
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * Cancellation support, added so the shared HTTP transport can drive this
 * guard as its fetch implementation.
 *
 * Retrying ABOVE the guard rather than beneath it is the point: each replay
 * re-runs the whole per-hop DNS and range check, so a rebinding answer on
 * the second attempt is caught. That only works if the transport's signal —
 * which carries both the per-attempt deadline and the user's stop button —
 * actually reaches every hop.
 */
describe("safeFetch — cancellation", () => {
  it("passes the caller's signal down to each hop", async () => {
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    const ac = new AbortController();
    await safeFetch("https://example.com/x", { signal: ac.signal });
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    // Aborting the caller's controller must abort what was handed to fetch.
    ac.abort(new Error("user pressed stop"));
    expect(init?.signal?.aborted).toBe(true);
  });

  it("re-checks every hop under the caller's signal, not just the first", async () => {
    resolvesTo("93.184.216.34");
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        seen.push(init?.signal);
        return Promise.resolve(
          String(url).endsWith("/final")
            ? new Response("done")
            : redirect("https://example.com/final"),
        );
      }),
    );
    const ac = new AbortController();
    await safeFetch("https://example.com/start", { signal: ac.signal });
    expect(seen).toHaveLength(2);
    ac.abort(new Error("stop"));
    // Both hops observe the cancellation, so a long redirect chain cannot
    // outlive the user's stop.
    expect(seen.every((s) => s?.aborted === true)).toBe(true);
  });

  it("refuses to issue any request when the signal is already aborted", async () => {
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    const ac = new AbortController();
    ac.abort(new Error("stopped before we started"));
    await expect(
      safeFetch("https://example.com/x", { signal: ac.signal }),
    ).rejects.toThrow(/stopped before we started/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still enforces its own deadline when no signal is supplied", async () => {
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    await safeFetch("https://example.com/x", { timeoutMs: 1234 });
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });
});
