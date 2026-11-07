// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the web-animation container may write through `r2.local` (inner#1711 design §3.4, §6).
 *
 * Only the two keys its job names, the source package and its Manifest, and only by PUT. Both are stored as
 * `application/octet-stream` whatever the container claims, so no R2 read ever serves generated HTML as a page; the
 * preview route alone answers it as `text/html` under its CSP. The hash and size come from the stored bytes, the same
 * way mini-tool outputs are measured.
 *
 * `storeWebAnimationOutput` is what the container's `r2.local` outbound handler runs; the handler passes the returned
 * measurement on to the job object.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mediaObjectUrl } from "@ingest/media-object-route.js";
import { storeWebAnimationOutput } from "@ingest/jobs/web-animation-container.js";

let run = 0;

/**
 * Keys no other case uses.
 * @returns The job's two keys and a limit.
 */
function job(): { packageKey: string; manifestKey: string; maxPackageBytes: number } {
  run += 1;
  const prefix = `web-animation/p-objects/${run}-${crypto.randomUUID()}`;
  return { packageKey: `${prefix}/index.html`, manifestKey: `${prefix}/manifest.json`, maxPackageBytes: 1_000 };
}

/**
 * The container's request for one key.
 * @param key - The key.
 * @param method - The method.
 * @param body - The bytes it sends.
 * @param contentType - The type it claims.
 * @returns The request.
 */
function asked(key: string, method: string, body?: string, contentType = "text/html"): Request {
  return new Request(mediaObjectUrl(key), {
    method,
    headers: { "content-type": contentType },
    ...(body !== undefined && { body }),
  });
}

/**
 * The SHA-256 of a text, as lowercase hex.
 * @param text - The text.
 * @returns The hash.
 */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("storeWebAnimationOutput", () => {
  it.each(["packageKey", "manifestKey"] as const)("stores the job's %s as application/octet-stream and measures the stored bytes", async (which) => {
    const keys = job();
    const text = which === "packageKey" ? "<!doctype html><title>a</title>" : "{\"schemaVersion\":1}";
    const { response, written } = await storeWebAnimationOutput(asked(keys[which], "PUT", text), env.BUCKET, keys);

    expect(response.status).toBe(200);
    expect(written).toEqual({ key: keys[which], sha256: await sha256(text), bytes: new TextEncoder().encode(text).byteLength });
    const stored = await env.BUCKET.head(keys[which]);
    expect(stored?.httpMetadata?.contentType).toBe("application/octet-stream");
  });

  it("refuses any other key, even under the job's own prefix, and writes nothing", async () => {
    const keys = job();
    const other = keys.packageKey.replace("index.html", "other.html");
    for (const key of [other, "web-animation/p-objects/elsewhere/index.html", "image/2026-11-07/a.png"]) {
      const { response, written } = await storeWebAnimationOutput(asked(key, "PUT", "<p>x</p>"), env.BUCKET, keys);

      expect(response.status).toBe(403);
      expect(written).toBeNull();
      expect(await env.BUCKET.head(key)).toBeNull();
    }
  });

  it.each(["GET", "HEAD", "DELETE", "POST"])("refuses %s on the job's own keys", async (method) => {
    const keys = job();
    await env.BUCKET.put(keys.packageKey, "<p>stored</p>");
    const body = method === "POST" ? "<p>x</p>" : undefined;
    const { response, written } = await storeWebAnimationOutput(asked(keys.packageKey, method, body), env.BUCKET, keys);

    expect(response.status).toBe(405);
    expect(written).toBeNull();
    await expect((await env.BUCKET.get(keys.packageKey))?.text()).resolves.toBe("<p>stored</p>");
  });

  it("answers 413 for a package over the job's maxPackageBytes and reports nothing written", async () => {
    const keys = job();
    const { response, written } = await storeWebAnimationOutput(asked(keys.packageKey, "PUT", "x".repeat(keys.maxPackageBytes + 1)), env.BUCKET, keys);

    expect(response.status).toBe(413);
    expect(written).toBeNull();
  });

  it("accepts a package of exactly maxPackageBytes", async () => {
    const keys = job();
    const { response, written } = await storeWebAnimationOutput(asked(keys.packageKey, "PUT", "x".repeat(keys.maxPackageBytes)), env.BUCKET, keys);

    expect(response.status).toBe(200);
    expect(written?.bytes).toBe(keys.maxPackageBytes);
  });
});
