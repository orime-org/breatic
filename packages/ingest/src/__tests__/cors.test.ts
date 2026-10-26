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

/**
 * Every endpoint the browser reaches, with the method it uses. Opening and
 * finishing an upload are called only by our own services (inner#1595), so
 * the browser sends nothing but parts.
 */
const ENDPOINTS: { path: string; method: string }[] = [
  { path: "/uploads/abc/parts/1", method: "PUT" },
];

/**
 * A comma-separated header value as a set of trimmed entries.
 * @param value - The header value.
 * @param normalise - How each entry is compared.
 * @returns The entries.
 */
function entries(value: string | null, normalise: (s: string) => string): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((s) => normalise(s.trim()))
      .filter((s) => s.length > 0),
  );
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

  it("T13: allows only PUT and OPTIONS, and no ticket header", async () => {
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
    expect(
      entries(response.headers.get("access-control-allow-methods"), (s) => s.toUpperCase()),
    ).toEqual(new Set(["PUT", "OPTIONS"]));
    const allowed = entries(response.headers.get("access-control-allow-headers"), (s) =>
      s.toLowerCase(),
    );
    expect(allowed.has("x-upload-token")).toBe(true);
    expect(allowed.has("content-type")).toBe(true);
    expect(allowed.has("x-upload-ticket")).toBe(false);
  });

  // The Worker answers every OPTIONS, so the refusal is in what the answer
  // lists: a browser told POST and x-upload-ticket are not allowed never
  // sends the real request.
  it("T14: does not let a page send POST /uploads with a ticket", async () => {
    const response = await fromOrigin(ALLOWED, {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-upload-ticket",
      },
    });

    expect(response.status).toBe(204);
    expect(
      entries(response.headers.get("access-control-allow-methods"), (s) => s.toUpperCase()).has(
        "POST",
      ),
    ).toBe(false);
    expect(
      entries(response.headers.get("access-control-allow-headers"), (s) => s.toLowerCase()).has(
        "x-upload-ticket",
      ),
    ).toBe(false);
  });
});

// Each endpoint the browser reaches, separately. One shared exit adds the
// headers today, and a list keeps the next browser-facing endpoint guarded
// the day that stops being true.
describe("a real request", () => {
  it.each(ENDPOINTS)(
    "$method $path carries the allow-origin header an allowed page needs to read it",
    async ({ path, method }) => {
      const response = await fromOrigin(ALLOWED, { method }, path);

      // Refused for want of a credential, which is as far as a request with no
      // token gets — and far enough to answer what this asks.
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    },
  );

  it.each(ENDPOINTS)(
    "$method $path carries none for an unlisted origin",
    async ({ path, method }) => {
      const response = await fromOrigin(
        "https://not-ours.example",
        { method },
        path,
      );

      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    },
  );
});

describe("the preflight each endpoint answers", () => {
  it.each(ENDPOINTS)("$method $path answers its own", async ({ path, method }) => {
    const response = await fromOrigin(
      ALLOWED,
      {
        method: "OPTIONS",
        headers: { "access-control-request-method": method },
      },
      path,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("access-control-allow-methods")).toContain(method);
  });
});
