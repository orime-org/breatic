// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The product's binding of core's limiter: each limiter event becomes the log
 * line operations search for, and counting goes to core's `checkRateLimit`.
 * Keying and the 429 answer are core's and tested there.
 */

import type * as CoreModule from "@breatic/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const checkRateLimit = vi.fn();
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  getRedis: () => ({}),
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  logger,
}));

import { rateLimitFor } from "@server/middleware/rate-limit.js";

const PROXIED = { incoming: { socket: { remoteAddress: "172.18.0.4" } } };
const DIRECT = { incoming: { socket: { remoteAddress: "203.0.113.9" } } };

/**
 * An app with one route limited by `login`, failing closed.
 * @returns The app.
 */
function app(): Hono {
  const a = new Hono();
  a.get("/", rateLimitFor("login", "ip", { failClosed: (c) => c.text("closed", 503) }), (c) => c.text("ok"));
  return a;
}

beforeEach(() => {
  checkRateLimit.mockReset();
  logger.warn.mockReset();
  logger.error.mockReset();
});

describe("product rate limiter", () => {
  it("logs a request that did not come through our proxy", async () => {
    await app().request("/", {}, DIRECT);
    expect(logger.error).toHaveBeenCalledWith(
      { actions: ["login"], reason: "missing-real-ip", peerAddress: "203.0.113.9" },
      "rate_limit_client_unidentified",
    );
  });

  it("counts in core with the product's window and logs a hit", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 5 });
    const res = await app().request("/", { headers: { "x-real-ip": "203.0.113.9" } }, PROXIED);
    expect(res.status).toBe(429);
    expect(checkRateLimit).toHaveBeenCalledWith({}, [{ key: "login:203.0.113.9", max: 1000, windowSeconds: 60 }]);
    expect(logger.warn).toHaveBeenCalledWith({ actions: ["login"], keys: ["login:203.0.113.9"] }, "rate_limit_hit");
  });

  it("logs an unreachable counter", async () => {
    const err = new Error("redis down");
    checkRateLimit.mockRejectedValue(err);
    const res = await app().request("/", { headers: { "x-real-ip": "203.0.113.9" } }, PROXIED);
    expect(res.status).toBe(503);
    expect(logger.error).toHaveBeenCalledWith({ err, actions: ["login"] }, "rate_limit_unavailable");
  });
});
