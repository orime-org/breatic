// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `web_fetch` does when it does not come back with a page.
 *
 * The tool may catch — catching is how it decides what to say. What it may not
 * do is answer. A caught failure returned as a string is, to the SDK and so to
 * the model, a call that succeeded and whose result happens to read like a
 * complaint: same shape as a page, same `tool-result` part, nothing anywhere
 * saying otherwise. That is what had the model call this tool thirty times
 * against an address that was never going to answer.
 *
 * The seam is DNS plus the global `fetch`, as in the cancellation file beside
 * this one and for the same reason: `safeFetch` refuses loopback by design, so
 * a real local server would be rejected before a socket was opened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toolFailureOf } from "@breatic/shared";
import type { ToolFailure } from "@breatic/shared";

const dnsLookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

import { webFetch } from "@domain/agent/tools/web-fetch.js";

const fetchMock = vi.fn();

/** The options shape the SDK hands a tool's `execute`. */
const toolOptions = (signal?: AbortSignal): Record<string, unknown> => ({
  ...(signal ? { abortSignal: signal } : {}),
  toolCallId: "t1",
  messages: [],
});

/**
 * Fetch a page and read the detail the failure carried.
 * @param url - What to ask for.
 * @param signal - Handed to the tool, when the case has one.
 * @returns The failure detail the thrown error carried.
 * @throws {Error} When the tool returned, or threw without any detail.
 */
async function failureFrom(url: string, signal?: AbortSignal): Promise<ToolFailure> {
  try {
    await webFetch.execute?.({ url, maxChars: 1000 }, toolOptions(signal) as never);
  } catch (err: unknown) {
    const failure = toolFailureOf(err);
    if (failure !== undefined) return failure;
    throw new Error(
      `threw without failure detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error("the tool returned instead of failing");
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  dnsLookupMock.mockReset();
  dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web_fetch says a failure is a failure", () => {
  it("throws when the site answers an error status", async () => {
    // The most common way this tool fails, and the one an earlier draft of the
    // design missed: a 404 is a page that is not there, not a page that is.
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const failure = await failureFrom("https://public.example/gone");

    expect(failure.kind).toBe("tool_failed");
    expect(failure.forModel).toContain("404");
  });

  it("throws when the address is refused by the fetch guard", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);

    const failure = await failureFrom("https://internal.example/admin");

    expect(failure.kind).toBe("tool_failed");
  });

  it("throws when the request never completes", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const failure = await failureFrom("https://public.example/page");

    expect(failure.kind).toBe("tool_failed");
    expect(failure.forModel).toContain("socket hang up");
  });

  it("tells the model what was refused, why, and what it may do instead", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const { forModel } = await failureFrom("https://public.example/gone");

    expect(forModel).toContain("https://public.example/gone"); // what was refused
    expect(forModel).toContain("404"); // why
    expect(forModel.toLowerCase()).toMatch(/do not|instead|tell the user|another/); // what next
  });

  it("keeps the resolved address out of everything but the model's copy", async () => {
    // A blocked fetch knows an internal address, because resolving it is how
    // it knew to refuse. Handing that back is a probe: ask for an internal
    // name, read its real address off the answer. It stays out of both the
    // reader's line and the model's.
    dnsLookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);

    const { forModel, readerKey } = await failureFrom("https://internal.example/admin");

    expect(forModel).not.toContain("10.0.0.1");
    expect(readerKey).not.toContain("10.0.0.1");
    expect(readerKey).toMatch(/^chat\.tool\.failure\./);
  });

  it("tells the model a name that does not resolve is a name that does not resolve", async () => {
    // Not every refusal from the fetch guard is an address-policy refusal.
    // A hostname that does not resolve means the model got the address
    // wrong; calling that "not allowed" sends it looking for permission it
    // will never get, when what it needed was to check the spelling.
    //
    // Rejected rather than resolved-empty because that is what Node does:
    // `dns.lookup` on a name with no records throws ENOTFOUND, measured on
    // Node 24. An earlier version of this case returned `[]` and drove a
    // branch no caller reaches.
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), {
      code: "ENOTFOUND",
    });
    dnsLookupMock.mockRejectedValue(enotfound);

    const { forModel } = await failureFrom("https://nowhere.example/page");

    expect(forModel).toMatch(/ENOTFOUND|dns|resolve/i);
    expect(forModel).not.toMatch(/not allowed|not one that may be fetched/i);
    // Resolving the name IS a fact about the address, and the only one this
    // call got. The branch for requests the transport turns down before any
    // delivery says the opposite, and a model told the failure says nothing
    // about the address has no reason to question the address.
    expect(forModel).not.toMatch(/nothing about the address|was not sent/i);
  });

  it("tells the model a redirect loop is the site's doing, not a refusal", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://public.example/next" } }),
    );

    const { forModel } = await failureFrom("https://public.example/loop");

    expect(forModel).toMatch(/redirect/i);
    expect(forModel).not.toMatch(/not allowed|not one that may be fetched/i);
  });

  it("closes every one of its reasons with what the model may do next", async () => {
    const enotfound = Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), {
      code: "ENOTFOUND",
    });
    // Each site starts from the same known state. Left to inherit whatever the
    // one before it set, a site never reaches the branch it is named after:
    // with DNS still rejecting from the site above, a case about a socket that
    // dies mid-request ends at the resolver instead, and the branch it was
    // written for goes unrun while the loop still passes.
    const sites: Array<() => Promise<ToolFailure>> = [
      () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
        return failureFrom("https://public.example/gone");
      },
      () => {
        dnsLookupMock.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
        return failureFrom("https://internal.example/admin");
      },
      () => {
        dnsLookupMock.mockResolvedValue([]);
        return failureFrom("https://norecords.example/page");
      },
      () => {
        dnsLookupMock.mockRejectedValue(enotfound);
        return failureFrom("https://nowhere.example/page");
      },
      () => {
        fetchMock.mockRejectedValue(new Error("socket hang up"));
        return failureFrom("https://public.example/page");
      },
    ];

    for (const site of sites) {
      fetchMock.mockReset();
      dnsLookupMock.mockReset();
      dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
      fetchMock.mockResolvedValue(new Response("<html>ok</html>", { status: 200 }));

      const { forModel } = await site();
      expect(forModel.toLowerCase()).toMatch(
        /do not fetch|do not retry|try another source|tell them it cannot be read|correct it/,
      );
    }
  });

  it("does not tell the model a 503 means the page is not there", async () => {
    // A server that is down says nothing about whether the page exists. The
    // model reads this reason and passes it on to the reader in its own
    // words, so a wrong one becomes a wrong answer.
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { forModel } = await failureFrom("https://public.example/page");

    expect(forModel).toContain("503");
    expect(forModel).not.toMatch(/not there|not public/i);
  });

  it("does not tell the model how many times the site was asked", async () => {
    // How many deliveries a status cost is not something this side knows. The
    // transport stops early on a Retry-After it will not wait out, so a 503
    // can arrive having been asked for exactly once. Counting it out loud is
    // the model's evidence for how hard it already tried.
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { forModel } = await failureFrom("https://public.example/down");

    expect(forModel).not.toMatch(/three times|3 times|twice|attempts/i);
  });

  it("counts being rate limited as the site's own trouble", async () => {
    // 429 sits with the 5xx rather than with the 4xx it is numbered among:
    // the site is answering and the page is not the problem, it is asking for
    // less traffic. Told it as a 4xx, the model reads "this page is not there
    // or not open to us" and gives up on an address that is fine.
    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));

    const { forModel } = await failureFrom("https://public.example/busy");

    expect(forModel).toMatch(/fault[\s\S]*on their side/i);
    expect(forModel).not.toMatch(/not there or not open/i);
  });

  it("keeps saying a 404 is a page that is not there", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    const { forModel } = await failureFrom("https://public.example/gone");

    expect(forModel).toMatch(/not there|not public/i);
  });

  it("does not call a site that answered unreachable", async () => {
    // It answered 200 and then the body died mid-read. Saying the address
    // could not be reached sends the model looking for a network problem
    // that is not there, and tells the reader an address they just reached
    // is unreachable.
    const body = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new TypeError("terminated"), { name: "TypeError" }));
      },
    });
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const failure = await failureFrom("https://public.example/page");

    expect(failure.forModel).not.toMatch(/could not be reached|unreachable/i);
    expect(failure.readerKey).not.toBe("chat.tool.failure.unreachable");
    // And says which half broke, so the model knows the address is good and
    // one more try is worth it.
    expect(failure.forModel).toMatch(/reading the page/i);
    expect(failure.forModel).toContain("terminated");
  });

  it("gives the model the connection error, not the wrapper around it", async () => {
    // A real connection failure nests twice: the transport wraps a
    // TypeError("fetch failed"), which wraps the error that says what
    // actually happened. Stopping one level down reaches "fetch failed",
    // which reads the same for a refused port, a dead host and a bad
    // certificate.
    const connection = new Error("connect ECONNREFUSED 93.184.216.34:443");
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause: connection });
    fetchMock.mockRejectedValue(wrapped);

    const { forModel } = await failureFrom("https://public.example/page");

    expect(forModel).toContain("ECONNREFUSED");
  });

  it("tells the model a request it can correct is one it can correct", async () => {
    // The transport refuses a URL carrying credentials before any delivery.
    // That is a fact about the request, which the model can fix -- not a
    // fact about the address, which it cannot.
    const failure = await failureFrom("https://user:secret@public.example/page");

    expect(failure.readerKey).not.toBe("chat.tool.failure.unreachable");
    expect(failure.forModel).not.toMatch(/do not retry/i);
  });

  it("calls a stopped fetch stopped, not failed", async () => {
    // The general catch takes both endings. Told apart here because they mean
    // opposite things to the reader: one is something going wrong, the other
    // is them pressing the button.
    const gaveUp = new AbortController();
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
      gaveUp.abort(new Error("user stopped"));
      return Promise.reject(init.signal?.reason ?? new Error("aborted"));
    });

    const failure = await failureFrom("https://public.example/page", gaveUp.signal);

    expect(failure.kind).toBe("user_aborted");
  });

  it("still returns the page when there is one", async () => {
    fetchMock.mockResolvedValue(
      new Response("<p>hello world</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const out = await webFetch.execute?.(
      { url: "https://public.example/page", maxChars: 1000 },
      toolOptions() as never,
    );

    expect(String(out)).toContain("hello world");
  });
});
