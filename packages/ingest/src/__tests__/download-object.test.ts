// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Serving a stored object as a download.
 *
 * The browser's own download list is reached one way only: a navigation whose
 * answer carries `Content-Disposition: attachment`. The bucket's public domain
 * cannot add that header on a plan without regex in Rules, so the header is
 * written here, where it costs nothing and is the same on every deployment.
 */

import { createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker from "@ingest/index.js";

const KEY = "image/2026-08-13/1786583290640_0c24.png";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** Ask the Worker for one download URL. */
async function download(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

beforeAll(async () => {
  await env.BUCKET.put(KEY, BYTES, {
    httpMetadata: { contentType: "image/png" },
  });
});

describe("downloading a stored object", () => {
  it("answers the bytes", async () => {
    const response = await download(`/download/${KEY}/cover.png`);

    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...BYTES]);
  });

  it("tells the browser to download rather than display", async () => {
    const response = await download(`/download/${KEY}/cover.png`);

    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("keeps the type the object was stored under", async () => {
    const response = await download(`/download/${KEY}/cover.png`);

    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("names the file with the last path segment", async () => {
    const response = await download(`/download/${KEY}/cover.png`);

    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''cover.png",
    );
  });

  it("carries a non-ASCII name through percent encoding", async () => {
    const name = encodeURIComponent("封面.png");
    const response = await download(`/download/${KEY}/${name}`);

    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${name}`,
    );
  });

  it("encodes the characters RFC 5987 does not allow raw", async () => {
    const response = await download(`/download/${KEY}/a'b(c)d*e.png`);

    const said = response.headers.get("content-disposition") ?? "";
    expect(said).toContain("filename*=UTF-8''a%27b%28c%29d%2Ae.png");
  });

  it("cannot be made to carry a second header line", async () => {
    const name = encodeURIComponent('x"\r\nX-Injected: 1.png');
    const response = await download(`/download/${KEY}/${name}`);

    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("content-disposition")).not.toContain("\n");
  });

  it("answers 404 for a key nothing was stored under", async () => {
    const response = await download("/download/image/nothing-here.png/x.png");

    expect(response.status).toBe(404);
  });

  it("answers a range request with just that range", async () => {
    const response = await download(`/download/${KEY}/cover.png`, {
      headers: { range: "bytes=2-4" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/8");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([3, 4, 5]);
  });

  it("says ranges are supported so a paused download can resume", async () => {
    const response = await download(`/download/${KEY}/cover.png`);

    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers a HEAD with the headers and no body", async () => {
    const response = await download(`/download/${KEY}/cover.png`, {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.body).toBeNull();
  });

  it("refuses a method that is not a read", async () => {
    const response = await download(`/download/${KEY}/cover.png`, {
      method: "DELETE",
    });

    expect(response.status).toBe(405);
  });
});
