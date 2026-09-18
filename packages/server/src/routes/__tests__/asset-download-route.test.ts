// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #2108 — the download endpoint, at the route layer.
 *
 * What the route itself decides is pinned here: a session is required, the
 * URL is read off the query, and the answer is a redirect to the ingest
 * Worker rather than any bytes. Which address that is belongs to
 * `downloadLink`, which has its own tests.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { keyFromUrl } = vi.hoisted(() => ({ keyFromUrl: vi.fn() }));

const authed = { current: true };

vi.mock("@server/middleware/auth.js", () => ({
  requireAuth: async (
    c: { set: (k: string, v: unknown) => void; json: (b: unknown, s: number) => unknown },
    next: () => Promise<void>,
  ) => {
    if (!authed.current) return c.json({ error: { code: 401 } }, 401);
    c.set("user", { id: "u-1" });
    return next();
  },
}));

vi.mock("@server/middleware/rate-limit.js", () => ({
  rateLimitFor: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    env: { ENV: "test", INGEST_BASE_URL: "https://ingest.example.com" },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStorageAdapter: async () => ({ keyFromUrl }),
  };
});

const { assetsRoute } = await import("@server/routes/assets.js");
const { errorHandler } = await import("@server/middleware/error-handler.js");
const { Hono } = await import("hono");

// Mounted behind the global error handler, which is what turns a thrown
// AppError into its own status; a bare route would answer every refusal 500.
const app = new Hono();
app.onError(errorHandler);
app.route("/", assetsRoute);

/**
 * Ask for a download the way the app mounts it.
 * @param url - What to put in the `url` query parameter.
 * @returns The response, redirects left unfollowed.
 */
async function ask(url: string): Promise<Response> {
  const query = url === "" ? "" : `?url=${encodeURIComponent(url)}`;
  return app.request(`/download${query}`, { redirect: "manual" });
}

beforeEach(() => {
  authed.current = true;
  keyFromUrl.mockReset();
});

describe("the download endpoint", () => {
  it("sends the browser to the ingest Worker", async () => {
    keyFromUrl.mockReturnValue("image/2026-08-13/a.png");

    const response = await ask("https://assets.example.com/image/2026-08-13/a.png");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://ingest.example.com/download/image/2026-08-13/a.png",
    );
  });

  it("answers no bytes of its own", async () => {
    keyFromUrl.mockReturnValue("image/a.png");

    const response = await ask("https://assets.example.com/image/a.png");

    await expect(response.text()).resolves.toBe("");
  });

  it("takes a session", async () => {
    authed.current = false;
    keyFromUrl.mockReturnValue("image/a.png");

    const response = await ask("https://assets.example.com/image/a.png");

    expect(response.status).toBe(401);
    expect(keyFromUrl).not.toHaveBeenCalled();
  });

  it("refuses a URL naming nothing of ours", async () => {
    keyFromUrl.mockReturnValue(null);

    const response = await ask("https://evil.test/a.png");

    expect(response.status).toBe(400);
  });

  it("refuses a request with no url at all", async () => {
    const response = await ask("");

    // 422, not 400: the shared `validate` middleware answers a schema miss
    // that way (`middleware/validate.ts:53`), and this route says nothing of
    // its own about a missing parameter.
    expect(response.status).toBe(422);
    expect(keyFromUrl).not.toHaveBeenCalled();
  });
});
