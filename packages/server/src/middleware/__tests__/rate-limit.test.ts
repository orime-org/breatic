// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Shared rate-limit middleware — keying + 429 behaviour (inner#1478). The
 * counter is mocked (the window itself is core's concern); this pins the
 * middleware's own logic: where the client is read from, the bucket key it
 * builds per `keyBy`, that every quota of a request goes to core in one call,
 * and the 429 + `Retry-After` answer.
 */

import { createHash } from "node:crypto";
import type * as CoreModule from "@breatic/core";
import type * as SharedModule from "@breatic/shared";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

const checkRateLimit = vi.fn();
const logger = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    getRedis: () => ({}),
    checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
    decideClientIdentity: actual.decideClientIdentity,
    logger,
  };
});
vi.mock("@breatic/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedModule>()),
  t: (k: string) => k,
}));

import { Hono } from "hono";
import { rateLimit } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";

/** A request that came through our nginx. */
const PROXIED = { incoming: { socket: { remoteAddress: "172.18.0.4" } } };
/** A request from this machine (local dev through the Vite proxy). */
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
/** A request that reached us without our nginx: no `x-real-ip` and not from this machine. */
const DIRECT = { incoming: { socket: { remoteAddress: "203.0.113.9" } } };

/**
 * An app with one limited GET route.
 * @param quotas - The quotas the route is limited by.
 * @returns The app.
 */
function appWith(quotas: Parameters<typeof rateLimit>[0]["quotas"]): Hono {
  const app = new Hono();
  app.get("/", rateLimit({ quotas }), (c) => c.text("ok"));
  return app;
}

beforeEach(() => {
  checkRateLimit.mockReset();
  logger.error.mockReset();
  checkRateLimit.mockResolvedValue({ allowed: true });
});

describe("rateLimit middleware", () => {
  it("counts a proxied request under the address our proxy wrote", async () => {
    const app = appWith([{ prefix: "x", max: 5, windowSeconds: 60 }]);
    const res = await app.request("/", { headers: { "x-real-ip": "203.0.113.9" } }, PROXIED);
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: "x:203.0.113.9", max: 5, windowSeconds: 60 }]);
  });

  it("ignores x-forwarded-for", async () => {
    const app = appWith([{ prefix: "x", max: 5, windowSeconds: 60 }]);
    await app.request("/", { headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" } }, PROXIED);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: "x:203.0.113.9", max: 5, windowSeconds: 60 }]);
  });

  it("lets a request from this machine through without counting it", async () => {
    const app = appWith([{ prefix: "x", max: 5, windowSeconds: 60 }]);
    const res = await app.request("/", { headers: { "x-real-ip": "203.0.113.9" } }, LOOPBACK);
    expect(res.status).toBe(200);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("refuses a request that did not come through our proxy, and logs the reason and the peer", async () => {
    const app = appWith([{ prefix: "x", max: 5, windowSeconds: 60 }]);
    const res = await app.request("/", {}, DIRECT);
    expect(res.status).toBe(403);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { actions: ["x"], reason: "missing-real-ip", peerAddress: "203.0.113.9" },
      "rate_limit_client_unidentified",
    );
  });

  it("answers 429 with the wait core reports", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const app = appWith([{ prefix: "x", max: 5, windowSeconds: 900 }]);
    const res = await app.request("/", { headers: { "x-real-ip": "203.0.113.9" } }, PROXIED);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
  });

  it("sends every quota of the request to core in one call", async () => {
    const app = appWith([
      { prefix: "login-ip", max: 150, windowSeconds: 300 },
      { prefix: "x", max: 5, windowSeconds: 60 },
    ]);
    await app.request("/", { headers: { "x-real-ip": "203.0.113.9" } }, PROXIED);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [
      { key: "login-ip:203.0.113.9", max: 150, windowSeconds: 300 },
      { key: "x:203.0.113.9", max: 5, windowSeconds: 60 },
    ]);
  });

  it("keys by address and a hash of the validated email for keyBy='ip+email'", async () => {
    const app = new Hono();
    app.post(
      "/",
      validate("json", z.object({ email: z.string() })),
      rateLimit({ quotas: [{ prefix: "login", max: 10, windowSeconds: 900, keyBy: "ip+email" }] }),
      (c) => c.text("ok"),
    );
    const res = await app.request(
      "/",
      { method: "POST", headers: { "x-real-ip": "203.0.113.9", "content-type": "application/json" }, body: JSON.stringify({ email: "a@x.com" }) },
      PROXIED,
    );
    expect(res.status).toBe(200);
    const hash = createHash("sha256").update("a@x.com").digest("hex");
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: `login:203.0.113.9:${hash}`, max: 10, windowSeconds: 900 }]);
  });

  it("keys by user id when keyBy='user', without asking where the request came from", async () => {
    const app = new Hono<{ Variables: { user: { id: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-9" });
      await next();
    });
    app.get("/", rateLimit({ quotas: [{ prefix: "sc", max: 10, windowSeconds: 3600, keyBy: "user" }] }), (c) => c.text("ok"));
    const res = await app.request("/", {}, DIRECT);
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: "sc:user-9", max: 10, windowSeconds: 3600 }]);
  });

  it("keys by 'anonymous' when keyBy='user' and no user is set", async () => {
    const app = appWith([{ prefix: "sc", max: 10, windowSeconds: 3600, keyBy: "user" }]);
    await app.request("/", {}, DIRECT);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: "sc:anonymous", max: 10, windowSeconds: 3600 }]);
  });

  it("keys by the connection's own address when keyBy='socket', without asking where the request came from", async () => {
    const app = appWith([{ prefix: "internal-api", max: 120, windowSeconds: 60, keyBy: "socket" }]);
    const res = await app.request("/", {}, DIRECT);
    expect(res.status).toBe(200);
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), [{ key: "internal-api:203.0.113.9", max: 120, windowSeconds: 60 }]);
  });

  it("keys by user id and the named route param when keyBy is userAndParam", async () => {
    const app = new Hono<{ Variables: { user: { id: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "user-9" });
      await next();
    });
    const limiter = rateLimit({ quotas: [{ prefix: "up", max: 3, windowSeconds: 60, keyBy: { userAndParam: "uploadId" } }] });
    app.post("/uploads/:uploadId/parts", limiter, (c) => c.text("ok"));
    app.post("/uploads", limiter, (c) => c.text("ok"));
    await app.request("/uploads/u-1/parts", { method: "POST" }, DIRECT);
    await app.request("/uploads", { method: "POST" }, DIRECT);
    expect(checkRateLimit).toHaveBeenNthCalledWith(1, expect.anything(), [{ key: "up:user-9:u-1", max: 3, windowSeconds: 60 }]);
    expect(checkRateLimit).toHaveBeenNthCalledWith(2, expect.anything(), [{ key: "up:user-9:", max: 3, windowSeconds: 60 }]);
  });
});
