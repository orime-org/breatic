// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Every request the page reader's browser makes leaves through this one
 * function (inner#1664, design §6.3). The URL comes from a model, so an
 * address that names a machine directly (an IP literal, localhost) must never
 * be sent; every other host is sent again by the Worker with redirects handed
 * back to the browser, so each hop of a redirect chain comes through here and
 * is judged again.
 *
 * Pure logic with an injected `send`: runs on Node.
 */

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { webReaderOutbound, type SendOn } from "@ingest/web-reader-outbound.js";

/** A `send` that answers 200 and records what it was given. */
function sendRecording(answer: () => Response = () => new Response("page", { status: 200 })): ReturnType<typeof vi.fn<SendOn>> {
  return vi.fn<SendOn>(() => Promise.resolve(answer()));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webReaderOutbound refuses addresses that name a machine directly", () => {
  it.each([
    "http://127.0.0.1/",
    "https://127.0.0.1/",
    "http://127.0.0.1:8080/admin",
    "http://10.0.0.1/",
    "https://10.0.0.1/internal",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    // Spellings the URL parser turns into 127.0.0.1.
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::1]/",
    "https://[::1]:8443/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "https://localhost/",
    "http://LOCALHOST:3000/",
    "http://a.localhost/",
    "https://deep.a.localhost/x",
  ])("answers 403 for %s and never sends it", async (url) => {
    const send = sendRecording();

    const response = await webReaderOutbound(new Request(url), send);

    expect(response.status).toBe(403);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it("refuses every IPv4 literal over http and https", async () => {
    await fc.assert(
      fc.asyncProperty(fc.ipV4(), fc.constantFrom("http", "https"), async (ip, scheme) => {
        const send = sendRecording();
        const response = await webReaderOutbound(new Request(`${scheme}://${ip}/page`), send);
        expect(response.status).toBe(403);
        expect(send).toHaveBeenCalledTimes(0);
      }),
    );
  });

  it("refuses every IPv6 literal over http and https", async () => {
    await fc.assert(
      fc.asyncProperty(fc.ipV6(), fc.constantFrom("http", "https"), async (ip, scheme) => {
        const send = sendRecording();
        const response = await webReaderOutbound(new Request(`${scheme}://[${ip}]/page`), send);
        expect(response.status).toBe(403);
        expect(send).toHaveBeenCalledTimes(0);
      }),
    );
  });
});

describe("webReaderOutbound sends public host names on", () => {
  it.each(["http://example.com/a", "https://example.com/a?b=1", "https://news.example.org:443/path"])(
    "passes %s to send exactly once with the same request and manual redirects",
    async (url) => {
      const send = sendRecording();
      const request = new Request(url);

      const response = await webReaderOutbound(request, send);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("page");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe(request);
      expect(send.mock.calls[0]?.[1]).toEqual({ redirect: "manual" });
    },
  );

  it("sends every public domain name once, over http and https", async () => {
    const domain = fc
      .domain()
      .filter((host) => !/(^|\.)localhost$/i.test(host) && !/^[\d.]+$/.test(host));
    await fc.assert(
      fc.asyncProperty(domain, fc.constantFrom("http", "https"), async (host, scheme) => {
        const send = sendRecording();
        const request = new Request(`${scheme}://${host}/page`);
        const response = await webReaderOutbound(request, send);
        expect(response.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0]).toBe(request);
        expect(send.mock.calls[0]?.[1]).toEqual({ redirect: "manual" });
      }),
    );
  });

  // The browser follows the redirect itself, so its next request — wherever
  // the Location points — comes back through this function and is judged.
  it.each([301, 302, 303, 307, 308])(
    "hands a %i answer back unchanged so the browser follows it",
    async (status) => {
      const send = sendRecording(
        () => new Response(null, { status, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
      );

      const response = await webReaderOutbound(new Request("https://example.com/moved"), send);

      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
    },
  );

  it("refuses the next hop when a redirect points at a private address", async () => {
    const send = sendRecording(
      () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/secret" } }),
    );

    const first = await webReaderOutbound(new Request("https://example.com/moved"), send);
    const next = await webReaderOutbound(new Request(first.headers.get("location") ?? ""), send);

    expect(first.status).toBe(302);
    expect(next.status).toBe(403);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch when no send is given", async () => {
    const fetchStub = vi.fn<SendOn>(() => Promise.resolve(new Response("from fetch", { status: 200 })));
    vi.stubGlobal("fetch", fetchStub);
    const request = new Request("https://example.com/default");

    const response = await webReaderOutbound(request);

    await expect(response.text()).resolves.toBe("from fetch");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[0]).toBe(request);
    expect(fetchStub.mock.calls[0]?.[1]).toEqual({ redirect: "manual" });
  });
});
