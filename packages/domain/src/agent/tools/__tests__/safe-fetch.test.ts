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

import { getEventListeners } from "node:events";
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

  it("aborts a hop that never answers, on its own deadline", async () => {
    // The per-hop deadline had two tests before this one and NEITHER asserted
    // anything about it: measured by mutation, the whole timer could be made a
    // no-op and the suite stayed green. Without it a hop that connects and then
    // says nothing hangs forever — and in the worker that means a job holding a
    // concurrency slot until the process restarts.
    resolvesTo("93.184.216.34");
    let handed: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            handed = init?.signal ?? undefined;
            handed?.addEventListener("abort", () =>
              reject(handed?.reason ?? new Error("aborted")),
            );
          }),
      ),
    );

    await expect(
      safeFetch("https://example.com/silent", { timeoutMs: 20 }),
    ).rejects.toThrow(/exceeded 20ms/);
    expect(handed?.aborted).toBe(true);
  });

  it("stops a redirect chain the moment the caller cancels", async () => {
    // A long chain must not outlive the user's stop. This asserts the
    // behaviour — the next hop is never issued — rather than the mechanism.
    //
    // The earlier version asserted that EVERY past hop's signal read
    // `aborted` after the chain had already finished. That was a statement
    // about listeners still being attached to hops we had walked away from,
    // which is precisely the leak fixed here: an abandoned hop keeps nothing,
    // and it does not need to, because its request is already over.
    resolvesTo("93.184.216.34");
    const ac = new AbortController();
    const issued: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        issued.push(String(url));
        // The stop lands while hop one is in flight.
        ac.abort(new Error("user pressed stop"));
        return Promise.resolve(redirect("https://example.com/second"));
      }),
    );

    await expect(
      safeFetch("https://example.com/start", { signal: ac.signal }),
    ).rejects.toThrow(/user pressed stop/);

    expect(issued).toEqual(["https://example.com/start"]);
  });

  it("still forwards a cancellation that lands while a hop is in flight", async () => {
    // The other half of the same invariant: the hop we have NOT walked away
    // from must still see the caller's stop, because that is the request
    // actually holding a socket.
    resolvesTo("93.184.216.34");
    const ac = new AbortController();
    let handed: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            handed = init?.signal ?? undefined;
            setTimeout(() => resolve(new Response("done")), 5);
          }),
      ),
    );

    const pending = safeFetch("https://example.com/only", { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 1));
    ac.abort(new Error("user pressed stop"));

    expect(handed?.aborted).toBe(true);
    await pending;
  });

  it("releases each redirect hop's body instead of holding its connection", async () => {
    // Nothing ever reads a 3xx body — we only want its Location header — but
    // an unread body keeps its connection until the peer gives up, so a
    // redirect chain held one per hop. Redirects are the common case here,
    // not an exotic one: http to https, a tracking hop, a CDN.
    resolvesTo("93.184.216.34");
    let cancelled = false;
    const hopBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>moved</html>"));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          String(url).endsWith("/final")
            ? new Response("done")
            : new Response(hopBody, {
                status: 302,
                headers: { location: "https://example.com/final" },
              }),
        ),
      ),
    );

    await safeFetch("https://example.com/start");

    expect(cancelled).toBe(true);
  });

  it("refuses a malformed Location as an SSRF failure, not a bare TypeError", async () => {
    // A Location we cannot parse is a URL we cannot check, so refusing is
    // right. What matters is the TYPE: the transport skips its retries only
    // for errors the caller recognises as deterministic, and `web_fetch`
    // recognises `SsrfError`. A TypeError out of `new URL()` looked like
    // weather, so the same unparseable redirect was followed three times.
    resolvesTo("93.184.216.34");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "http://[not-a-url" },
          }),
        ),
      ),
    );

    await expect(safeFetch("https://example.com/start")).rejects.toThrow(SsrfError);
  });

  it("refuses a malformed starting URL as an SSRF failure too", async () => {
    // Same rule at the other end of the chain. It is deterministic either way;
    // only the type decides whether the budget gets spent on it.
    resolvesTo("93.184.216.34");
    await expect(safeFetch("http://[not-a-url")).rejects.toThrow(SsrfError);
  });

  it("drops credential headers when a redirect crosses to another origin", async () => {
    // `safeFetch` presents itself as a safe `fetch`, and the platform's own
    // fetch removes Authorization on a cross-origin redirect. Ours hoisted the
    // header map outside the hop loop and re-sent it verbatim, so a redirect
    // to any host would have handed that host the credential. No caller passes
    // one through here today; the contract was still broken.
    resolvesTo("93.184.216.34");
    const sent: Array<Record<string, string>> = [];
    let hop = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        sent.push({ ...(init?.headers as Record<string, string>) });
        hop += 1;
        return Promise.resolve(
          hop === 1
            ? new Response(null, {
                status: 302,
                headers: { location: "https://elsewhere.example/take-it" },
              })
            : new Response("done"),
        );
      }),
    );

    await safeFetch("https://example.com/start", {
      headers: { authorization: "Bearer secret", "user-agent": "probe" },
    });

    expect(sent[0]?.authorization).toBe("Bearer secret");
    expect(sent[1]?.authorization).toBeUndefined();
    // Non-credential headers survive: the rule is about secrets, not about
    // forgetting who we are.
    expect(sent[1]?.["user-agent"]).toBe("probe");
  });

  it("keeps credential headers when the redirect stays on the same origin", async () => {
    resolvesTo("93.184.216.34");
    const sent: Array<Record<string, string>> = [];
    let hop = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        sent.push({ ...(init?.headers as Record<string, string>) });
        hop += 1;
        return Promise.resolve(
          hop === 1
            ? new Response(null, {
                status: 302,
                headers: { location: "https://example.com/moved" },
              })
            : new Response("done"),
        );
      }),
    );

    await safeFetch("https://example.com/start", {
      headers: { authorization: "Bearer secret" },
    });

    expect(sent[1]?.authorization).toBe("Bearer secret");
  });

  it("leaves exactly one abort listener behind — the returned response's", async () => {
    // One deadline is armed per hop, each registering a listener on the
    // caller's signal, and nothing removed them: a four-hop chain left four
    // behind on a signal the caller may keep for a whole session.
    //
    // One is not a leak, it is the contract: the response we hand back still
    // has an unread body, and the caller's stop has to reach that request
    // while it is being read. The three hops we walked away from keep nothing.
    resolvesTo("93.184.216.34");
    let hop = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        hop += 1;
        return Promise.resolve(
          hop <= 3
            ? new Response(null, {
                status: 302,
                headers: { location: `https://example.com/hop${hop}` },
              })
            : new Response("done"),
        );
      }),
    );
    const ac = new AbortController();

    await safeFetch("https://example.com/start", { signal: ac.signal });

    expect(hop).toBe(4);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(1);
  });

  it("keeps nothing at all when the chain ends in a failure", async () => {
    // No response was handed out, so there is no body anyone can read and no
    // reason to stay attached.
    resolvesTo("93.184.216.34");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection reset"))),
    );
    const ac = new AbortController();

    await expect(
      safeFetch("https://example.com/start", { signal: ac.signal }),
    ).rejects.toThrow(/connection reset/);

    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
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

  it("stops the hop clock once the headers land, so it cannot kill a live body", async () => {
    // The hop deadline exists to bound "connect and answer", one hop at a
    // time. Left running past the headers it becomes a TOTAL budget on the
    // whole exchange — and this transport's body deadline is deliberately
    // IDLE, so a page that streams steadily for longer than the hop timeout
    // was being killed while perfectly healthy. Measured before the fix
    // against a real socket: a
    // body writing every 120ms died at 603ms under a 600ms hop deadline.
    //
    // The transport does exactly this with its own headers deadline —
    // disposing it the moment the headers arrive — so this closes the gap
    // between two halves of one request rather than inventing a rule.
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);

    await safeFetch("https://example.com/x", { timeoutMs: 20 });
    const init = spy.mock.calls[0]?.[1];

    // Well past the hop deadline, with the body still notionally being read.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(init?.signal?.aborted).toBe(false);
  });

  it("keeps forwarding the caller's cancellation after the headers land", async () => {
    // Stopping the clock must not also stop the stop button: the body is
    // still being read, and pressing stop has to reach it.
    resolvesTo("93.184.216.34");
    const spy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok")),
    );
    vi.stubGlobal("fetch", spy);
    const ac = new AbortController();

    await safeFetch("https://example.com/x", { timeoutMs: 10_000, signal: ac.signal });
    const init = spy.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(false);

    ac.abort(new Error("user pressed stop"));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(init?.signal?.aborted).toBe(true);
  });
});
