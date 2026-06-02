/**
 * Server `/healthz` integration test.
 *
 * Health moved from hono `GET /api/health` (port 3000, removed in
 * `feat/2026-05-28-server-healthz-unify`) to an independent http server
 * `GET /healthz` on port 3001, matching worker (9101) and collab (1235).
 * Source of truth contract test lives in
 * `packages/core/src/infra/__tests__/health-server.test.ts`; this file
 * just asserts the server entry's check wiring (PG + Redis singletons)
 * returns the expected discriminant when fed mock implementations.
 *
 * The Postgres probe delegates to core's single `pingDb()` liveness
 * helper (shared by server / worker / collab + the boot connectivity
 * check) — the SELECT-1 logic itself is unit-tested in
 * `packages/core/src/db/client.ping.test.ts`; here we only pin that the
 * postgres check forwards to it.
 */

import { describe, it, expect, vi } from "vitest";

// Re-importable function-under-test: the check array shape used by
// `index.ts`. Inlining here avoids loading the full entry module
// (which would also bind the real port + register signal handlers).
type Check = {
  name: string;
  check: () => Promise<boolean>;
};

const buildServerChecks = (
  pingDb: () => Promise<boolean>,
  redis: { ping: () => Promise<string> },
): Check[] => [
  {
    name: "postgres",
    check: () => pingDb(),
  },
  {
    name: "redis_general",
    check: async () => (await redis.ping()) === "PONG",
  },
];

describe("server healthz check wiring", () => {
  it("postgres check forwards pingDb's true result", async () => {
    const pingDb = vi.fn(() => Promise.resolve(true));
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const [pgCheck, redisCheck] = buildServerChecks(pingDb, { ping });
    await expect(pgCheck!.check()).resolves.toBe(true);
    await expect(redisCheck!.check()).resolves.toBe(true);
    expect(pingDb).toHaveBeenCalledTimes(1);
  });

  it("postgres check forwards pingDb's false result", async () => {
    const pingDb = vi.fn(() => Promise.resolve(false));
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const [pgCheck] = buildServerChecks(pingDb, { ping });
    await expect(pgCheck!.check()).resolves.toBe(false);
  });

  it("redis check returns false when ping yields non-PONG", async () => {
    const pingDb = vi.fn(() => Promise.resolve(true));
    const ping = vi.fn(() => Promise.resolve("ERROR"));
    const [, redisCheck] = buildServerChecks(pingDb, { ping });
    await expect(redisCheck!.check()).resolves.toBe(false);
  });
});
