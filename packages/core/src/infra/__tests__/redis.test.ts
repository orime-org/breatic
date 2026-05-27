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
// `MockRedis` would be in the TDZ when the mock fires. Wrapping it
// in `vi.hoisted` runs the initializer alongside the mock factory.
const { ctorCalls, onErrorListeners, MockRedis } = vi.hoisted(() => {
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

  return { ctorCalls, onErrorListeners, MockRedis };
});

vi.mock("ioredis", () => ({ default: MockRedis }));

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

  it("attaches a no-op `error` listener so an emitted error doesn't crash the process (library 不写日志 mandate)", () => {
    // Per CLAUDE.md "进程生命周期(library 层禁)" mandate, the
    // factory must NOT write logs. But ioredis inherits Node's
    // EventEmitter behaviour where an unhandled `error` event is
    // fatal, so the factory must still attach SOMETHING — a no-op.
    // The application entry attaches its own listener for actual
    // logging via `client.on('error', logger.error)`.
    const before = onErrorListeners.length;
    createRedisClient("redis://localhost:6379/0", { name: "x" });
    const after = onErrorListeners.length;
    expect(after).toBe(before + 1);
    const installed = onErrorListeners[after - 1]!;
    // Invoking the no-op listener must not throw — it swallows.
    expect(() => installed(new Error("boom"))).not.toThrow();
    // It must not call any logger either (no smoke means no fire).
    // (We don't mock the logger anymore — the mere fact that
    // `redis.ts` no longer imports `../../logger.js` is the
    // structural guarantee. See the `import` audit in the factory
    // module itself.)
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
