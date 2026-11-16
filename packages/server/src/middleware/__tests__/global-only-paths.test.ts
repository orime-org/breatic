// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Outside the global region, the paths whose data lives only in the global
 * region are refused at the door with 404 and a log line (inner#1955); every
 * other path, and every path in the global region, goes through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type * as CoreModule from "@breatic/core";

const h = vi.hoisted(() => ({ region: "sg", warn: vi.fn() }));

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
    env: new Proxy({}, { get: (_target, key) => ({ REGION: h.region, GLOBAL_REGION: "us-west" })[key as string] }),
  };
});

import { AppError, loadLocales } from "@breatic/core";
import { refuseGlobalOnlyPaths } from "@server/middleware/global-only-paths.js";

loadLocales();

/**
 * An app with the middleware in front of a catch-all route.
 * @returns The app.
 */
function app(): Hono {
  const server = new Hono();
  server.use("*", refuseGlobalOnlyPaths);
  server.onError((err, c) => c.json({ status: err instanceof AppError ? err.statusCode : 500 }, err instanceof AppError ? (err.statusCode as 404) : 500));
  server.all("*", (c) => c.json({ reached: true }));
  return server;
}

beforeEach(() => {
  h.region = "sg";
  vi.clearAllMocks();
});

describe("refuseGlobalOnlyPaths", () => {
  it.each(["/api/v1/auth/login", "/api/v1/users/me", "/api/v1/studios", "/api/v1/credits/lots", "/api/v1/payment/checkout", "/api/v1/account", "/api/v1/directory/projects/p1"])(
    "refuses %s outside the global region and logs it",
    async (path) => {
      const res = await app().request(path, { method: "POST" });

      expect(res.status).toBe(404);
      expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ path }), "global_only_path_refused");
    },
  );

  it.each(["/api/v1/studio/acme", "/api/v1/projects/p1", "/api/v1/canvas/x", "/api/v1/decisions/t", "/api/v1/users?ids=a,b"])("lets %s through outside the global region", async (path) => {
    const res = await app().request(path);

    expect(res.status).toBe(200);
  });

  it("lets every path through in the global region", async () => {
    h.region = "us-west";

    const res = await app().request("/api/v1/auth/login", { method: "POST" });

    expect(res.status).toBe(200);
    expect(h.warn).not.toHaveBeenCalled();
  });
});
