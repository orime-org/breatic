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

  it("throws on a non-OK HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(Buffer.from("err"), {}, false, 500)),
    );
    await expect(downloadValidated("https://cdn/boom")).rejects.toThrow(
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
    const res = await downloadValidated("https://cdn/nolen");
    expect(res.buffer.length).toBe(body.length);
  });
});
