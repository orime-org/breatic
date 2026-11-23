// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the two web-animation containers may read and write through `r2.local` (#1490 design §5.2, §6.1, §6.3).
 *
 * A container reads only the one package its job names (a modification's base, an export's source) and only by GET.
 * The render container writes only the video and cover keys its job names, by PUT, and the stored bytes are hashed,
 * measured and typed from what landed, as mini-tool outputs are, because registration takes those three from here.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { head } from "@ingest/__tests__/helpers/encoder-heads.js";
import { mediaObjectUrl } from "@ingest/media-object-route.js";
import { readWebAnimationPackage } from "@ingest/jobs/web-animation-container.js";
import { storeWebAnimationRenderOutput } from "@ingest/jobs/web-animation-render-container.js";

/**
 * The container's request for one key.
 * @param key - The key.
 * @param method - The method.
 * @param body - The bytes it sends.
 * @returns The request.
 */
function asked(key: string, method: string, body?: Uint8Array): Request {
  return new Request(mediaObjectUrl(key), { method, ...(body !== undefined && { body }) });
}

/**
 * Keys no other case uses.
 * @returns A package key and the two output keys.
 */
function keys(): { packageKey: string; videoKey: string; coverKey: string } {
  const id = crypto.randomUUID();
  return { packageKey: `web-animation/p-render/${id}/index.html`, videoKey: `generated/render/${id}.mp4`, coverKey: `generated/render/${id}_cover.png` };
}

/**
 * The SHA-256 of some bytes, as lowercase hex.
 * @param bytes - The bytes.
 * @returns The hash.
 */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("readWebAnimationPackage", () => {
  it("serves the one package the job names", async () => {
    const { packageKey } = keys();
    await env.BUCKET.put(packageKey, "<!doctype html><p>base</p>");
    const res = await readWebAnimationPackage(asked(packageKey, "GET"), env.BUCKET, packageKey);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html><p>base</p>");
  });

  it("refuses any other key, and every key when the job names none", async () => {
    const { packageKey } = keys();
    await env.BUCKET.put(packageKey, "<p>base</p>");
    expect((await readWebAnimationPackage(asked("web-animation/p-render/other/index.html", "GET"), env.BUCKET, packageKey)).status).toBe(403);
    expect((await readWebAnimationPackage(asked(packageKey, "GET"), env.BUCKET, null)).status).toBe(403);
  });

  it.each(["PUT", "DELETE", "POST"])("refuses %s on the package", async (method) => {
    const { packageKey } = keys();
    await env.BUCKET.put(packageKey, "<p>base</p>");
    const body = method === "DELETE" ? undefined : new TextEncoder().encode("<p>x</p>");
    expect((await readWebAnimationPackage(asked(packageKey, method, body), env.BUCKET, packageKey)).status).toBe(405);
    await expect((await env.BUCKET.get(packageKey))?.text()).resolves.toBe("<p>base</p>");
  });
});

describe("storeWebAnimationRenderOutput", () => {
  it.each([["videoKey", "mp4", "video/mp4"], ["coverKey", "png", "image/png"]] as const)(
    "stores the job's %s and measures the stored bytes",
    async (which, sample, contentType) => {
      const job = keys();
      const bytes = head(sample);
      const { response, written } = await storeWebAnimationRenderOutput(asked(job[which], "PUT", bytes), env.BUCKET, job);
      expect(response.status).toBe(200);
      expect(written).toEqual({ key: job[which], sha256: await sha256(bytes), sizeBytes: bytes.byteLength, contentType });
    },
  );

  it("refuses any other key and writes nothing", async () => {
    const job = keys();
    for (const key of [job.packageKey, `generated/render/${crypto.randomUUID()}.mp4`]) {
      const { response, written } = await storeWebAnimationRenderOutput(asked(key, "PUT", head("mp4")), env.BUCKET, job);
      expect(response.status).toBe(403);
      expect(written).toBeNull();
      expect(await env.BUCKET.head(key)).toBeNull();
    }
  });

  it.each(["GET", "DELETE", "POST"])("refuses %s on the output keys", async (method) => {
    const job = keys();
    const body = method === "POST" ? head("mp4") : undefined;
    const { response, written } = await storeWebAnimationRenderOutput(asked(job.videoKey, method, body), env.BUCKET, job);
    expect(response.status).toBe(405);
    expect(written).toBeNull();
  });
});
