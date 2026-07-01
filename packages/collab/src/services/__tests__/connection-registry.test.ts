// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from "vitest";

// The registry imports `env` + `createLogger` from core. collab tests do
// not run initCore, so mock core: a dummy `env` (the registry gets an
// injected `keyFor` in these tests, so ENV is never read) and a no-op
// logger (the fail-open paths call `logger.warn`).
vi.mock("@breatic/core", () => ({
  env: { ENV: "test" },
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createConnectionRegistry } from "@collab/services/connection-registry.js";

/**
 * Minimal in-memory fake of the sorted-set + expire Redis ops the
 * registry uses. Deterministic; no real Redis. Scores are epoch ms.
 */
class FakeRedis {
  readonly sets = new Map<string, Map<string, number>>();
  public throwOn: Set<string> = new Set();

  private assertOk(op: string): void {
    if (this.throwOn.has(op)) throw new Error(`fake redis ${op} down`);
  }

  private get(key: string): Map<string, number> {
    let m = this.sets.get(key);
    if (!m) {
      m = new Map();
      this.sets.set(key, m);
    }
    return m;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    this.assertOk("zadd");
    const m = this.get(key);
    const isNew = m.has(member) ? 0 : 1;
    m.set(member, score);
    return isNew;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    this.assertOk("zrem");
    const m = this.get(key);
    let n = 0;
    for (const mem of members) if (m.delete(mem)) n++;
    return n;
  }

  async zremrangebyscore(
    key: string,
    min: string,
    max: number,
  ): Promise<number> {
    this.assertOk("zremrangebyscore");
    const m = this.get(key);
    let n = 0;
    for (const [mem, score] of [...m.entries()]) {
      const geMin = min === "-inf" || score >= Number(min);
      if (geMin && score <= max) {
        m.delete(mem);
        n++;
      }
    }
    return n;
  }

  async zcard(key: string): Promise<number> {
    this.assertOk("zcard");
    return this.get(key).size;
  }

  async expire(key: string, _sec: number): Promise<number> {
    this.assertOk("expire");
    return 1;
  }
}

const DOC = "project-p1/canvas-s1";

/**
 * Build a registry over a fake redis with an injectable clock.
 * @param now - Mutable clock holder ({ t }); registry reads `now.t`.
 * @param redis - Fake redis instance.
 * @param instanceId - Instance id for member namespacing.
 * @returns The registry under test.
 */
function make(
  now: { t: number },
  redis: FakeRedis = new FakeRedis(),
  instanceId = "inst-A",
): ReturnType<typeof createConnectionRegistry> {
  return createConnectionRegistry({
    redis: redis as never,
    instanceId,
    ttlMs: 30_000,
    heartbeatMs: 10_000,
    now: () => now.t,
    // Inject a key builder that does not touch `env` (collab tests do not
    // run initCore); production defaults to `${env.ENV}:collab:conncount:`.
    keyFor: (doc) => `test:collab:conncount:${doc}`,
  });
}

describe("connection-registry (#1421 cross-instance connection count)", () => {
  it("register then count returns the live connection count", async () => {
    const now = { t: 1000 };
    const r = make(now);
    await r.register(DOC, "sock1");
    await r.register(DOC, "sock2");
    expect(await r.count(DOC)).toBe(2);
  });

  it("unregister removes a connection immediately (clean disconnect)", async () => {
    const now = { t: 1000 };
    const r = make(now);
    await r.register(DOC, "sock1");
    await r.register(DOC, "sock2");
    await r.unregister(DOC, "sock1");
    expect(await r.count(DOC)).toBe(1);
  });

  it("members are namespaced by instanceId so two instances' counts merge", async () => {
    const now = { t: 1000 };
    const redis = new FakeRedis();
    const a = make(now, redis, "inst-A");
    const b = make(now, redis, "inst-B");
    await a.register(DOC, "sock1");
    await b.register(DOC, "sock1"); // same socketId, different instance
    // both counted (cross-instance sum), not collapsed to 1
    expect(await a.count(DOC)).toBe(2);
    expect(await b.count(DOC)).toBe(2);
  });

  it("count prunes stale members (older than TTL) — crash self-heals", async () => {
    const now = { t: 1000 };
    const r = make(now);
    await r.register(DOC, "sock1"); // score = 1000
    now.t = 1000 + 31_000; // advance past TTL (30s) without heartbeat
    // a fresh connection arrives on another instance
    expect(await r.count(DOC)).toBe(0); // stale one pruned, none fresh
  });

  it("heartbeat refreshes this instance's members so they survive pruning", async () => {
    const now = { t: 1000 };
    const r = make(now);
    await r.register(DOC, "sock1"); // score = 1000
    now.t = 15_000; // within TTL
    await r.heartbeat(); // refresh score to 15_000
    now.t = 15_000 + 20_000; // 20s later — old score 1000 would be stale, refreshed 15_000 still stale? 35000-30000=5000 cutoff -> 15000 > 5000 fresh
    expect(await r.count(DOC)).toBe(1);
  });

  it("fail-open: a Redis error during count returns 0 (never locks users out)", async () => {
    const now = { t: 1000 };
    const redis = new FakeRedis();
    const r = make(now, redis);
    await r.register(DOC, "sock1");
    redis.throwOn = new Set(["zcard", "zremrangebyscore"]);
    expect(await r.count(DOC)).toBe(0);
  });

  it("fail-open: a Redis error during register does not throw", async () => {
    const now = { t: 1000 };
    const redis = new FakeRedis();
    const r = make(now, redis);
    redis.throwOn = new Set(["zadd"]);
    await expect(r.register(DOC, "sock1")).resolves.toBeUndefined();
  });
});
