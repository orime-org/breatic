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

/** Store one object and ask for it back as a download. */
async function storeThenDownload(key: string): Promise<Response> {
  await env.BUCKET.put(key, BYTES, { httpMetadata: { contentType: "image/png" } });
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return download(`/download/${encoded}`);
}

beforeAll(async () => {
  await env.BUCKET.put(KEY, BYTES, {
    httpMetadata: { contentType: "image/png" },
  });
});

describe("downloading a stored object", () => {
  it("answers the bytes", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.status).toBe(200);
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...BYTES]);
  });

  it("tells the browser to download rather than display", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("keeps the type the object was stored under", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("names the file after the key's last segment", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''1786583290640_0c24.png",
    );
  });

  it("carries a non-ASCII key segment through percent encoding", async () => {
    const response = await storeThenDownload("image/2026-08-13/封面.png");

    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("封面.png")}`,
    );
  });

  it("encodes the characters RFC 5987 does not allow raw", async () => {
    const response = await storeThenDownload("image/2026-08-13/a'b(c)d*e.png");

    expect(response.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''a%27b%28c%29d%2Ae.png",
    );
  });

  it("cannot be made to carry a second header line", async () => {
    const response = await storeThenDownload('image/2026-08-13/x"\r\nX-Injected: 1.png');

    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("content-disposition")).not.toContain("\n");
  });

  it("answers 404 for a key nothing was stored under", async () => {
    const response = await download("/download/image/nothing-here.png");

    expect(response.status).toBe(404);
  });

  it("answers a range request with just that range", async () => {
    const response = await download(`/download/${KEY}`, {
      headers: { range: "bytes=2-4" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/8");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([3, 4, 5]);
  });

  it("says ranges are supported so a paused download can resume", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  it("answers a HEAD with the headers and no body", async () => {
    const response = await download(`/download/${KEY}`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.body).toBeNull();
  });

  it("refuses a method that is not a read", async () => {
    const response = await download(`/download/${KEY}`, { method: "DELETE" });

    expect(response.status).toBe(405);
  });
});

// ── What the answer says about itself ───────────────────────────────

describe("how much is coming", () => {
  beforeAll(async () => {
    await env.BUCKET.put(KEY, BYTES, { httpMetadata: { contentType: "image/png" } });
  });

  it("states the length, so the download list can show a total", async () => {
    const response = await download(`/download/${KEY}`);

    expect(response.headers.get("content-length")).toBe(String(BYTES.length));
  });

  it("states it on a HEAD too, which is all a HEAD has to say", async () => {
    const response = await download(`/download/${KEY}`, { method: "HEAD" });

    expect(response.headers.get("content-length")).toBe(String(BYTES.length));
  });
});

describe("a request for part of it", () => {
  beforeAll(async () => {
    await env.BUCKET.put(KEY, BYTES, { httpMetadata: { contentType: "image/png" } });
  });

  it("answers the asked-for bytes as a partial answer", async () => {
    const response = await download(`/download/${KEY}`, {
      headers: { range: "bytes=2-5" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 2-5/${BYTES.length}`);
    expect(response.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.slice(2, 6));
  });

  // R2 does not refuse a range it will not serve — it answers the whole object
  // and reports the same range it reports when nobody asked. So what the
  // answer IS decides the status; what was asked cannot.
  it.each([
    ["past the end", "bytes=900-999"],
    ["malformed", "bytes=abc"],
    ["several ranges at once", "bytes=0-1,4-5"],
  ])("answers the whole object when the range is %s", async (_name, range) => {
    const response = await download(`/download/${KEY}`, { headers: { range } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("answers a zero-byte object whole rather than describing bytes it has none of", async () => {
    await env.BUCKET.put("image/2026-08-13/empty.bin", new Uint8Array([]));

    const response = await download("/download/image/2026-08-13/empty.bin", {
      headers: { range: "bytes=0-0" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
  });
});

describe("a request carrying conditions", () => {
  beforeAll(async () => {
    await env.BUCKET.put(KEY, BYTES, { httpMetadata: { contentType: "image/png" } });
  });

  it("tells a client holding the current copy that it is current", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: { "if-none-match": stored?.httpEtag ?? "" },
    });

    expect(response.status).toBe(304);
  });

  // RFC 9110 §13.1.1: a failed If-Match is 412. Answering 304 would tell the
  // client the copy it holds is current, which is the opposite of true.
  it("refuses a request whose If-Match names another copy", async () => {
    const response = await download(`/download/${KEY}`, {
      headers: { "if-match": '"not-the-stored-one"' },
    });

    expect(response.status).toBe(412);
  });

  it("serves the object when If-Match names this copy", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: { "if-match": stored?.httpEtag ?? "" },
    });

    expect(response.status).toBe(200);
  });

  // `*` asks for the copy whatever it is, so it passes the moment one exists.
  // Paired here with a revalidation, which is what withholds the body.
  it("passes an If-Match of * and answers the revalidation", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: { "if-match": "*", "if-none-match": stored?.httpEtag ?? "" },
    });

    expect(response.status).toBe(304);
  });

  it("reads an If-Match list, spaces and all", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: {
        "if-match": `"another-copy", ${stored?.httpEtag ?? ""}`,
        "if-none-match": stored?.httpEtag ?? "",
      },
    });

    expect(response.status).toBe(304);
  });

  it("states no length on an answer carrying no body", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: { "if-none-match": stored?.httpEtag ?? "" },
    });

    expect(response.headers.get("content-length")).toBeNull();
  });

  // R2 truncates the stored time to the second and serves only while that
  // second is EARLIER than the named one, so a copy written anywhere inside
  // the named second is one it refuses.
  it("refuses a copy written later in the second the request named", async () => {
    const stored = await env.BUCKET.head(KEY);
    const second = Math.floor((stored?.uploaded.getTime() ?? 0) / 1000) * 1000;

    const response = await download(`/download/${KEY}`, {
      headers: { "if-unmodified-since": new Date(second).toUTCString() },
    });

    expect(response.status).toBe(412);
  });

  it("refuses an If-Unmodified-Since it cannot read", async () => {
    const response = await download(`/download/${KEY}`, {
      headers: { "if-unmodified-since": "whenever" },
    });

    expect(response.status).toBe(412);
  });

  it("refuses a copy written after the moment the request named", async () => {
    const response = await download(`/download/${KEY}`, {
      headers: { "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT" },
    });

    expect(response.status).toBe(412);
  });

  // RFC 9110 §13.2.2: If-Unmodified-Since is evaluated only when If-Match is
  // absent. A present, satisfied If-Match settles the strict question.
  it("lets a satisfied If-Match settle it, ignoring If-Unmodified-Since", async () => {
    const stored = await env.BUCKET.head(KEY);

    const response = await download(`/download/${KEY}`, {
      headers: {
        "if-match": stored?.httpEtag ?? "",
        "if-unmodified-since": "Mon, 01 Jan 2001 00:00:00 GMT",
        "if-none-match": stored?.httpEtag ?? "",
      },
    });

    expect(response.status).toBe(304);
  });
});
