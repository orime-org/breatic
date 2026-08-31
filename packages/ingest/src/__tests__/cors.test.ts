// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cross-origin access to the Worker (#173, design §10).
 *
 * The browser sends its parts here, not to the bucket, so the bucket's own
 * CORS rules never come into it — this Worker answers for itself. A part
 * carries `x-upload-token`, which makes it a non-simple request, so the
 * browser always sends a preflight first and will not send the bytes at all
 * unless that preflight answers.
 *
 * Which origins may ask is deployment configuration: the same page is served
 * from a different host in dev and in production.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "@ingest/index.js";

/** What `ALLOWED_ORIGINS` is bound to in vitest.config.ts. */
const ALLOWED = "https://app.test.example";

/** Send one request with an Origin header. */
async function fromOrigin(
  origin: string,
  init: RequestInit & { method: string },
  path = "/uploads",
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com${path}`, { ...init, headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the preflight a part triggers", () => {
  it("answers an allowed origin with what it may send", async () => {
    const response = await fromOrigin(
      ALLOWED,
      {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "PUT",
          "access-control-request-headers": "x-upload-token",
        },
      },
      "/uploads/abc/parts/1",
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("x-upload-token");
  });

  it("tells an unlisted origin nothing it can use", async () => {
    const response = await fromOrigin("https://not-ours.example", {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" },
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  // Caches vary by Origin, and answering one origin's preflight from another's
  // cached response is how a page that should be refused gets let in.
  it("says the answer depends on the origin", async () => {
    const response = await fromOrigin(ALLOWED, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" },
    });

    expect(response.headers.get("vary")).toContain("Origin");
  });
});

describe("a real request", () => {
  it("carries the allow-origin header an allowed page needs to read it", async () => {
    const response = await fromOrigin(ALLOWED, { method: "POST" });

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("carries none for an unlisted origin", async () => {
    const response = await fromOrigin("https://not-ours.example", {
      method: "POST",
    });

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
