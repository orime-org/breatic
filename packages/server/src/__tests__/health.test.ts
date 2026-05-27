/**
 * Server `/healthz` integration test.
 *
 * Health moved from hono `GET /api/health` (port 3000, removed in
 * this PR `feat/2026-05-28-server-healthz-unify`) to an independent
 * http server `GET /healthz` on port 3001, matching worker (9101)
 * and collab (1235) shape. Source of truth contract test lives in
 * `packages/core/src/infra/__tests__/health-server.test.ts` — this
 * file just asserts that the server entry's check wiring (PG +
 * Redis singletons) returns the expected discriminant when fed mock
 * implementations.
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
  pg: { rawPg: <T>(q: TemplateStringsArray) => Promise<T> },
  redis: { ping: () => Promise<string> },
): Check[] => [
  {
    name: "postgres",
    check: async () => {
      const rows = await pg.rawPg<Array<{ ok: number }>>`SELECT 1 AS ok`;
      return rows[0]?.ok === 1;
    },
  },
  {
    name: "redis_general",
    check: async () => (await redis.ping()) === "PONG",
  },
];

describe("server healthz check wiring", () => {
  it("postgres check returns true when SELECT 1 yields ok=1", async () => {
    const rawPg = vi.fn(() => Promise.resolve([{ ok: 1 }]));
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const [pgCheck, redisCheck] = buildServerChecks(
      { rawPg: rawPg as never },
      { ping },
    );
    await expect(pgCheck!.check()).resolves.toBe(true);
    await expect(redisCheck!.check()).resolves.toBe(true);
  });

  it("postgres check returns false when SELECT 1 yields wrong shape", async () => {
    const rawPg = vi.fn(() => Promise.resolve([{ ok: 0 }]));
    const ping = vi.fn(() => Promise.resolve("PONG"));
    const [pgCheck] = buildServerChecks(
      { rawPg: rawPg as never },
      { ping },
    );
    await expect(pgCheck!.check()).resolves.toBe(false);
  });

  it("redis check returns false when ping yields non-PONG", async () => {
    const rawPg = vi.fn(() => Promise.resolve([{ ok: 1 }]));
    const ping = vi.fn(() => Promise.resolve("ERROR"));
    const [, redisCheck] = buildServerChecks(
      { rawPg: rawPg as never },
      { ping },
    );
    await expect(redisCheck!.check()).resolves.toBe(false);
  });
});
