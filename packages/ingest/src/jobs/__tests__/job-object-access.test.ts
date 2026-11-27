// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mediaObjectUrl } from "@ingest/media-object-route.js";
import { serveJobObjects } from "@ingest/jobs/job-objects.js";
import { head } from "../../__tests__/helpers/encoder-heads.js";

const A = "plan-access/source-a.mp4";
const B = "plan-access/source-b.mp4";
const OTHER = "plan-access/source-c.mp4";
const MAIN = "plan-access/result-8.png";
const COVER = "plan-access/result-8.cover.png";
const JSON_KEY = "plan-access/analysis.json";
const ATTEMPT = "30000000-0000-4000-8000-000000000001";
const ACCESS = { reads: [A, B], writes: { [MAIN]: "image/png", [COVER]: "image/png", [JSON_KEY]: "text/plain" }, attemptId: ATTEMPT };

beforeAll(async () => {
  await env.BUCKET.put(A, new Uint8Array([0, 1, 2, 3]));
  await env.BUCKET.put(B, new Uint8Array([10, 11, 12, 13]));
  await env.BUCKET.put(OTHER, new Uint8Array([20, 21, 22, 23]));
});

/** The allowlist suite stands in only for the separate durable claim boundary. */
const CLAIM = "40000000-0000-4000-8000-000000000001";

/**
 * Supply a deterministic grant in this allowlist/measurement suite.
 * Actual durable exclusion uses the production outbound and real DO in plan-write-claims.test.ts.
 * @returns The controlled opaque grant token.
 * @throws {never} Never.
 */
async function allowTestWrite(): Promise<string> { return CLAIM; }

/**
 * Name an exact issued object and the current attempt capability.
 * @param key - The issued storage key.
 * @param attempt - The immutable container attempt.
 * @returns Its internal URL.
 * @throws {never} Never.
 */
function url(key: string, attempt = ATTEMPT): string {
  return `${mediaObjectUrl(key)}?attempt=${attempt}`;
}

describe("planned job real workerd R2 capabilities", () => {
  it("reads both declared sources and preserves actual R2 range behavior", async () => {
    const note = vi.fn();
    for (const [key, bytes] of [[A, [0, 1, 2, 3]], [B, [10, 11, 12, 13]]] as const) {
      const response = await serveJobObjects(new Request(url(key)), env.BUCKET, ACCESS, note, allowTestWrite);
      expect(response.status).toBe(200);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(bytes);
    }
    const range = await serveJobObjects(new Request(url(B), { headers: { range: "bytes=1-2" } }), env.BUCKET, ACCESS, note, allowTestWrite);
    expect(range.status).toBe(206);
    expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([11, 12]);
    expect(note).not.toHaveBeenCalled();
  });

  it("answers HEAD for either frozen source", async () => {
    for (const key of [A, B]) {
      const response = await serveJobObjects(new Request(url(key), { method: "HEAD" }), env.BUCKET, ACCESS, vi.fn(), allowTestWrite);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("4");
      await response.body?.cancel();
    }
  });

  it("refuses unknown sources, outside hosts and stale attempt capabilities", async () => {
    for (const request of [new Request(url(OTHER)), new Request(url(A, "old-attempt")), new Request(mediaObjectUrl(A)), new Request(url(A).replace("r2.local", "external.example"))]) {
      const response = await serveJobObjects(request, env.BUCKET, ACCESS, vi.fn(), allowTestWrite);
      expect(response.status).toBe(403);
      await response.body?.cancel();
    }
  });

  it("writes only each exact issued main/cover key and measures stored PNG bytes", async () => {
    const png = head("png");
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", png)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    for (const key of [MAIN, COVER]) {
      const note = vi.fn();
      const response = await serveJobObjects(new Request(url(key), { method: "PUT", body: png }), env.BUCKET, ACCESS, note, allowTestWrite);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await (await env.BUCKET.get(key))!.arrayBuffer())).toEqual(png);
      expect(note).toHaveBeenCalledExactlyOnceWith(key, { sha256: digest, sizeBytes: png.length, contentType: "image/png" }, ATTEMPT, CLAIM);
    }
  });

  it("does not grant writes to source, adjacent chunk or undeclared cover keys", async () => {
    for (const key of [A, B, "plan-access/result-16.png", "plan-access/result-8.cover.webp"]) {
      const note = vi.fn();
      const response = await serveJobObjects(new Request(url(key), { method: "PUT", body: head("png") }), env.BUCKET, ACCESS, note, allowTestWrite);
      expect(response.status).toBe(403);
      expect(note).not.toHaveBeenCalled();
    }
    expect([...new Uint8Array(await (await env.BUCKET.get(A))!.arrayBuffer())]).toEqual([0, 1, 2, 3]);
  });

  it("registers complete JSON bytes under the actual text/plain sniff result", async () => {
    const bytes = new TextEncoder().encode('{"cuts":[{"frameIndex":30,"pts":9.3,"detectionScore":85}]}');
    const note = vi.fn();
    const response = await serveJobObjects(new Request(url(JSON_KEY), { method: "PUT", body: bytes, headers: { "content-type": "application/json" } }), env.BUCKET, ACCESS, note, allowTestWrite);
    expect(response.status).toBe(200);
    expect(note.mock.calls[0]?.[1]).toMatchObject({ sizeBytes: bytes.length, contentType: "text/plain" });
    expect(await (await env.BUCKET.get(JSON_KEY))!.text()).toBe(new TextDecoder().decode(bytes));
  });

  it("supports the legacy single-source access without broadening it", async () => {
    const legacy = { reads: [A], writes: { [MAIN]: "image/png" } };
    const allowed = await serveJobObjects(new Request(mediaObjectUrl(A)), env.BUCKET, legacy, vi.fn());
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
    const denied = await serveJobObjects(new Request(mediaObjectUrl(B)), env.BUCKET, legacy, vi.fn());
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
  });
});
