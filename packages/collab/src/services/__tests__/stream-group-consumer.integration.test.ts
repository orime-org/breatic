// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consumer-group runner against a real Redis (inner#1497 §6.1, B6, B7).
 *
 * Every case uses its own stream key so a leftover entry from one case can
 * never be read by another.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { createRedisClient, initCore, type Redis } from "@breatic/core";
import {
  startGroupConsumer,
  type EntryOutcome,
  type GroupConsumer,
  type GroupConsumerSettings,
  type StreamEntry,
} from "@collab/services/stream-group-consumer.js";

const FAST: GroupConsumerSettings = {
  maxHeld: 16,
  keyConcurrency: 16,
  blockMs: 100,
  leaseRetryMs: 20,
  claimIntervalMs: 100,
  claimIdleMs: 300,
  retryMinMs: 20,
  retryMaxMs: 80,
  maxFailures: 3,
  stopDeadlineMs: 2000,
  forgetIdleConsumerMs: 24 * 60 * 60 * 1000,
};

let stream: Redis;
let coordination: Redis;
const running: GroupConsumer[] = [];

beforeAll(() => {
  initCore(process.env);
  stream = createRedisClient(process.env.REDIS_STREAM_URL!, { name: "itest-group-stream" });
  coordination = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-group-coord" });
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
});

afterAll(async () => {
  await stream.quit();
  await coordination.quit();
});

/** Names for one case: a fresh stream, group and failure hash. */
function keysFor(): { streamKey: string; group: string; legacyCursorKey: string; failuresKey: string } {
  const id = randomUUID();
  return {
    streamKey: `itest:stream:${id}`,
    group: "itest-group",
    legacyCursorKey: `itest:cursor:${id}`,
    failuresKey: `itest:failures:${id}`,
  };
}

/**
 * Append entries carrying the given payloads.
 * @param streamKey - Stream to append to.
 * @param payloads - One entry per payload.
 * @returns The ids Redis assigned, in order.
 */
async function append(streamKey: string, payloads: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const p of payloads) ids.push((await stream.xadd(streamKey, "*", "payload", p))!);
  return ids;
}

/**
 * Start a consumer and track it for teardown.
 * @param keys - The case's names.
 * @param consumer - Consumer name.
 * @param handle - What to do with each round.
 * @param settings - Overrides on the fast defaults.
 * @returns The running consumer.
 */
function start(
  keys: ReturnType<typeof keysFor>,
  consumer: string,
  handle: (entries: StreamEntry[], ctl: { stopping: () => boolean }) => Promise<Map<string, EntryOutcome>>,
  settings: Partial<GroupConsumerSettings> = {},
): GroupConsumer {
  const c = startGroupConsumer({
    streamUrl: process.env.REDIS_STREAM_URL!,
    ...keys,
    consumer,
    coordination,
    settings: { ...FAST, ...settings },
    keyOf: (entry) => entry.id,
    process: handle,
  });
  running.push(c);
  return c;
}

/** Every entry in the round is done. */
function allDone(seen: string[]): (entries: StreamEntry[]) => Promise<Map<string, EntryOutcome>> {
  return async (entries) => {
    for (const e of entries) seen.push(e.payload ?? "");
    return new Map(entries.map((e) => [e.id, "done" as const]));
  };
}

/**
 * Wait until a condition holds. A check that throws counts as not yet: the
 * group does not exist until the consumer has created it.
 * @param check - The condition.
 * @param timeoutMs - How long to keep trying.
 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`condition not met in time${last ? `: ${String(last)}` : ""}`);
}

/**
 * How many entries the group still has unacknowledged.
 * @param keys - The case's names.
 * @returns The pending count.
 */
async function pendingCount(keys: ReturnType<typeof keysFor>): Promise<number> {
  const summary = (await stream.xpending(keys.streamKey, keys.group)) as [number, ...unknown[]];
  return Number(summary[0]);
}

describe("startGroupConsumer", () => {
  it("hands each entry to exactly one of two consumers and acknowledges it", async () => {
    const keys = keysFor();
    const payloads = Array.from({ length: 40 }, (_, i) => `e${i}`);
    await append(keys.streamKey, payloads);
    const seenA: string[] = [];
    const seenB: string[] = [];
    start(keys, "a", allDone(seenA));
    start(keys, "b", allDone(seenB));
    await until(() => seenA.length + seenB.length >= payloads.length);
    await until(async () => (await pendingCount(keys)) === 0);
    expect([...seenA, ...seenB].sort()).toEqual([...payloads].sort());
  });

  it("starts the group where the single-instance cursor stopped and keeps that cursor", async () => {
    const keys = keysFor();
    const [first] = await append(keys.streamKey, ["already-handled", "not-yet"]);
    await stream.set(keys.legacyCursorKey, first!);
    const seen: string[] = [];
    start(keys, "a", allDone(seen));
    await until(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual(["not-yet"]);
    expect(await stream.get(keys.legacyCursorKey)).toBe(first);
  });

  it("reads entries written before the group existed when there is no old cursor", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["before-1", "before-2"]);
    const seen: string[] = [];
    start(keys, "a", allDone(seen));
    await until(() => seen.length >= 2);
    expect(seen).toEqual(["before-1", "before-2"]);
  });

  it("passes the origin id a replayed entry carries", async () => {
    const keys = keysFor();
    await stream.xadd(keys.streamKey, "*", "payload", "replayed", "originId", "1700-9");
    const seen: StreamEntry[] = [];
    start(keys, "a", async (entries) => {
      seen.push(...entries);
      return new Map(entries.map((e) => [e.id, "done" as const]));
    });
    await until(() => seen.length >= 1);
    expect(seen[0]!.originId).toBe("1700-9");
    expect(seen[0]!.payload).toBe("replayed");
  });

  it("retries an entry that keeps waiting without ever counting it as a failure", async () => {
    const keys = keysFor();
    const [id] = await append(keys.streamKey, ["busy"]);
    let attempts = 0;
    start(keys, "a", async (entries) => {
      attempts += 1;
      return new Map(entries.map((e) => [e.id, attempts < 10 ? ("wait" as const) : ("done" as const)]));
    });
    await until(() => attempts >= 10);
    await until(async () => (await pendingCount(keys)) === 0);
    expect(await coordination.hget(keys.failuresKey, id!)).toBeNull();
    expect(await stream.xlen(`${keys.streamKey}:dead`)).toBe(0);
  });

  it("counts a failure against the one entry that threw and still acknowledges the rest", async () => {
    const keys = keysFor();
    const [goodId1, badId, goodId2] = await append(keys.streamKey, ["good-1", "bad", "good-2"]);
    const done: string[] = [];
    start(keys, "a", async (entries) =>
      new Map<string, EntryOutcome>(
        entries.map((e): [string, EntryOutcome] => {
          if (e.payload === "bad") return [e.id, { failed: new Error("boom") }];
          done.push(e.payload ?? "");
          return [e.id, "done"];
        }),
      ),
    );
    await until(() => done.length >= 2);
    await until(async () => Number(await coordination.hget(keys.failuresKey, badId!)) >= 1);
    expect(done).toEqual(["good-1", "good-2"]);
    await until(async () => {
      const rows = (await stream.xpending(keys.streamKey, keys.group, "-", "+", 10)) as Array<[string]>;
      const ids = rows.map((r) => r[0]);
      return !ids.includes(goodId1!) && !ids.includes(goodId2!);
    });
  });

  it("moves an entry that keeps throwing to the dead-letter stream with its origin id and acknowledges it", async () => {
    const keys = keysFor();
    const [badId] = await append(keys.streamKey, ["poison"]);
    let attempts = 0;
    start(keys, "a", async (entries) => {
      attempts += 1;
      return new Map(entries.map((e) => [e.id, { failed: new Error(`boom ${attempts}`) }]));
    });
    await until(async () => (await stream.xlen(`${keys.streamKey}:dead`)) === 1);
    await until(async () => (await pendingCount(keys)) === 0);
    expect(attempts).toBe(FAST.maxFailures);
    const [[, fields]] = (await stream.xrange(`${keys.streamKey}:dead`, "-", "+")) as [[string, string[]]];
    const record = Object.fromEntries(
      fields.reduce<string[][]>((acc, v, i) => (i % 2 ? acc : [...acc, [v, fields[i + 1]!]]), []),
    );
    expect(record.payload).toBe("poison");
    expect(record.originId).toBe(badId);
    expect(record.error).toContain("boom");
  });

  it("waits longer between each retry of a failing entry", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["poison"]);
    const at: number[] = [];
    start(
      keys,
      "a",
      async (entries) => {
        at.push(Date.now());
        return new Map(entries.map((e) => [e.id, { failed: new Error("boom") }]));
      },
      { retryMinMs: 100, retryMaxMs: 1000, maxFailures: 3 },
    );
    await until(() => at.length >= 3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(90);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(190);
  });

  it("keeps an entry it is still retrying, so a peer neither retries it too nor dead-letters it twice", async () => {
    const keys = keysFor();
    const [id] = await append(keys.streamKey, ["poison"]);
    const failing = async (entries: StreamEntry[]): Promise<Map<string, EntryOutcome>> =>
      new Map(entries.map((e) => [e.id, { failed: new Error("boom") }]));
    // The backoff (200, 400, 800 ms) outgrows the take-over idle time (300 ms).
    // Only the peer sweeps often, so it is the peer that would take the entry.
    const settings = { claimIdleMs: 300, retryMinMs: 200, retryMaxMs: 800, maxFailures: 4 };
    start(keys, "a", failing, { ...settings, claimIntervalMs: 60_000 });
    await until(async () => (await pendingCount(keys)) === 1);
    let bCalls = 0;
    start(
      keys,
      "b",
      async (entries) => {
        bCalls += 1;
        return failing(entries);
      },
      { ...settings, claimIntervalMs: 100 },
    );
    await until(async () => (await stream.xlen(`${keys.streamKey}:dead`)) >= 1, 10_000);
    await new Promise((r) => setTimeout(r, 2500));
    const dead = (await stream.xrange(`${keys.streamKey}:dead`, "-", "+")) as Array<[string, string[]]>;
    expect(dead.filter(([, f]) => f[f.indexOf("originId") + 1] === id)).toHaveLength(1);
    expect(bCalls).toBe(0);
  });

  it("lets another consumer take over the entries of one that died", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["held-by-a"]);
    // A consumer that read the entry and then died: nothing renews it any more.
    await stream.xgroup("CREATE", keys.streamKey, keys.group, "0", "MKSTREAM");
    await stream.xreadgroup("GROUP", keys.group, "a", "COUNT", 10, "STREAMS", keys.streamKey, ">");
    expect(await pendingCount(keys)).toBe(1);
    const seenB: string[] = [];
    start(keys, "b", allDone(seenB));
    await until(() => seenB.length >= 1);
    expect(seenB).toEqual(["held-by-a"]);
  });

  it("keeps the entries of a live consumer whose round is taking long", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["slow"]);
    let aGotIt = false;
    start(keys, "a", async () => {
      aGotIt = true;
      return new Promise<Map<string, EntryOutcome>>(() => {});
    });
    await until(() => aGotIt);
    const seenB: string[] = [];
    start(keys, "b", allDone(seenB));
    await new Promise((r) => setTimeout(r, FAST.claimIdleMs * 4));
    expect(seenB).toEqual([]);
  });

  it("on a graceful stop hands its unfinished entries to the next sweep and stays registered", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["e1", "e2", "e3"]);
    const a = start(
      keys,
      "a",
      async (entries, ctl) => {
        await until(() => ctl.stopping());
        return new Map(entries.map((e) => [e.id, "wait" as const]));
      },
      { claimIdleMs: 60_000 },
    );
    await until(async () => (await pendingCount(keys)) === 3);
    await a.stop();
    const seenB: string[] = [];
    const startedAt = Date.now();
    start(keys, "b", allDone(seenB), { claimIdleMs: 60_000 });
    await until(() => seenB.length >= 3);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    const consumers = (await stream.xinfo("CONSUMERS", keys.streamKey, keys.group)) as unknown[][];
    const names = consumers.map((c) => c[1]);
    expect(names).toContain("a");
  });

  it("keeps an entry it is still working on past the stop deadline, and acknowledges it once done", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["slow-copy"]);
    let finished = false;
    const a = start(
      keys,
      "a",
      async (entries, ctl) => {
        await until(() => ctl.stopping());
        await new Promise((r) => setTimeout(r, 700));
        finished = true;
        return new Map(entries.map((e) => [e.id, "done" as const]));
      },
      { claimIdleMs: 60_000, stopDeadlineMs: 200 },
    );
    await until(async () => (await pendingCount(keys)) === 1);
    await a.stop();
    expect(finished).toBe(false);
    const [[, , idleMs]] = (await stream.xpending(keys.streamKey, keys.group, "-", "+", 10)) as [
      [string, string, number, number],
    ];
    expect(idleMs).toBeLessThan(10_000);
    await until(() => finished);
    await until(async () => (await pendingCount(keys)) === 0);
  });

  it("sends no renewal chunk once stopping, so the hand-over is not undone", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["w1", "w2", "w3", "w4", "w5", "slow"]);
    const claimIdleMs = 3000;
    let a: GroupConsumer | undefined;
    let stopped: Promise<void> | undefined;
    let slowDone = false;
    let chunksAfterStop = 0;
    let proto: object | null = Object.getPrototypeOf(stream);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "xclaim")) proto = Object.getPrototypeOf(proto);
    const target = proto as { xclaim: (...args: unknown[]) => unknown };
    const original = target.xclaim;
    const spy = vi.spyOn(target, "xclaim").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args.includes("IDLE") || !a) return original.apply(this, args);
      // The first renewal chunk: stop right as it goes out.
      if (!stopped) {
        stopped = a.stop();
        return original.apply(this, args);
      }
      chunksAfterStop += 1;
      return original.apply(this, args);
    });
    try {
      a = start(
        keys,
        "a",
        async (entries, ctl) => {
          // Failing entries sit in the backoff queue, which does not count against
          // maxHeld, so the renewal holds more than one chunk.
          if (entries[0]!.payload !== "slow") return new Map(entries.map((e) => [e.id, { failed: new Error("boom") }]));
          // The round in hand outlives the stop deadline.
          await until(() => ctl.stopping(), 10_000);
          await new Promise((r) => setTimeout(r, 1000));
          slowDone = true;
          return new Map(entries.map((e) => [e.id, "done" as const]));
        },
        { maxHeld: 1, retryMinMs: 60_000, retryMaxMs: 60_000, claimIdleMs, claimIntervalMs: 60_000, stopDeadlineMs: 200 },
      );
      await until(() => stopped !== undefined, 5000);
      await stopped;
      await until(() => slowDone, 5000);
      await until(async () => (await pendingCount(keys)) === 5);
    } finally {
      spy.mockRestore();
    }
    const rows = (await stream.xpending(keys.streamKey, keys.group, "-", "+", 10)) as Array<
      [string, string, number, number]
    >;
    for (const [, , idleMs] of rows) expect(idleMs).toBeGreaterThanOrEqual(claimIdleMs);
    expect(chunksAfterStop).toBe(0);
  });

  it("hands over entries queued behind a running round on a stop, and keeps the running round", async () => {
    const keys = keysFor();
    const [a1, a2, a3] = await append(keys.streamKey, ["a1", "a2", "a3"]);
    let a1Running = false;
    const a = startGroupConsumer({
      streamUrl: process.env.REDIS_STREAM_URL!,
      ...keys,
      consumer: "a",
      coordination,
      settings: { ...FAST, claimIdleMs: 60_000, stopDeadlineMs: 200, keyConcurrency: 2 },
      keyOf: (entry) => (entry.payload ?? "").slice(0, 1),
      process: async (entries, ctl) => {
        if (entries.some((e) => e.payload === "a1")) {
          a1Running = true;
          await until(() => ctl.stopping(), 10_000);
          await new Promise((r) => setTimeout(r, 1000));
        }
        return new Map(entries.map((e) => [e.id, "done" as const]));
      },
    });
    running.push(a);
    await until(() => a1Running);
    await until(async () => (await pendingCount(keys)) === 3);
    await a.stop();
    const idle = new Map(
      ((await stream.xpending(keys.streamKey, keys.group, "-", "+", 10)) as Array<[string, string, number, number]>).map(
        ([id, , idleMs]) => [id, idleMs],
      ),
    );
    // The first read takes one entry per free slot (two), both on key "a", so
    // the running round holds a1 and a2; a3 arrived while it ran.
    expect(idle.get(a1!)).toBeLessThan(10_000);
    expect(idle.get(a2!)).toBeLessThan(10_000);
    expect(idle.get(a3!)).toBeGreaterThanOrEqual(60_000);
  });

  it("retries a waiting entry after leaseRetryMs even while a read is blocked", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["busy-once"]);
    const at: number[] = [];
    start(
      keys,
      "a",
      async (entries) => {
        at.push(Date.now());
        return new Map(entries.map((e) => [e.id, at.length === 1 ? ("wait" as const) : ("done" as const)]));
      },
      { blockMs: 5000, leaseRetryMs: 100, claimIntervalMs: 60_000 },
    );
    await until(() => at.length >= 2, 8000);
    expect(at[1]! - at[0]!).toBeLessThan(1500);
  });

  it("takes over no more idle entries than it has room for", async () => {
    const keys = keysFor();
    await append(keys.streamKey, Array.from({ length: 40 }, (_, i) => `e${i}`));
    // A consumer that read everything and then died.
    await stream.xgroup("CREATE", keys.streamKey, keys.group, "0", "MKSTREAM");
    await stream.xreadgroup("GROUP", keys.group, "dead", "COUNT", 40, "STREAMS", keys.streamKey, ">");
    await new Promise((r) => setTimeout(r, 400));
    start(keys, "a", async () => new Promise<Map<string, EntryOutcome>>(() => {}), {
      maxHeld: 10,
      claimIdleMs: 300,
      claimIntervalMs: 60_000,
    });
    await new Promise((r) => setTimeout(r, 500));
    const consumers = (await stream.xinfo("CONSUMERS", keys.streamKey, keys.group)) as unknown[][];
    const pendingOf = (name: string): number => {
      const row = consumers.find((c) => c[1] === name);
      return row ? Number(row[3]) : 0;
    };
    expect(pendingOf("a")).toBe(10);
    expect(pendingOf("dead")).toBe(30);
  });

  it("hands over at once when a stop lands during a take-over sweep", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["d1", "d2"]);
    await stream.xgroup("CREATE", keys.streamKey, keys.group, "0", "MKSTREAM");
    await stream.xreadgroup("GROUP", keys.group, "dead", "COUNT", 10, "STREAMS", keys.streamKey, ">");
    await new Promise((r) => setTimeout(r, 400));
    let a: GroupConsumer | undefined;
    let stopped: Promise<void> | undefined;
    let proto: object | null = Object.getPrototypeOf(stream);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "xautoclaim")) proto = Object.getPrototypeOf(proto);
    const target = proto as { xautoclaim: (...args: unknown[]) => unknown };
    const original = target.xautoclaim;
    const spy = vi.spyOn(target, "xautoclaim").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (a && !stopped) stopped = a.stop();
      return original.apply(this, args);
    });
    let elapsed = 0;
    try {
      // The two claimed entries fill the room, so no read follows the sweep.
      a = start(keys, "a", allDone([]), {
        maxHeld: 2,
        blockMs: 5000,
        claimIdleMs: 300,
        claimIntervalMs: 60_000,
        stopDeadlineMs: 3000,
      });
      await until(() => stopped !== undefined);
      const startedAt = Date.now();
      await stopped;
      elapsed = Date.now() - startedAt;
    } finally {
      spy.mockRestore();
    }
    expect(elapsed).toBeLessThan(1000);
  });

  it("leaves a slot for a held-back key, so no other key is read while it waits", async () => {
    const keys = keysFor();
    const [x1] = await append(keys.streamKey, ["x1", "y1"]);
    let xTries = 0;
    start(
      keys,
      "a",
      async (entries) =>
        new Map(
          entries.map((e) => [e.id, e.payload === "x1" && (xTries += 1) === 1 ? ("wait" as const) : ("done" as const)]),
        ),
      { keyConcurrency: 1, leaseRetryMs: 600, blockMs: 5000, claimIntervalMs: 60_000 },
    );
    await until(() => xTries === 1);
    await new Promise((r) => setTimeout(r, 300));
    const groups = (await stream.xinfo("GROUPS", keys.streamKey)) as unknown[][];
    const row = groups.find((g) => g[1] === keys.group)!;
    expect(String(row[row.indexOf("last-delivered-id") + 1])).toBe(x1);
    await until(async () => (await pendingCount(keys)) === 0);
  });

  it("does not wake every millisecond while a held-back key is due and every slot is busy", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["y1", "x1"]);
    let xTries = 0;
    let yTries = 0;
    let yRunning = false;
    const tinyTimers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (yRunning && (ms ?? 0) <= 1) tinyTimers.push(Date.now());
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      // y1 fails once and comes back through the backoff queue, which bypasses
      // the read limit, so it takes the only slot while x1 is held back and due.
      start(
        keys,
        "a",
        async (entries) => {
          const payload = entries[0]!.payload;
          if (payload === "y1" && (yTries += 1) === 1) return new Map(entries.map((e) => [e.id, { failed: new Error("boom") }]));
          if (payload === "x1" && (xTries += 1) === 1) return new Map(entries.map((e) => [e.id, "wait" as const]));
          if (payload === "y1") {
            yRunning = true;
            await new Promise((r) => realSetTimeout(r, 1500));
            yRunning = false;
          }
          return new Map(entries.map((e) => [e.id, "done" as const]));
        },
        { keyConcurrency: 1, retryMinMs: 200, retryMaxMs: 200, leaseRetryMs: 400, blockMs: 5000, claimIntervalMs: 60_000 },
      );
      await until(async () => yTries >= 2 && (await pendingCount(keys)) === 0, 8000);
    } finally {
      spy.mockRestore();
    }
    expect(tinyTimers.length).toBeLessThan(20);
  });

  it("walks the whole pending list across sweeps, past entries a live consumer keeps", async () => {
    const keys = keysFor();
    const ids = await append(keys.streamKey, Array.from({ length: 30 }, (_, i) => `e${i}`));
    await stream.xgroup("CREATE", keys.streamKey, keys.group, "0", "MKSTREAM");
    await stream.xreadgroup("GROUP", keys.group, "dead", "COUNT", 30, "STREAMS", keys.streamKey, ">");
    await new Promise((r) => setTimeout(r, 2100));
    // The first 25 move to a live consumer and are fresh again; the last 5 stay idle with the dead one.
    await stream.xclaim(keys.streamKey, keys.group, "live", 0, ...ids.slice(0, 25), "JUSTID");
    // Room 2: one XAUTOCLAIM scans at most 20 entries.
    start(keys, "a", async () => new Promise<Map<string, EntryOutcome>>(() => {}), {
      maxHeld: 2,
      claimIdleMs: 2000,
      claimIntervalMs: 100,
    });
    // Only the idle tail can be claimed; a sweep that restarted at the head
    // every time would never reach it.
    await until(async () => {
      const mine = (await stream.xpending(keys.streamKey, keys.group, "-", "+", 10, "a")) as Array<[string, ...unknown[]]>;
      return mine.length > 0 && mine.every(([id]) => ids.slice(25).includes(id));
    }, 1500);
  });

  it("forgets a consumer that has been idle past the limit with nothing pending", async () => {
    const keys = keysFor();
    await append(keys.streamKey, ["e1"]);
    const seen: string[] = [];
    const a = start(keys, "a", allDone(seen));
    await until(() => seen.length >= 1);
    await until(async () => (await pendingCount(keys)) === 0);
    await a.stop();
    start(keys, "b", allDone([]), { forgetIdleConsumerMs: 50 });
    await until(async () => {
      const consumers = (await stream.xinfo("CONSUMERS", keys.streamKey, keys.group)) as unknown[][];
      return !consumers.some((c) => c[1] === "a");
    });
  });
});
