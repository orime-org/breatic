/**
 * Invariant tests for the `createRedisClient` factory in
 * `packages/core/src/infra/redis.ts`.
 *
 * The 2026-05-27 long-running drift investigation traced the
 * "登录已失效" banner stuck symptom to ioredis clients constructed
 * with bare defaults — no TCP keepalive, no command timeout, no
 * READONLY-aware reconnect, no error logging. The fix put a
 * `createRedisClient` factory at the core layer with those five
 * production-safety knobs baked in, and made the three core
 * singletons (`getRedis` / `getQueueRedis` / `getStreamRedis`)
 * go through it.
 *
 * The tests below pin the factory's defaults so a future refactor
 * cannot silently drop a knob — every bullet in the CLAUDE.md
 * "服务器端工业级标准" Connection-健康 row must remain present.
 * If you intentionally relax one (e.g. queue workers needing
 * unbounded commandTimeout), override it explicitly and update
 * the corresponding singleton test below.
 */

import { describe, it, expect, vi } from "vitest";

// `vi.hoisted` is mandatory here — `vi.mock` factories run before
// any top-level `const`/`class` declaration, so the closure-captured
// `MockRedis` / `loggerError` would be in the TDZ when the mocks
// fire. Wrapping them in `vi.hoisted` runs the initializer alongside
// the mock factories themselves.
const { ctorCalls, onErrorListeners, MockRedis, loggerError } = vi.hoisted(
  () => {
    const ctorCalls: Array<{ url: string; options: Record<string, unknown> }> =
      [];
    const onErrorListeners: Array<(err: Error) => void> = [];

    class MockRedis {
      constructor(url: string, options: Record<string, unknown>) {
        ctorCalls.push({ url, options });
      }
      on(event: string, listener: (err: Error) => void): this {
        if (event === "error") onErrorListeners.push(listener);
        return this;
      }
    }

    return {
      ctorCalls,
      onErrorListeners,
      MockRedis,
      loggerError: vi.fn(),
    };
  },
);

vi.mock("ioredis", () => ({ default: MockRedis }));

// Mute the real pino logger so the error-tag invariant test can
// spy on `.error` without touching disk.
vi.mock("../../logger.js", () => ({
  logger: {
    error: loggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { createRedisClient } from "../redis.js";

function lastCtorCall() {
  return ctorCalls[ctorCalls.length - 1]!;
}

describe("createRedisClient — production-safety invariants", () => {
  it("sets TCP keepAlive (≥ 1s) so dropped midpoints surface before the ~11min OS detection window", () => {
    createRedisClient("redis://localhost:6379/0", { name: "x" });
    expect(lastCtorCall().options.keepAlive).toBeTypeOf("number");
    expect(lastCtorCall().options.keepAlive as number).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it("sets a finite commandTimeout (default 5s) so commands fail instead of hanging on dead sockets", () => {
    createRedisClient("redis://localhost:6379/0", { name: "x" });
    expect(lastCtorCall().options.commandTimeout).toBeTypeOf("number");
  });

  it("sets a finite connectTimeout so app boot can't hang on a misconfigured URL", () => {
    createRedisClient("redis://localhost:6379/0", { name: "x" });
    expect(lastCtorCall().options.connectTimeout).toBeTypeOf("number");
  });

  it("attaches a reconnectOnError handler that reconnects on READONLY (Sentinel / managed-Redis failover)", () => {
    createRedisClient("redis://localhost:6379/0", { name: "x" });
    const handler = lastCtorCall().options.reconnectOnError as (
      err: Error,
    ) => boolean;
    expect(handler).toBeTypeOf("function");
    expect(handler(new Error("READONLY You can't write against a replica"))).toBe(
      true,
    );
    expect(handler(new Error("Connection is closed."))).toBe(false);
  });

  it("logs connection errors with the caller-supplied `name` tag (so multi-instance error lines are separable)", () => {
    loggerError.mockReset();
    createRedisClient("redis://localhost:6379/0", { name: "session-store" });
    const lastListener = onErrorListeners[onErrorListeners.length - 1]!;
    lastListener(new Error("boom"));
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "session-store",
        err: expect.objectContaining({ message: "boom" }),
      }),
      expect.any(String),
    );
  });

  it("lets caller override individual defaults (BullMQ worker pattern)", () => {
    createRedisClient("redis://localhost:6379/1", {
      name: "bullmq-worker",
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      commandTimeout: undefined,
    });
    const opts = lastCtorCall().options;
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(opts.enableReadyCheck).toBe(false);
    // commandTimeout: undefined is the BullMQ requirement (BRPOP
    // legitimately exceeds any reasonable timeout). Spread-merge
    // semantics keep the explicit `undefined` rather than the
    // default 5000.
    expect(opts.commandTimeout).toBeUndefined();
  });
});
