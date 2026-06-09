// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared rate-limit middleware — keying + 429 behaviour. Redis is mocked (the
 * sliding-window check itself is core's concern); this pins the middleware's
 * own logic: the bucket key it builds per `keyBy` dimension, the 429 +
 * `Retry-After` response when the limit is hit, and pass-through otherwise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const checkRateLimit = vi.fn();
vi.mock("@breatic/core", () => ({
  getRedis: () => ({}),
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  logger: { warn: vi.fn() },
}));
vi.mock("@breatic/shared", () => ({ t: (k: string) => k }));

import { Hono } from "hono";
import { rateLimit } from "@server/middleware/rate-limit.js";

beforeEach(() => checkRateLimit.mockReset());

describe("rateLimit middleware", () => {
  it("passes through and keys by IP (default) when under the limit", async () => {
    checkRateLimit.mockResolvedValue(true);
    const app = new Hono();
    app.use("*", rateLimit({ prefix: "x", max: 5, windowSeconds: 60 }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), "x:1.2.3.4", 5, 60);
  });

  it("returns 429 + Retry-After when over the limit", async () => {
    checkRateLimit.mockResolvedValue(false);
    const app = new Hono();
    app.use("*", rateLimit({ prefix: "x", max: 5, windowSeconds: 60 }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("keys by user id when keyBy='user'", async () => {
    checkRateLimit.mockResolvedValue(true);
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-9" });
      await next();
    });
    app.use("*", rateLimit({ prefix: "sc", max: 10, windowSeconds: 3600, keyBy: "user" }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), "sc:user-9", 10, 3600);
  });

  it("falls back to 'anonymous' for keyBy='user' with no user on context", async () => {
    checkRateLimit.mockResolvedValue(true);
    const app = new Hono();
    app.use("*", rateLimit({ prefix: "sc", max: 10, windowSeconds: 3600, keyBy: "user" }));
    app.get("/", (c) => c.text("ok"));
    await app.request("/");
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), "sc:anonymous", 10, 3600);
  });
});
