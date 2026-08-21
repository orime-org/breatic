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
