// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cross-instance seat registry: what the pong drives, what the instance
 * drives, and how a seat is handed from one of a person's connections to
 * another.
 *
 * Three shapes here are load-bearing and easy to lose:
 *
 *   - A member carries WHO holds it and WHEN it was established. The score is
 *     the last refresh, so it cannot answer "which of this person's
 *     connections is the older one" — two live connections on one instance
 *     are refreshed by the same pong loop and differ by an event-loop turn.
 *   - Refreshing is per SOCKET, because that is what a pong is about. One
 *     socket carries many documents, and the seats it holds move together.
 *   - Handing a seat over is a read-then-write, and `ZREM`'s return value is
 *     what makes the claim atomic: only the caller whose ZREM returned 1 may
 *     treat that seat as the one it freed.
 */

import { describe, it, expect, vi } from "vitest";

// The registry imports `env` + `createLogger` from core. collab tests do not
// run initCore, so mock core: a dummy `env` (these tests inject `keyFor`, so
// ENV is never read) and a no-op logger (the fail-open paths call `warn`).
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
 * The sorted-set and expire operations this registry uses, in memory.
 * Deterministic; no real Redis. Scores are epoch ms.
 */
class FakeRedis {
  readonly sets = new Map<string, Map<string, number>>();
  readonly ttls = new Map<string, number>();
  /** Operations that throw, for the fail-open cases. */
  public throwOn: Set<string> = new Set();
  /** Members whose ZREM reports zero, standing in for a lost claim race. */
  public zremReturnsZeroFor: Set<string> = new Set();

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
    for (const mem of members) {
      // Another handshake removed it a moment earlier: gone, but not by us.
      if (this.zremReturnsZeroFor.has(mem)) {
        m.delete(mem);
        continue;
      }
      if (m.delete(mem)) n++;
    }
    return n;
  }

  async zremrangebyscore(
    key: string,
    min: string,
    max: string,
  ): Promise<number> {
    this.assertOk("zremrangebyscore");
    const m = this.get(key);
    const ceiling = Number(max);
    let n = 0;
    for (const [mem, score] of [...m]) {
      const geMin = min === "-inf" || score >= Number(min);
      if (geMin && score <= ceiling) {
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

  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: "WITHSCORES",
  ): Promise<string[]> {
    this.assertOk("zrange");
    const entries = [...this.get(key)].sort((a, b) => a[1] - b[1]);
    const slice = entries.slice(start, stop === -1 ? undefined : stop + 1);
    return withScores
      ? slice.flatMap(([mem, score]) => [mem, String(score)])
      : slice.map(([mem]) => mem);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.assertOk("expire");
    this.ttls.set(key, seconds);
    return 1;
  }
}

const DOC = "project-p1/canvas-s1";
const PING_MS = 30_000;
const SEAT_EXPIRY_MS = 60_000;

/**
 * One key per document, the way production shapes it.
 * @param documentName - The document.
 * @returns Its sorted-set key.
 */
function keyOf(documentName: string): string {
  return `test:collab:conncount:${documentName}`;
}

const KEY = keyOf(DOC);

/**
 * A registry over a fresh fake Redis with a clock the test drives.
 * @param opts - Overrides.
 * @param opts.redis - Share one fake between two instances.
 * @param opts.instanceId - Which instance this registry speaks for.
 * @returns The registry, the fake, and a setter for the clock.
 */
function build(
  opts: { redis?: FakeRedis; instanceId?: string } = {},
): {
  redis: FakeRedis;
  registry: ReturnType<typeof createConnectionRegistry>;
  setNow: (ms: number) => void;
} {
  const redis = opts.redis ?? new FakeRedis();
  let clock = 1_000_000;
  const registry = createConnectionRegistry({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redis: redis as any,
    instanceId: opts.instanceId ?? "inst-a",
    pingIntervalMs: PING_MS,
    seatExpiryMs: SEAT_EXPIRY_MS,
    now: () => clock,
    keyFor: keyOf,
  });
  return {
    redis,
    registry,
    setNow: (ms: number): void => {
      clock = ms;
    },
  };
}

describe("counting seats across instances", () => {
  it("counts every registered seat", async () => {
    const { registry } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await registry.register(DOC, {
      socketId: "sock-2",
      userId: "user-b",
      connectedAtMs: 1_000_000,
    });

    expect(await registry.count(DOC)).toBe(2);
  });

  it("drops a cleanly disconnected seat straight away", async () => {
    const { registry } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await registry.register(DOC, {
      socketId: "sock-2",
      userId: "user-b",
      connectedAtMs: 1_000_000,
    });

    await registry.unregister(DOC, "sock-1");

    expect(await registry.count(DOC)).toBe(1);
  });

  it("keeps two instances' seats apart even when the socket ids collide", async () => {
    const redis = new FakeRedis();
    const a = build({ redis, instanceId: "inst-a" });
    const b = build({ redis, instanceId: "inst-b" });
    await a.registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await b.registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-b",
      connectedAtMs: 1_000_000,
    });

    expect(await a.registry.count(DOC)).toBe(2);
    expect(await b.registry.count(DOC)).toBe(2);
  });

  it("prunes a seat nobody has refreshed, so a crashed instance heals itself", async () => {
    const { registry, setNow } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    setNow(1_000_000 + SEAT_EXPIRY_MS + 1_000);

    expect(await registry.count(DOC)).toBe(0);
  });

  it("keeps a seat whose connection is still answering", async () => {
    const { registry, setNow } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    setNow(1_030_000);
    await registry.refreshSocket("sock-1");
    setNow(1_060_000);

    expect(await registry.count(DOC)).toBe(1);
  });
});

describe("fail-open", () => {
  it("counts nobody when Redis is down, rather than locking everyone out", async () => {
    const { redis, registry } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    redis.throwOn = new Set(["zcard", "zremrangebyscore"]);

    expect(await registry.count(DOC)).toBe(0);
  });

  it("does not throw when a seat cannot be written", async () => {
    const { redis, registry } = build();
    redis.throwOn = new Set(["zadd"]);

    await expect(
      registry.register(DOC, {
        socketId: "sock-1",
        userId: "user-a",
        connectedAtMs: 1_000_000,
      }),
    ).resolves.toBeUndefined();
  });

  it("hands nothing over when the seats cannot be read", async () => {
    const { redis, registry } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    redis.throwOn = new Set(["zrange"]);

    expect(await registry.claimSeatFrom(DOC, "user-a")).toBeNull();
  });
});

describe("seat members", () => {
  it("carries the holder and the moment the connection was established", async () => {
    const { redis, registry } = build();

    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    expect([...redis.sets.get(KEY)!.keys()]).toEqual([
      "user-a:1000000:inst-a:sock-1",
    ]);
  });

  it("removes a member without being told when it was established", async () => {
    const { redis, registry } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    await registry.unregister(DOC, "sock-1");

    expect(redis.sets.get(KEY)!.size).toBe(0);
  });
});

describe("refreshing on a pong", () => {
  it("refreshes every seat the socket holds, in one call", async () => {
    const { redis, registry, setNow } = build();
    await registry.register("doc-1", {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await registry.register("doc-2", {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    setNow(1_030_000);
    await registry.refreshSocket("sock-1");

    expect([...redis.sets.get(keyOf("doc-1"))!.values()]).toEqual([1_030_000]);
    expect([...redis.sets.get(keyOf("doc-2"))!.values()]).toEqual([1_030_000]);
  });

  it("leaves a socket that holds no seats alone", async () => {
    const { redis, registry } = build();

    await registry.refreshSocket("sock-viewer");

    expect(redis.sets.get(KEY)?.size ?? 0).toBe(0);
  });

  it("keeps the key alive when it refreshes", async () => {
    const { redis, registry, setNow } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    redis.ttls.delete(KEY);

    setNow(1_030_000);
    await registry.refreshSocket("sock-1");

    expect(redis.ttls.get(KEY)).toBeGreaterThan(0);
  });
});

describe("handing a seat over to the arriving connection", () => {
  /**
   * Seat this person twice on one document: an older connection that is
   * still answering, and a newer one that stopped answering a while ago.
   * @param setNow - Moves the registry's clock.
   * @param registry - The registry under test.
   * @returns Nothing.
   */
  async function seatOneLiveOneSilent(
    setNow: (ms: number) => void,
    registry: ReturnType<typeof createConnectionRegistry>,
  ): Promise<void> {
    setNow(1_000_000);
    await registry.register(DOC, {
      socketId: "sock-old-live",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    setNow(1_010_000);
    await registry.register(DOC, {
      socketId: "sock-new-silent",
      userId: "user-a",
      connectedAtMs: 1_010_000,
    });
    // The older one keeps answering; the newer one goes quiet at 1_010_000.
    setNow(1_100_000);
    await registry.refreshSocket("sock-old-live");
  }

  it("takes the one that stopped answering before the one that is older", async () => {
    const { registry, setNow } = build();
    await seatOneLiveOneSilent(setNow, registry);

    setNow(1_100_000);
    const claimed = await registry.claimSeatFrom(DOC, "user-a");

    expect(claimed).toBe("user-a:1010000:inst-a:sock-new-silent");
  });

  it("takes the older connection when both are still answering", async () => {
    const { registry, setNow } = build();
    setNow(1_000_000);
    await registry.register(DOC, {
      socketId: "sock-older",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    setNow(1_010_000);
    await registry.register(DOC, {
      socketId: "sock-newer",
      userId: "user-a",
      connectedAtMs: 1_010_000,
    });
    setNow(1_020_000);
    await registry.refreshSocket("sock-older");
    await registry.refreshSocket("sock-newer");

    const claimed = await registry.claimSeatFrom(DOC, "user-a");

    expect(claimed).toBe("user-a:1000000:inst-a:sock-older");
  });

  it("leaves other people's seats alone", async () => {
    const { redis, registry, setNow } = build();
    setNow(1_000_000);
    await registry.register(DOC, {
      socketId: "sock-b",
      userId: "user-b",
      connectedAtMs: 1_000_000,
    });

    const claimed = await registry.claimSeatFrom(DOC, "user-a");

    expect(claimed).toBeNull();
    expect(redis.sets.get(KEY)!.size).toBe(1);
  });

  it("claims nothing when another handshake removed every candidate first", async () => {
    const { redis, registry, setNow } = build();
    setNow(1_000_000);
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await registry.register(DOC, {
      socketId: "sock-2",
      userId: "user-a",
      connectedAtMs: 1_005_000,
    });
    redis.zremReturnsZeroFor = new Set([
      "user-a:1000000:inst-a:sock-1",
      "user-a:1005000:inst-a:sock-2",
    ]);

    const claimed = await registry.claimSeatFrom(DOC, "user-a");

    expect(claimed).toBeNull();
  });
});

describe("letting go of a seat that was handed over", () => {
  /**
   * The third thing a demote has to do, and the one with no other owner.
   *
   * Deleting the seat is something any instance can do — it is one member of
   * a sorted set. Setting `readOnly` and re-sending Authenticated can only be
   * done by the instance holding that connection. So can this: the pong
   * listener refreshes whatever this instance's own bookkeeping says the
   * socket holds, and a demoted document left in there gets written straight
   * back one ping later. The connection would then be read-only AND holding a
   * seat, and since a demote is never reversed, that seat is gone for good.
   */

  it("stops refreshing the document the connection was demoted on", async () => {
    const { redis, registry, setNow } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    // The arriving handshake takes the seat, then tells the holder.
    const claimed = await registry.claimSeatFrom(DOC, "user-a");
    expect(claimed).toBe("user-a:1000000:inst-a:sock-1");
    registry.forgetSeat(DOC, claimed!);

    setNow(1_030_000);
    await registry.refreshSocket("sock-1");

    expect(redis.sets.get(KEY)?.size ?? 0).toBe(0);
  });

  it("keeps refreshing the socket's other documents", async () => {
    const { redis, registry, setNow } = build();
    await registry.register("doc-demoted", {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    await registry.register("doc-kept", {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });

    registry.forgetSeat("doc-demoted", "user-a:1000000:inst-a:sock-1");
    setNow(1_030_000);
    await registry.refreshSocket("sock-1");

    // The demoted document's member is left where it was — this instance
    // simply stops touching it, and it ages out on its own.
    expect([...redis.sets.get(keyOf("doc-demoted"))!.values()]).toEqual([
      1_000_000,
    ]);
    expect([...redis.sets.get(keyOf("doc-kept"))!.values()]).toEqual([
      1_030_000,
    ]);
  });
});

describe("keeping the keys alive", () => {
  it("touches the key without moving any member's score", async () => {
    const { redis, registry, setNow } = build();
    await registry.register(DOC, {
      socketId: "sock-1",
      userId: "user-a",
      connectedAtMs: 1_000_000,
    });
    redis.ttls.delete(KEY);

    setNow(1_060_000);
    await registry.touchKeys();

    expect(redis.ttls.get(KEY)).toBeGreaterThan(0);
    expect([...redis.sets.get(KEY)!.values()]).toEqual([1_000_000]);
  });
});
