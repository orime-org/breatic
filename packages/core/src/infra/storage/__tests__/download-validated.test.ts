// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Unit tests for `downloadValidated` — the shared transfer-stream
 * completeness guard used by every StorageAdapter.persistFromUrl.
 * Asset-layer hardening (adversarial holes #3 truncation + #5 zero-byte):
 * a silently-truncated or empty download must NOT be hashed / stored /
 * billed as a complete asset — it must throw so the worker's Stage-2
 * persist-failure path runs (markFailed + no charge).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { downloadValidated } from "@core/infra/storage/index.js";

/**
 * Build a Response-like stub for the mocked global fetch.
 * @param body - The bytes the "server" returns.
 * @param headers - Response headers (content-length / content-type).
 * @param ok - Whether the HTTP status is 2xx.
 * @param status - The HTTP status code.
 * @returns A minimal Response-shaped object.
 */
function fakeResponse(
  body: Buffer,
  headers: Record<string, string>,
  ok = true,
  status = 200,
): Response {
  const h = new Headers(headers);
  return {
    ok,
    status,
    headers: h,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
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
    const res = await downloadValidated("https://cdn/x.png");
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
    await expect(downloadValidated("https://cdn/trunc.mp4")).rejects.toThrow(
      /truncat/i,
    );
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
    await expect(downloadValidated("https://cdn/empty.png")).rejects.toThrow(
      /empty|0 bytes/i,
    );
  });

  it("throws on a non-OK HTTP status (maxAttempts=1 → no retry)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(Buffer.from("err"), {}, false, 500)),
    );
    await expect(
      downloadValidated("https://cdn/boom", { maxAttempts: 1 }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("passes when content-length header is absent (only bytes known)", async () => {
    const body = Buffer.from("no length header");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse(body, { "content-type": "application/octet-stream" }),
      ),
    );
    const res = await downloadValidated("https://cdn/nolen");
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
    const res = await downloadValidated("https://cdn/g.json.gz");
    expect(res.buffer.length).toBe(body.length);
  });

  it("retries a transient 5xx then succeeds (#E)", async () => {
    const body = Buffer.from("eventually ok");
    const responses = [
      fakeResponse(Buffer.from("x"), {}, false, 503),
      fakeResponse(Buffer.from("x"), {}, false, 429),
      fakeResponse(body, {
        "content-length": String(body.length),
        "content-type": "image/png",
      }),
    ];
    let i = 0;
    const fetchFn = vi.fn(async () => responses[i++]!);
    vi.stubGlobal("fetch", fetchFn);
    const res = await downloadValidated("https://cdn/flaky.png", {
      maxAttempts: 3,
      retryBackoffMs: 0,
    });
    expect(res.buffer.length).toBe(body.length);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting retries on a persistent 5xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(Buffer.from("x"), {}, false, 503)),
    );
    await expect(
      downloadValidated("https://cdn/down", { maxAttempts: 2, retryBackoffMs: 0 }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("does NOT retry a permanent 4xx", async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(Buffer.from("nope"), {}, false, 404),
    );
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      downloadValidated("https://cdn/gone", { maxAttempts: 3, retryBackoffMs: 0 }),
    ).rejects.toThrow(/HTTP 404/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
