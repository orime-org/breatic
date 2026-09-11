// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The one object a media container is allowed to read (#209 + #210, design §3.3).
 *
 * The container has no route to the internet and no credentials. Every request
 * it makes is intercepted here and answered from the R2 binding — and answered
 * only for the key this run was started for, because what runs in there is
 * ffmpeg parsing bytes a user uploaded. A crafted file that talks ffmpeg into
 * fetching something else is the shape #215 records; this is where it ends.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { serveOneObject } from "@ingest/media-object-route.js";

const KEY = "video/2026-09-10/1_probe.mp4";
const BYTES = new Uint8Array(1024).map((_, i) => i % 256);

beforeAll(async () => {
  await env.BUCKET.put(KEY, BYTES);
  await env.BUCKET.put("video/2026-09-10/1_someone-elses.mp4", new Uint8Array(8));
});

/**
 * Ask for one key, as the container's own HTTP client would.
 * @param path - The path the container requested.
 * @param range - Its Range header, when it sent one.
 * @returns What the outbound handler answers.
 */
async function ask(path: string, range?: string): Promise<Response> {
  return serveOneObject(
    new Request(`http://r2.local/${path}`, {
      ...(range !== undefined && { headers: { range } }),
    }),
    env.BUCKET,
    KEY,
  );
}

describe("the key this run was started for", () => {
  it("serves the whole object when no range was asked for", async () => {
    const res = await ask(KEY);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1024");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("serves one range, which is how ffmpeg reads a container's header", async () => {
    const res = await ask(KEY, "bytes=100-199");

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1024");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toHaveLength(100);
    expect(body[0]).toBe(BYTES[100]);
  });

  it("serves an open-ended range, which is the other shape ffmpeg sends", async () => {
    const res = await ask(KEY, "bytes=1000-");

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1000-1023/1024");
    expect(await res.arrayBuffer()).toHaveProperty("byteLength", 24);
  });

  it("serves a suffix range, which is how it finds a trailing index", async () => {
    const res = await ask(KEY, "bytes=-24");

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1000-1023/1024");
  });
});

describe("anything else the container asks for", () => {
  it("refuses another object in the same bucket", async () => {
    const res = await ask("video/2026-09-10/1_someone-elses.mp4");

    expect(res.status).toBe(403);
  });

  it("refuses a key reached by traversing out of this one", async () => {
    // The runtime resolves `..` before the request arrives, so what matters is
    // where a path ends up. Out of this key and into another one is refused
    // like any other name for that object.
    const res = await ask(`${KEY}/../1_someone-elses.mp4`);

    expect(res.status).toBe(403);
  });

  it("serves a longer spelling of this very key", async () => {
    // Resolves back to the key this run was started for, so it is a read of
    // that key — the object served is the authorised one either way.
    const res = await ask(`other/../${KEY}`);

    expect(res.status).toBe(200);
  });

  it("answers 404 for a key that is gone, without saying anything else", async () => {
    // The key it was started for, deleted between the start and the read. The
    // container learns the object is not there; nothing else changes.
    await env.BUCKET.delete(KEY);
    const res = await ask(KEY);
    await env.BUCKET.put(KEY, BYTES);

    expect(res.status).toBe(404);
  });
});

// ffmpeg sends whatever its reader decides on, and a range past the end of the
// object is a real answer to give: the standard has a status for it, and
// falling back to the whole object would stream a two-gigabyte video into the
// container in place of the kilobytes it asked for.
describe("a range the object cannot satisfy", () => {
  it("refuses it rather than serving everything", async () => {
    const key = "video/2026-09-10/unsatisfiable.mp4";
    await env.BUCKET.put(key, new Uint8Array(100));

    const response = await serveOneObject(
      new Request(`http://r2.local/${key}`, {
        headers: { range: "bytes=500-600" },
      }),
      env.BUCKET,
      key,
    );

    expect(response.status).toBe(416);
    expect(await response.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });
});
