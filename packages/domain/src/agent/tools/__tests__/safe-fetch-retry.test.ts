// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one thing this whole batch exists for: a network blip no longer fails
 * the tool.
 *
 * Separate file from the handoff tests because it needs the opposite seam.
 * Those mock `httpRequest` to see what it is told; this one runs the REAL
 * transport and stubs the global `fetch` underneath it, because a mocked
 * transport can only ever prove what a mock does. The transport takes no
 * injected fetch — "the global one is always what runs" — so the global is
 * the only place to stand.
 *
 * What passes here without the batch, measured by putting the pre-move module
 * back and running this file against it: one of the four. `does not replay a
 * 4xx` passes on both versions, because one delivery is one delivery either
 * way — it pins a shape the two share rather than anything the move added.
 * The other three fail on the old code, which is the point: before the move
 * `safeFetch` calls `fetch` once per hop, so the first rejection ends the hop
 * and the error reaches the caller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dnsLookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => dnsLookupMock(...args),
}));

import { safeFetch } from "@domain/agent/tools/safe-fetch.js";

const fetchMock = vi.fn();

describe("a network blip is retried rather than failing the hop", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    dnsLookupMock.mockReset();
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers again when the connection drops, and returns the answer that arrives", async () => {
    // Two dropped connections then an answer. `TypeError` is the shape fetch
    // throws for a connection-level failure, which is exactly the "blip" this
    // batch is named after — and exactly what the old loop could not retry.
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("arrived", { status: 200 }));

    const res = await safeFetch("https://public.example/page");

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("arrived");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("gives up after the transport's budget instead of retrying forever", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    await expect(safeFetch("https://public.example/page")).rejects.toThrow();
    // Three deliveries is the transport's compiled-in cap, not ours.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("does not replay a 4xx, which is a fact about the request", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));

    const res = await safeFetch("https://public.example/page");

    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checks DNS once per hop, not once per delivery", async () => {
    // Both halves of that sentence need measuring, so this runs TWO hops with
    // a blip inside the first: three deliveries, two hops, and the assertion
    // is that DNS was asked twice. A single-hop version would have proved
    // only "not once per delivery" — one check is one check whether the
    // resolve sits inside the redirect loop or above it — and the per-hop
    // half is the load-bearing one, since it is what stops a public host
    // redirecting into the private range.
    //
    // The widening this pins is on the record deliberately: one check now
    // covers up to three connections rather than one.
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://public.example/next" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await safeFetch("https://public.example/page");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);
  }, 15_000);
});
