// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How long a stopped turn waits on `web_fetch`.
 *
 * The turn cannot end before its tools do. Measured with a real `streamText`
 * on ai@7.0.58: with the signal raised while a tool was running, the stream
 * produced nothing further until that tool returned of its own accord — 4
 * seconds for a tool that ignored its signal, 8 milliseconds for one that did
 * not. So the promise that a stop takes about a second is kept here or nowhere.
 *
 * A fetch is not one waiting place but several, and the transport only owns
 * the middle ones. Two lie outside it, and they are what this file is about:
 *
 *   - before each hop, `safeFetch` resolves the host and decides whether it is
 *     allowed. A redirect chain walks that loop once per hop, and without a
 *     check it keeps walking after the caller has gone.
 *   - after the transport hands back a `Response`, reading its body is the
 *     application's own business — the package boundary says so outright and
 *     names `response.body?.cancel()` as the way to stop it. A server that
 *     sends 200 and its headers and then stalls leaves that read hanging, and
 *     the transport's deadline is already cleared by then.
 *
 * The seam is DNS plus the global `fetch`, the same one `safe-fetch-retry`
 * uses and for the same reason: the transport takes no injected fetch, so the
 * global is the only place to stand. A real local server cannot be used here
 * at all — `safeFetch` refuses loopback addresses by design, so every request
 * to one is rejected before a socket is opened. An earlier draft of this file
 * did exactly that and all of its cases passed against the unfixed code,
 * because nothing was ever being cancelled: nothing was ever being sent.
 *
 * One place is genuinely uninterruptible and is stated rather than tested:
 * `node:dns/promises` `lookup` ignores an abort signal outright — measured, it
 * resolved an address from a signal that was already raised. It goes through
 * the system resolver on a thread pool and, unlike `Resolver.resolve4`, offers
 * no cancel. So a lookup already under way runs to its end, and the bound
 * carries that much slack.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dnsLookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

import { safeFetch } from "@domain/agent/tools/safe-fetch.js";
import { webFetch } from "@domain/agent/tools/web-fetch.js";

const fetchMock = vi.fn();

/** The options shape the SDK hands a tool's `execute`. */
const toolOptions = (signal: AbortSignal): Record<string, unknown> => ({
  abortSignal: signal,
  toolCallId: "t1",
  messages: [],
});

/**
 * A response whose headers are through and whose body never finishes.
 *
 * The body errors when the request's signal is raised, which is what a real
 * `fetch` does and what a stub that leaves it out gets wrong. An earlier draft
 * of this file left it out, and the omission mattered: it made the tool look
 * as though it needed a reader of its own to stop a stalled read, when the
 * transport's own composed signal already ends it.
 * @param signal - The one the transport composed into this request.
 * @returns A response that stalls until the signal says otherwise.
 */
function stalledBody(signal?: AbortSignal): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("the beginning of a page"));
        // Never closed. The only thing that ends this is the signal.
        signal?.addEventListener("abort", () => {
          controller.error(signal.reason ?? new Error("aborted"));
        });
      },
    }),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
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

describe("safeFetch when the caller has given up", () => {
  it("does not start a hop, and does not even resolve the host", async () => {
    const gaveUp = new AbortController();
    gaveUp.abort(new Error("user stopped"));

    await expect(
      safeFetch("https://public.example/page", { signal: gaveUp.signal }),
    ).rejects.toThrow();

    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not walk on to the next hop", async () => {
    // The check has to be inside the loop, not before it. A redirect chain is
    // where the difference shows: the first hop was already under way when the
    // caller gave up, and it is the SECOND that must not happen.
    const gaveUp = new AbortController();
    fetchMock.mockImplementationOnce(() => {
      gaveUp.abort(new Error("user stopped"));
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "https://public.example/next" } }),
      );
    });

    await expect(
      safeFetch("https://public.example/page", { signal: gaveUp.signal }),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands the signal down to the transport", async () => {
    // The transport composes it with each delivery's deadline. Asserting on
    // the signal `fetch` was given is the only place that composition is
    // visible from outside.
    const gaveUp = new AbortController();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    await safeFetch("https://public.example/page", { signal: gaveUp.signal });

    const passed = (fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed?.aborted).toBe(false);
    gaveUp.abort(new Error("user stopped"));
    expect(passed?.aborted).toBe(true);
  });
});

describe("web_fetch when the turn is stopped", () => {
  it("stops while the body is still arriving", async () => {
    // A page that answers 200 and then stalls. The tool reads the body plainly
    // and carries no cancellation code of its own: what ends this read is the
    // signal the transport composed into the request, which stays attached to
    // the response after the transport has handed it over. That is a promise
    // the transport's boundary doc states, and this is the tool's side of it.
    const gaveUp = new AbortController();
    fetchMock.mockImplementation((_url: string, init: { signal?: AbortSignal }) =>
      Promise.resolve(stalledBody(init.signal)),
    );
    setTimeout(() => gaveUp.abort(new Error("user stopped")), 80);

    const started = Date.now();
    // It throws rather than returns, and says which of the two endings this
    // is: a stopped read is the user's doing, not something going wrong.
    // Awaited bare before, from when a stop came back as a string.
    await expect(
      webFetch.execute?.(
        { url: "https://public.example/page", maxChars: 1000 },
        toolOptions(gaveUp.signal) as never,
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads the body normally when nobody gave up", async () => {
    // The other half of the same change: racing the read against a signal must
    // not cost the read. A tool that returned early on every fetch would pass
    // the test above and be useless.
    const never = new AbortController();
    fetchMock.mockResolvedValue(
      new Response("hello world", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const out = await webFetch.execute?.(
      { url: "https://public.example/page", maxChars: 1000 },
      toolOptions(never.signal) as never,
    );
    expect(JSON.parse(out as string)).toMatchObject({ text: "hello world", status: 200 });
  });
});
