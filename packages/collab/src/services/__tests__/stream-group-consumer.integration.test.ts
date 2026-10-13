// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consumer-group runner against a real Redis (#1497 §6.1, B6, B7).
 *
 * Every case uses its own stream key so a leftover entry from one case can
 * never be read by another.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  batchCount: 16,
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
 * @param handle - What to do with each batch.
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
    process: handle,
  });
  running.push(c);
  return c;
}

/** Every entry in the batch is done. */
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
    const [first, second] = await append(keys.streamKey, ["already-handled", "not-yet"]);
    await stream.set(keys.legacyCursorKey, first!);
    const seen: string[] = [];
    start(keys, "a", allDone(seen));
    await until(() => seen.length >= 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual(["not-yet"]);
    expect(await stream.get(keys.legacyCursorKey)).toBe(first);
    expect(second).toBeTypeOf("string");
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
    const [, badId] = await append(keys.streamKey, ["good-1", "bad", "good-2"]);
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
    start(keys, "b", failing, { ...settings, claimIntervalMs: 100 });
    await until(async () => (await stream.xlen(`${keys.streamKey}:dead`)) >= 1, 10_000);
    await new Promise((r) => setTimeout(r, 2500));
    const dead = (await stream.xrange(`${keys.streamKey}:dead`, "-", "+")) as Array<[string, string[]]>;
    expect(dead.filter(([, f]) => f[f.indexOf("originId") + 1] === id)).toHaveLength(1);
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

  it("keeps the entries of a live consumer whose batch is taking long", async () => {
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
        return new Map(entries.map((e) => [e.id, "held" as const]));
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
