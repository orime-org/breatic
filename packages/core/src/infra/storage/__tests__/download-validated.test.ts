// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for `downloadValidated` — the shared transfer-stream
 * completeness guard used by every StorageAdapter.persistFromUrl.
 * Asset-layer hardening (adversarial holes #3 truncation + #5 zero-byte):
 * a silently-truncated or empty download must NOT be hashed / stored /
 * billed as a complete asset — it must throw so the worker's Stage-2
 * persist-failure path runs (markFailed + no charge).
 *
 * Retries moved into the shared HTTP transport, which changed two things
 * here. The stub is now a real `Response` rather than an object carrying
 * only `arrayBuffer`: the transport reads bodies as streams, and a stub
 * without one cannot exercise that path — nor could the old stub have
 * reproduced a stalled body at all. And the retry count is no longer a
 * parameter, so the tests inject a no-op wait instead of a zero backoff.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { downloadValidated } from "@core/infra/storage/index.js";

/** Skip the transport's real backoff without changing its retry count. */
const noWait = { sleepImpl: async (): Promise<void> => undefined };

/**
 * Build a real Response for the mocked global fetch.
 *
 * Real rather than hand-rolled so the body is a stream, `ok` derives from
 * the status, and header access behaves exactly as in production.
 * @param body - The bytes the "server" returns.
 * @param headers - Response headers (content-length / content-type).
 * @param status - The HTTP status code.
 * @returns A Response the transport can read like any other.
 */
function fakeResponse(
  body: Buffer,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body.length === 0 ? null : new Uint8Array(body), {
    status,
    headers,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadValidated", () => {
  it("returns buffer + contentType when the download is complete", async () => {
    const body = Buffer.from("hello world");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(body, {
          "content-length": String(body.length),
          "content-type": "image/png",
        }),
      ),
    );
    const res = await downloadValidated("https://cdn/x.png", noWait);
    expect(res.buffer.length).toBe(body.length);
    expect(res.contentType).toBe("image/png");
  });

  it("throws when content-length disagrees with the received bytes (truncation)", async () => {
    const body = Buffer.from("only 12 bytes");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(body, {
          // server promised 9999 bytes, delivered fewer
          "content-length": "9999",
          "content-type": "video/mp4",
        }),
      ),
    );
    await expect(
      downloadValidated("https://cdn/trunc.mp4", noWait),
    ).rejects.toThrow(/truncat/i);
  });

  it("does NOT retry a truncated body — it is a permanent failure", async () => {
    // Retrying would re-download and re-hash content we already know is
    // wrong. The completeness checks run after the transport has returned,
    // so they are outside its retry budget by construction; this pins that.
    const body = Buffer.from("short");
    const fetchFn = vi.fn(async () =>
      fakeResponse(body, { "content-length": "9999" }),
    );
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      downloadValidated("https://cdn/trunc.bin", noWait),
    ).rejects.toThrow(/truncat/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws on a zero-byte body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(Buffer.alloc(0), {
          "content-length": "0",
          "content-type": "image/png",
        }),
      ),
    );
    await expect(
      downloadValidated("https://cdn/empty.png", noWait),
    ).rejects.toThrow(/empty|0 bytes/i);
  });

  it("throws on a non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(Buffer.from("err"), {}, 500)),
    );
    await expect(downloadValidated("https://cdn/boom", noWait)).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("passes when content-length header is absent (only bytes known)", async () => {
    const body = Buffer.from("no length header");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(body, { "content-type": "application/octet-stream" }),
      ),
    );
    const res = await downloadValidated("https://cdn/nolen", noWait);
    expect(res.buffer.length).toBe(body.length);
  });

  it("does NOT read a content-encoded (gzip) response as truncated", async () => {
    // content-length is the COMPRESSED size; fetch auto-decompresses, so the
    // decoded body is longer — the equality check must be skipped (#B).
    const body = Buffer.from("decompressed body longer than the compressed one");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(body, {
          "content-length": "12",
          "content-encoding": "gzip",
          "content-type": "application/json",
        }),
      ),
    );
    const res = await downloadValidated("https://cdn/g.json.gz", noWait);
    expect(res.buffer.length).toBe(body.length);
  });

  it("asks for an identity transfer so truncation stays detectable", async () => {
    // Without this header a truncated gzip stream decodes to partial bytes
    // with no error at all (measured, adversarial #B round-3), and the
    // length check above silently stops protecting anything.
    const body = Buffer.from("payload");
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(body, { "content-length": String(body.length) }),
    );
    vi.stubGlobal("fetch", fetchFn);

    await downloadValidated("https://cdn/x.bin", noWait);

    const sent = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(sent.get("accept-encoding")).toBe("identity");
  });

  it("retries a transient 5xx then succeeds (#E)", async () => {
    const body = Buffer.from("eventually ok");
    const responses = [
      fakeResponse(Buffer.from("x"), {}, 503),
      fakeResponse(Buffer.from("x"), {}, 429),
      fakeResponse(body, {
        "content-length": String(body.length),
        "content-type": "image/png",
      }),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]!);
    vi.stubGlobal("fetch", fetchFn);
    const res = await downloadValidated("https://cdn/flaky.png", noWait);
    expect(res.buffer.length).toBe(body.length);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("retries a dropped connection — the likeliest failure on this path", async () => {
    // The loop this replaced retried HTTP 5xx and 429 only, so a connection
    // dropped mid-download failed the whole generation AFTER the credits had
    // been spent. That is the failure a CDN actually produces.
    const body = Buffer.from("second time lucky");
    let i = 0;
    const fetchFn = vi.fn(async () => {
      i += 1;
      if (i === 1) throw new Error("ECONNRESET");
      return fakeResponse(body, { "content-length": String(body.length) });
    });
    vi.stubGlobal("fetch", fetchFn);

    const res = await downloadValidated("https://cdn/flaky.bin", noWait);

    expect(res.buffer.length).toBe(body.length);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on a persistent 5xx", async () => {
    const fetchFn = vi.fn(async () => fakeResponse(Buffer.from("x"), {}, 503));
    vi.stubGlobal("fetch", fetchFn);
    await expect(downloadValidated("https://cdn/down", noWait)).rejects.toThrow(
      /HTTP 503/,
    );
    // Three deliveries: the first attempt plus the transport's two replays.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a permanent 4xx", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(Buffer.from("nope"), {}, 404),
    );
    vi.stubGlobal("fetch", fetchFn);
    await expect(downloadValidated("https://cdn/gone", noWait)).rejects.toThrow(
      /HTTP 404/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
