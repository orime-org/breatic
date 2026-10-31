// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The cross-instance seat registry against a real Redis (inner#1034).
 *
 * Every new seat goes through one Lua script, in one of two modes: `arrive`
 * (the `connected` hook taking a seat) and `refresh` (a pong renewing one).
 * The script prunes, counts against the cap and, when the document is full,
 * may replace one of the arriving person's own EARLIER connections — all in
 * one step, so two handshakes can no longer both read "one seat left".
 *
 * The cases here follow the test specification for inner#1034:
 *
 *   A  one registry, one Redis: every script branch, the reply handling that
 *      drops a reply whose entry has gone, errors and client timeouts
 *   C  two registries on two connections sharing one Redis
 *   D  a fast-check model run over arbitrary arrivals, pongs, disconnects,
 *      clock moves, key expiry, failures and reply orderings
 *
 * Nothing here mocks Redis. Failures, timeouts and late replies are injected
 * by a layer in front of the real client (`helpers/seat-redis.ts`) that never
 * changes the order commands reach Redis. Each case writes to keys of its own
 * and nothing calls FLUSHDB: the container is shared with other files.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";

import type * as CoreModule from "@breatic/core";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

// Real core, apart from the logger: the registry is the one place a failed
// script logs, and these cases read what it logged.
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => ({ warn: logWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { createRedisClient, initCore, type Redis } from "@breatic/core";
import {
  createConnectionRegistry,
  silentSeatCutoff,
  type ConnectionRegistry,
} from "@collab/services/connection-registry.js";

import { evalsOn, m, wrapRedis, zremsOf, type WrappedRedis } from "./helpers/seat-redis.js";

const PING = 30_000;
const EXPIRY = 60_000;
const T = 1_700_000_000_000;
const DOC = "doc";

type TakeResult = Awaited<ReturnType<ConnectionRegistry["takeSeat"]>>;
type RefreshItem = Awaited<ReturnType<ConnectionRegistry["refreshSocket"]>>[number];

let R: Redis;
const opened: Redis[] = [];
let ns = "";
let clock = T;

/**
 * This case's key for a document.
 * @param documentName - The document.
 * @returns A key no other case writes.
 */
function keyFor(documentName: string): string {
  return `${ns}:${documentName}`;
}

/**
 * A seat holder.
 * @param socketId - The socket.
 * @param userId - Who.
 * @param arrivedAtMs - When that connection entered the document.
 * @returns The holder `takeSeat` takes.
 */
function H(socketId: string, userId: string, arrivedAtMs: number): { socketId: string; userId: string; arrivedAtMs: number } {
  return { socketId, userId, arrivedAtMs };
}

/**
 * A registry over a dedicated, wrapped client.
 * @param instanceId - The instance it speaks for.
 * @param options - Overrides.
 * @param options.keyFor - Key builder; omit to use the case's own.
 * @param options.useDefaultKey - Leave the key builder out entirely.
 * @returns The registry and its wrapper.
 */
function build(
  instanceId = "i1",
  options: { useDefaultKey?: boolean } = {},
): { reg: ConnectionRegistry; w: WrappedRedis } {
  const real = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: `itest-seat-${instanceId}` });
  opened.push(real);
  const w = wrapRedis(real);
  const reg = createConnectionRegistry({
    redis: w.client,
    instanceId,
    pingIntervalMs: PING,
    seatExpiryMs: EXPIRY,
    now: () => clock,
    ...(options.useDefaultKey ? {} : { keyFor }),
  });
  return { reg, w };
}

/**
 * Put a member in a set as if another instance or connection had written it.
 * @param documentName - The document.
 * @param score - Its last-pong score.
 * @param member - The member string.
 * @returns Once written.
 */
async function seed(documentName: string, score: number, member: string): Promise<void> {
  await R.zadd(keyFor(documentName), score, member);
}

/**
 * Read a set.
 * @param documentName - The document.
 * @returns member → score.
 */
async function members(documentName: string): Promise<Record<string, number>> {
  const raw = await R.zrange(keyFor(documentName), 0, -1, "WITHSCORES");
  const out: Record<string, number> = {};
  for (let i = 0; i < raw.length; i += 2) out[raw[i]!] = Number(raw[i + 1]);
  return out;
}

/**
 * Whether a member is in a set.
 * @param documentName - The document.
 * @param member - The member.
 * @returns True when present.
 */
async function has(documentName: string, member: string): Promise<boolean> {
  return (await R.zscore(keyFor(documentName), member)) !== null;
}

/**
 * Tell an `arriving` entry from a `held` one by what the script does with
 * it. Removes the entry's member, seats an earlier fresh member of the same
 * user, fills the rest of a cap of 2 with someone else, and pongs:
 * `arrive` mode replaces the earlier member, `refresh` mode never
 * replaces and reports the seat lost.
 * @param reg - The registry.
 * @param socketId - The entry's socket.
 * @param member - The entry's member.
 * @param userId - Its user.
 * @returns `arriving`, `held`, or what the pong returned when it was neither.
 */
async function probeMode(reg: ConnectionRegistry, socketId: string, member: string, userId: string): Promise<string> {
  const key = keyFor(DOC);
  const earlier = m(userId, 1, "i-probe", "s-probe");
  await R.zrem(key, member);
  await R.zadd(key, clock, earlier);
  const card = await R.zcard(key);
  for (let i = card; i < 2; i++) await R.zadd(key, clock, m(`probe-other-${i}`, 1, "i-probe", `s-other-${i}`));
  const result = await reg.refreshSocket(socketId);
  const item = result.find((r) => r.documentName === DOC);
  if (item?.outcome === "replaced" && item.replaced === earlier) return "arriving";
  if (item?.outcome === "lost" && (await R.zscore(key, earlier)) !== null) return "held";
  return JSON.stringify(result);
}

/**
 * Whether the registry logged a warn carrying this tag.
 * @param tag - The log tag.
 * @returns True when one was logged.
 */
function warned(tag: string): boolean {
  return logWarn.mock.calls.some(
    ([fields, message]) =>
      message === tag ||
      (typeof fields === "object" && fields !== null && ((fields as { tag?: unknown }).tag === tag || (fields as { reason?: unknown }).reason === tag)),
  );
}

beforeAll(() => {
  initCore(process.env);
  R = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-seat-raw" });
});

beforeEach(() => {
  ns = `t1034:${randomUUID()}`;
  clock = T;
  logWarn.mockClear();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.quit()));
});

afterAll(async () => {
  await R.quit();
});

describe("A · the script's branches", () => {
  it("A01 seats a connection on an empty document and renews the key", async () => {
    const { reg } = build();
    expect(await reg.takeSeat(DOC, H("s1", "u1", 5000), 2)).toEqual({ outcome: "seated" });
    expect(await members(DOC)).toEqual({ [m("u1", 5000, "i1", "s1")]: T });
    const ttl = await R.ttl(keyFor(DOC));
    expect(ttl).toBeGreaterThan(118);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it("A02 answers full when the document is full of other people, releases the member and does not take a freed seat later", async () => {
    const { reg, w } = build();
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    const mine = m("u1", 5000, "i1", "s9");

    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "full", liveCount: 2 });
    expect(await has(DOC, mine)).toBe(false);
    expect(await R.zcard(keyFor(DOC))).toBe(2);
    await w.flush();
    const evalAt = w.log.findIndex((c) => c.name === "eval");
    expect(evalAt).toBeGreaterThanOrEqual(0);
    expect(zremsOf(w.log.slice(evalAt + 1), keyFor(DOC), mine)).toHaveLength(1);

    await R.zrem(keyFor(DOC), m("u2", 1000, "i2", "x2"));
    const mark = w.log.length;
    expect(await reg.refreshSocket("s9")).toEqual([]);
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
    expect(await has(DOC, mine)).toBe(false);
  });

  it("A03 treats a cap of zero as zero", async () => {
    const { reg } = build();
    expect(await reg.takeSeat(DOC, H("s1", "u1", 5000), 0)).toEqual({ outcome: "full", liveCount: 0 });
    expect(await R.zcard(keyFor(DOC))).toBe(0);
  });

  it("A04 prunes members at or past the expiry line before counting", async () => {
    const { reg } = build();
    await seed(DOC, T - 60_000, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T - 1, m("u3", 1000, "i2", "x3"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "seated" });
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 5000, "i1", "s9"), m("u3", 1000, "i2", "x3")].sort());
  });

  it("A05 replaces the person's earliest connection when every one of theirs is answering", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T, m("u1", 2000, "i2", "sb"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 1000, "i2", "sa"),
    });
    expect(await members(DOC)).toEqual({ [m("u1", 2000, "i2", "sb")]: T, [m("u1", 5000, "i1", "s9")]: T });
  });

  it("A06 replaces a connection that stopped answering before an older one that answers", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T - 40_000, m("u1", 2000, "i2", "sb"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 2000, "i2", "sb"),
    });
  });

  it("A06b counts a score exactly on the silent line as still answering", async () => {
    const { reg } = build();
    expect(silentSeatCutoff(T, PING)).toBe(T - 33_000);
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T - 33_000, m("u1", 2000, "i2", "sb"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 1000, "i2", "sa"),
    });
  });

  it("A07 only replaces connections that entered before this one, however silent a later one is", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T - 40_000, m("u1", 9000, "i2", "sc"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 1000, "i2", "sa"),
    });
    expect(await has(DOC, m("u1", 9000, "i2", "sc"))).toBe(true);
  });

  it("A07b answers full when the person's only seat entered after this connection", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 9000, "i2", "sc"));
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    const before = await members(DOC);
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "full", liveCount: 2 });
    expect(await members(DOC)).toEqual(before);
  });

  it("A08 breaks a tie on the arrival moment by the member string (smaller is earlier)", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 5000, "i1", "s1"));
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 5000, "i1", "s1"),
    });
  });

  it("A08b does not replace a tied member whose string is larger", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u1", 5000, "i1", "s9"));
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    const before = await members(DOC);
    expect(await reg.takeSeat(DOC, H("s1", "u1", 5000), 2)).toEqual({ outcome: "full", liveCount: 2 });
    expect(await members(DOC)).toEqual(before);
  });

  it("A09 matches the person by the whole user id, not a prefix of it", async () => {
    const { reg } = build();
    await seed(DOC, T, m("u10", 1000, "i2", "sx"));
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "full", liveCount: 2 });
    expect(await has(DOC, m("u10", 1000, "i2", "sx"))).toBe(true);
  });

  it("A10 never replaces a member whose arrival moment it cannot read", async () => {
    const { reg } = build();
    await seed(DOC, T, "u1:abc:i2:sx");
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "full", liveCount: 2 });
    expect(await has(DOC, "u1:abc:i2:sx")).toBe(true);
  });

  it("A11 keeps a seat the timed-out script took, without adding a second member", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s9");
    w.fail("eval", "send-then-reject");
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "unknown" });
    expect(await has(DOC, mine)).toBe(true);
    await R.expire(keyFor(DOC), 10);

    clock = T + 10_000;
    expect(await reg.refreshSocket("s9")).toEqual([]);
    expect(await members(DOC)).toEqual({ [mine]: T + 10_000 });
    expect(await R.ttl(keyFor(DOC))).toBeGreaterThan(118);
  });

  it("A11b keeps a held seat when the document holds more than the cap (a lowered cap evicts nobody)", async () => {
    const { reg } = build();
    const mine = m("u1", 5000, "i1", "s9");
    await reg.takeSeat(DOC, H("s9", "u1", 5000), 2);
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));

    clock = T + 5_000;
    expect(await reg.refreshSocket("s9")).toEqual([]);
    const after = await members(DOC);
    expect(Object.keys(after)).toHaveLength(3);
    expect(after[mine]).toBe(T + 5_000);
  });

  it("A12 moves a held seat forward on a pong and renews the key", async () => {
    const { reg } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await R.expire(keyFor(DOC), 10);

    clock = T + 30_000;
    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect(await members(DOC)).toEqual({ [mine]: T + 30_000 });
    expect(await R.ttl(keyFor(DOC))).toBeGreaterThan(118);
  });

  it("A13 takes the seat back on a pong when the key has gone and there is room", async () => {
    const { reg } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await R.del(keyFor(DOC));

    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect(Object.keys(await members(DOC))).toEqual([mine]);
  });

  it("A14 reports a held seat lost when it is gone and the document is full, and never replaces on a pong", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await R.zrem(keyFor(DOC), mine);
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));

    const mark = w.log.length;
    expect(await reg.refreshSocket("s1")).toEqual([{ documentName: DOC, outcome: "lost", liveCount: 2, cap: 2 }]);
    expect(await has(DOC, m("u1", 1000, "i2", "sa"))).toBe(true);
    await w.flush();
    const slice = w.log.slice(mark);
    const evalAt = slice.findIndex((c) => c.name === "eval");
    expect(zremsOf(slice.slice(evalAt + 1), keyFor(DOC), mine)).toHaveLength(1);

    const again = w.log.length;
    await reg.refreshSocket("s1");
    expect(evalsOn(w.log.slice(again), keyFor(DOC))).toHaveLength(0);
  });

  it("A14b reports a seat lost when a late pong finds it pruned and the document full", async () => {
    const { reg } = build();
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    clock = T + 61_000;
    await seed(DOC, T + 61_000, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T + 61_000, m("u3", 1000, "i2", "x3"));

    expect(await reg.refreshSocket("s1")).toEqual([{ documentName: DOC, outcome: "lost", liveCount: 2, cap: 2 }]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u2", 1000, "i2", "x2"), m("u3", 1000, "i2", "x3")].sort());
  });
});

describe("A · a reply whose entry has gone, and the in-flight script", () => {
  it("A15 records the entry before the script is sent, so a disconnect in the same turn releases the seat", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    const p = reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    const u = reg.unregister(DOC, "s1");
    await u;
    expect(await p).toEqual({ outcome: "gone" });
    expect(await R.zcard(keyFor(DOC))).toBe(0);
    const evalAt = w.log.findIndex((c) => c.name === "eval");
    const zremAt = w.log.findIndex((c) => c.name === "zrem" && zremsOf([c], keyFor(DOC), mine).length === 1);
    expect(evalAt).toBeGreaterThanOrEqual(0);
    expect(zremAt).toBeGreaterThan(evalAt);
  });

  it("A15b releases the seat of a disconnect in the same turn after Redis has lost its script cache", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("s0", "u0", 1000), 2);
    await reg.unregister(DOC, "s0");
    // Redis forgets every cached script; the client stays connected.
    await R.script("FLUSH");
    const p = reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    const u = reg.unregister(DOC, "s1");
    await u;
    expect(await p).toEqual({ outcome: "gone" });
    await w.flush();
    expect(await members(DOC)).toEqual({});
  });

  it("A16 drops a seated reply that comes back after the disconnect", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    const held = w.hold("eval");
    const p = reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await held.executed;
    await reg.unregister(DOC, "s1");
    held.release();

    expect(await p).toEqual({ outcome: "gone" });
    expect(await R.zcard(keyFor(DOC))).toBe(0);
    expect(zremsOf(w.log, keyFor(DOC), mine)).toHaveLength(1);
  });

  it("A17 drops a reply that comes back after the seat was demoted away", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    const held = w.hold("eval");
    const p = reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await held.executed;
    await reg.forgetSeat(DOC, mine);
    held.release();

    expect(await p).toEqual({ outcome: "gone" });
    expect(await R.zcard(keyFor(DOC))).toBe(0);
    const mark = w.log.length;
    await reg.refreshSocket("s1");
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
  });

  it("A18 drops a full reply that comes back after the disconnect: no extra release", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s9");
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    const held = w.hold("eval");
    const p = reg.takeSeat(DOC, H("s9", "u1", 5000), 2);
    await held.executed;
    await reg.unregister(DOC, "s9");
    held.release();

    expect(await p).toEqual({ outcome: "gone" });
    await w.flush();
    expect(zremsOf(w.log, keyFor(DOC), mine)).toHaveLength(1);
  });

  it("A19 drops a replaced reply after the disconnect; the replaced connection takes a seat back on its next pong", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("sa", "u1", 1000), 2);
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    const held = w.hold("eval");
    const p = reg.takeSeat(DOC, H("s9", "u1", 5000), 2);
    await held.executed;
    await reg.unregister(DOC, "s9");
    held.release();

    expect(await p).toEqual({ outcome: "gone" });
    expect(await reg.refreshSocket("sa")).toEqual([]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 1000, "i1", "sa"), m("u2", 1000, "i2", "x2")].sort());
  });

  it("A20 drops an old reply once the same socket and document hold a newer entry", async () => {
    const { reg, w } = build();
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    const newer = m("u1", 7000, "i1", "s1");
    const held = w.hold("eval");
    const p1 = reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await held.executed;
    await reg.unregister(DOC, "s1");
    await R.zrem(keyFor(DOC), m("u2", 1000, "i2", "x2"));
    expect(await reg.takeSeat(DOC, H("s1", "u1", 7000), 2)).toEqual({ outcome: "seated" });
    held.release();

    expect(await p1).toEqual({ outcome: "gone" });
    await w.flush();
    expect(await has(DOC, newer)).toBe(true);
    clock = T + 1_000;
    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect((await members(DOC))[newer]).toBe(T + 1_000);
  });

  it("A21 skips an entry whose script is in flight when the socket pongs", async () => {
    const { reg, w } = build();
    const held = w.hold("eval");
    const p = reg.takeSeat("docA", H("s1", "u1", 5000), 2);
    await held.executed;
    expect(await reg.takeSeat("docB", H("s1", "u1", 5000), 2)).toEqual({ outcome: "seated" });

    const mark = w.log.length;
    await reg.refreshSocket("s1");
    const slice = w.log.slice(mark);
    expect(evalsOn(slice, keyFor("docB"))).toHaveLength(1);
    expect(evalsOn(slice, keyFor("docA"))).toHaveLength(0);
    expect(evalsOn(w.log, keyFor("docA"))).toHaveLength(1);
    held.release();
    expect(await p).toEqual({ outcome: "seated" });
  });

  it("A21b skips a held entry whose renewal is still in flight", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    const held = w.hold("eval");
    const r1 = reg.refreshSocket("s1");
    await held.executed;

    const mark = w.log.length;
    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
    held.release();
    expect(await r1).toEqual([]);
  });

  it("A22 drops a renewal reply that comes back after the disconnect", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    const held = w.hold("eval");
    const r = reg.refreshSocket("s1");
    await held.executed;
    await reg.unregister(DOC, "s1");
    held.release();

    expect(await r).toEqual([]);
    expect(await has(DOC, mine)).toBe(false);
  });

  it("A23 drops a lost reply that comes back after the demote: one release, no second report", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await R.zrem(keyFor(DOC), mine);
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    const held = w.hold("eval");
    const r = reg.refreshSocket("s1");
    await held.executed;
    await reg.forgetSeat(DOC, mine);
    held.release();

    expect(await r).toEqual([]);
    await w.flush();
    expect(zremsOf(w.log, keyFor(DOC), mine)).toHaveLength(1);
  });
});

describe("A · Redis errors, client timeouts and retries", () => {
  it("A24 retries an errored arrival on the next pong as an arrival, with its original arrival moment", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("sa", "u1", 1000), 2);
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    const before = await members(DOC);
    w.fail("eval", "reject-before-send");
    expect(await reg.takeSeat(DOC, H("s9", "u1", 2000), 2)).toEqual({ outcome: "unknown" });
    expect(await members(DOC)).toEqual(before);
    expect(warned("conn_registry_take_failed")).toBe(true);

    clock = T + 30_000;
    expect(await reg.refreshSocket("s9")).toEqual([
      { documentName: DOC, outcome: "replaced", replaced: m("u1", 1000, "i1", "sa") },
    ]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 2000, "i1", "s9"), m("u2", 1000, "i2", "x2")].sort());
  });

  it("A25 keeps an arrival whose script ran but whose reply timed out, and settles it on the next pong", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    w.fail("eval", "send-then-reject");
    expect(await reg.takeSeat(DOC, H("s1", "u1", 5000), 2)).toEqual({ outcome: "unknown" });
    expect(await has(DOC, mine)).toBe(true);

    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect(await R.zcard(keyFor(DOC))).toBe(1);
    expect(await probeMode(reg, "s1", mine, "u1")).toBe("held");
  });

  it("A26 does not let a retry take the seat of the person's later connection", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("sb", "u2", 500), 2);
    await reg.takeSeat(DOC, H("s1", "u1", 1000), 2);
    w.fail("eval", "reject-before-send");
    expect(await reg.takeSeat(DOC, H("s2", "u1", 2000), 2)).toEqual({ outcome: "unknown" });
    expect(await reg.takeSeat(DOC, H("s3", "u1", 3000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 1000, "i1", "s1"),
    });

    expect(await reg.refreshSocket("s2")).toEqual([
      { documentName: DOC, outcome: "full", liveCount: 2, cap: 2 },
    ]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 3000, "i1", "s3"), m("u2", 500, "i1", "sb")].sort());
  });

  it("A27 makes a timed-out arrival whose seat was then replaced read-only on its retry", async () => {
    const { reg, w } = build();
    await reg.takeSeat(DOC, H("sb", "u2", 500), 2);
    w.fail("eval", "send-then-reject");
    expect(await reg.takeSeat(DOC, H("s1", "u1", 1000), 2)).toEqual({ outcome: "unknown" });
    expect(await reg.takeSeat(DOC, H("s2", "u1", 2000), 2)).toEqual({
      outcome: "replaced",
      replaced: m("u1", 1000, "i1", "s1"),
    });

    expect(await reg.refreshSocket("s1")).toEqual([
      { documentName: DOC, outcome: "full", liveCount: 2, cap: 2 },
    ]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 2000, "i1", "s2"), m("u2", 500, "i1", "sb")].sort());
    const mark = w.log.length;
    await reg.refreshSocket("s1");
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
  });

  it("A28 seats an errored arrival on the next pong once there is room", async () => {
    const { reg, w } = build();
    await seed(DOC, T, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    w.fail("eval", "reject-before-send");
    expect(await reg.takeSeat(DOC, H("s9", "u1", 5000), 2)).toEqual({ outcome: "unknown" });
    await R.zrem(keyFor(DOC), m("u2", 1000, "i2", "x2"));

    expect(await reg.refreshSocket("s9")).toEqual([]);
    expect(await has(DOC, m("u1", 5000, "i1", "s9"))).toBe(true);
  });

  it("A29 keeps a held seat through a failed renewal and renews it as held next time", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    w.fail("eval", "reject-before-send");
    await expect(reg.refreshSocket("s1")).resolves.toEqual([]);
    expect(await has(DOC, mine)).toBe(true);
    expect(warned("conn_registry_refresh_failed")).toBe(true);

    const mark = w.log.length;
    expect(await reg.refreshSocket("s1")).toEqual([]);
    const renewals = evalsOn(w.log.slice(mark), keyFor(DOC));
    expect(renewals).toHaveLength(1);
    expect(renewals[0]!.args).toContain("refresh");
    expect(await probeMode(reg, "s1", mine, "u1")).toBe("held");
  });

  it("A30 counts after pruning expired members", async () => {
    const { reg } = build();
    await seed(DOC, T - 70_000, m("u2", 1000, "i2", "x2"));
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    expect(await reg.count(DOC)).toBe(1);
    expect(await has(DOC, m("u2", 1000, "i2", "x2"))).toBe(false);
  });

  it("A30b counts nobody when Redis fails, rather than locking everyone out", async () => {
    const { reg, w } = build();
    await seed(DOC, T, m("u3", 1000, "i2", "x3"));
    w.fail("zremrangebyscore", "reject-before-send");
    await expect(reg.count(DOC)).resolves.toBe(0);
    w.fail("zcard", "reject-before-send");
    await expect(reg.count(DOC)).resolves.toBe(0);
  });

  it("A31 says whether the person already holds a seat: yes, no, or could not tell", async () => {
    const { reg, w } = build();
    await seed(DOC, T, m("u1", 1000, "i2", "sa"));
    await seed(DOC, T, m("u10", 1000, "i2", "sx"));
    await seed("doc2", T, m("u10", 1000, "i2", "sx"));
    expect(await reg.hasOwnSeat(DOC, "u1")).toBe("yes");
    expect(await reg.hasOwnSeat(DOC, "u2")).toBe("no");
    expect(await reg.hasOwnSeat("doc2", "u1")).toBe("no");
    w.fail("*", "reject-before-send", 5);
    expect(await reg.hasOwnSeat(DOC, "u1")).toBe("unknown");
  });

  it("A31b does not count an expired seat of the person's own", async () => {
    const { reg } = build();
    await seed(DOC, T - 61_000, m("u1", 1000, "i2", "sa"));
    expect(await reg.hasOwnSeat(DOC, "u1")).toBe("no");
  });

  it("A32 releases a seat on disconnect, document by document, and fails open", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    await reg.takeSeat("docA", H("s1", "u1", 5000), 2);
    await reg.takeSeat("docB", H("s1", "u1", 5000), 2);

    await reg.unregister("docA", "s1");
    expect(await has("docA", mine)).toBe(false);
    expect(await has("docB", mine)).toBe(true);

    const mark = w.log.length;
    await reg.unregister("docA", "s-unknown");
    expect(w.log.slice(mark)).toEqual([]);

    w.fail("zrem", "reject-before-send");
    await expect(reg.unregister("docB", "s1")).resolves.toBeUndefined();
  });

  it("A33 lets go of a demoted seat: out of Redis and out of the pong's reach, whoever wrote it", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    const foreign = m("u1", 1000, "i2", "sx");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await seed(DOC, T, foreign);

    await reg.forgetSeat(DOC, mine);
    expect(await has(DOC, mine)).toBe(false);
    const mark = w.log.length;
    await reg.refreshSocket("s1");
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);

    await reg.forgetSeat(DOC, foreign);
    expect(await has(DOC, foreign)).toBe(false);

    w.fail("zrem", "reject-before-send");
    await expect(reg.forgetSeat(DOC, m("u9", 1, "i9", "s9"))).resolves.toBeUndefined();
  });

  it("A33b lets go of an arrival waiting for its retry", async () => {
    const { reg, w } = build();
    const mine = m("u1", 5000, "i1", "s1");
    w.fail("eval", "send-then-reject");
    await reg.takeSeat(DOC, H("s1", "u1", 5000), 2);
    await reg.forgetSeat(DOC, mine);
    expect(await has(DOC, mine)).toBe(false);
    const mark = w.log.length;
    await reg.refreshSocket("s1");
    expect(evalsOn(w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
  });

  it("A34 releases an arrival that is waiting for its retry when it disconnects", async () => {
    const { reg, w } = build();
    w.fail("eval", "send-then-reject");
    expect(await reg.takeSeat(DOC, H("s1", "u1", 5000), 2)).toEqual({ outcome: "unknown" });
    await reg.unregister(DOC, "s1");
    expect(await R.zcard(keyFor(DOC))).toBe(0);
  });

  it("A35 re-seats connections first come first served after the key expires", async () => {
    const { reg } = build();
    await reg.takeSeat(DOC, H("s1", "u1", 1000), 2);
    await reg.takeSeat(DOC, H("s2", "u2", 2000), 2);
    await R.zrem(keyFor(DOC), m("u2", 2000, "i1", "s2"));
    await reg.takeSeat(DOC, H("s3", "u3", 3000), 2);
    await R.del(keyFor(DOC));

    expect(await reg.refreshSocket("s1")).toEqual([]);
    expect(await reg.refreshSocket("s2")).toEqual([]);
    expect(await reg.refreshSocket("s3")).toEqual([{ documentName: DOC, outcome: "lost", liveCount: 2, cap: 2 }]);
    expect(Object.keys(await members(DOC)).sort()).toEqual([m("u1", 1000, "i1", "s1"), m("u2", 2000, "i1", "s2")].sort());
  });
});

describe("A · what the registry kept doing before inner#1034", () => {
  it("counts every seat, and drops a disconnected one straight away", async () => {
    const { reg } = build();
    await reg.takeSeat(DOC, H("sock-1", "user-a", 1000), 5);
    await reg.takeSeat(DOC, H("sock-2", "user-b", 1000), 5);
    expect(await reg.count(DOC)).toBe(2);
    await reg.unregister(DOC, "sock-1");
    expect(await reg.count(DOC)).toBe(1);
  });

  it("keeps two instances' seats apart even when the socket ids collide", async () => {
    const a = build("inst-a");
    const b = build("inst-b");
    await a.reg.takeSeat(DOC, H("sock-1", "user-a", 1000), 5);
    await b.reg.takeSeat(DOC, H("sock-1", "user-b", 1000), 5);
    expect(await a.reg.count(DOC)).toBe(2);
    expect(await b.reg.count(DOC)).toBe(2);
  });

  it("prunes a seat nobody refreshed, so a crashed instance heals itself", async () => {
    const { reg } = build();
    await reg.takeSeat(DOC, H("sock-1", "user-a", 1000), 5);
    clock = T + EXPIRY + 1_000;
    expect(await reg.count(DOC)).toBe(0);
  });

  it("keeps a seat whose connection is still answering", async () => {
    const { reg } = build();
    await reg.takeSeat(DOC, H("sock-1", "user-a", 1000), 5);
    clock = T + 30_000;
    await reg.refreshSocket("sock-1");
    clock = T + 60_000;
    expect(await reg.count(DOC)).toBe(1);
  });

  it("refreshes every seat a socket holds from one pong", async () => {
    const { reg } = build();
    await reg.takeSeat("doc-1", H("sock-1", "user-a", 1000), 5);
    await reg.takeSeat("doc-2", H("sock-1", "user-a", 1000), 5);
    clock = T + 30_000;
    expect(await reg.refreshSocket("sock-1")).toEqual([]);
    expect(Object.values(await members("doc-1"))).toEqual([T + 30_000]);
    expect(Object.values(await members("doc-2"))).toEqual([T + 30_000]);
  });

  it("leaves a socket that holds no seats alone", async () => {
    const { reg, w } = build();
    expect(await reg.refreshSocket("sock-viewer")).toEqual([]);
    expect(w.log).toEqual([]);
  });

  it("keeps refreshing a socket's other documents after one was demoted", async () => {
    const { reg } = build();
    await reg.takeSeat("doc-demoted", H("sock-1", "user-a", 1000), 5);
    await reg.takeSeat("doc-kept", H("sock-1", "user-a", 1000), 5);
    await reg.forgetSeat("doc-demoted", m("user-a", 1000, "i1", "sock-1"));
    clock = T + 30_000;
    await reg.refreshSocket("sock-1");
    expect(await R.zcard(keyFor("doc-demoted"))).toBe(0);
    expect(Object.values(await members("doc-kept"))).toEqual([T + 30_000]);
  });

  // What the silent line has to separate, as two numbers. Above it: a live
  // seat's score is rewritten once per ping period, so just before each
  // refresh a healthy seat is one full period stale. Below it: a seat whose
  // client is reconnecting cannot be fresher than that client's own reconnect
  // delay, measured at 36991 ms with @hocuspocus/provider 4.6.0. How far above
  // the ceiling is deliberately not pinned.
  it("puts the silent line above a live seat's ceiling", () => {
    expect(silentSeatCutoff(T, PING)).toBeLessThan(T - PING);
  });

  it("puts the silent line below the client's reconnect delay", () => {
    expect(silentSeatCutoff(T, PING)).toBeGreaterThan(T - 36_991);
  });

  // Two deployments share DB3 and are separated only by the key prefix, so
  // dropping it lets one deployment's handshake count, and replace, the
  // other's members.
  it("names the key after the deployment when none is injected", async () => {
    const { reg } = build("i1", { useDefaultKey: true });
    const documentName = `project-${randomUUID()}/canvas-${randomUUID()}`;
    const key = `dev:collab:seats:${documentName}`;
    try {
      expect(await reg.takeSeat(documentName, H("sock-1", "user-a", 1000), 2)).toEqual({ outcome: "seated" });
      expect(await R.zrange(key, 0, -1)).toEqual([m("user-a", 1000, "i1", "sock-1")]);
    } finally {
      await R.del(key);
    }
  });
});

/**
 * Shuffle in place.
 * @param items - The array.
 * @returns The same array.
 */
function shuffle<X>(items: X[]): X[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

describe("C · two instances on one Redis", () => {
  const ROUNDS = 30;

  it("C01 seats exactly cap of six different people arriving at once", async () => {
    const i1 = build("i1");
    const i2 = build("i2");
    for (let round = 0; round < ROUNDS; round++) {
      ns = `t1034:${randomUUID()}`;
      const arrivals = shuffle(
        Array.from({ length: 6 }, (_, k) => {
          const inst = k % 2 === 0 ? "i1" : "i2";
          return { reg: inst === "i1" ? i1.reg : i2.reg, member: m(`u${k}`, 1000, inst, `r${round}s${k}`), holder: H(`r${round}s${k}`, `u${k}`, 1000) };
        }),
      );
      const results = await Promise.all(arrivals.map((a) => a.reg.takeSeat(DOC, a.holder, 2)));
      const seated = arrivals.filter((_, k) => results[k]!.outcome === "seated").map((a) => a.member);
      expect(seated).toHaveLength(2);
      expect(results.filter((r) => r.outcome === "full")).toHaveLength(4);
      for (const r of results) if (r.outcome === "full") expect(r).toEqual({ outcome: "full", liveCount: 2 });
      expect(Object.keys(await members(DOC)).sort()).toEqual(seated.sort());
    }
  });

  it("C02 leaves one person's two latest tabs seated when four arrive at once", async () => {
    const i1 = build("i1");
    const i2 = build("i2");
    for (let round = 0; round < ROUNDS; round++) {
      ns = `t1034:${randomUUID()}`;
      const tabs = shuffle(
        [1001, 1002, 1003, 1004].map((at, k) => {
          const inst = k % 2 === 0 ? "i1" : "i2";
          return { at, reg: inst === "i1" ? i1.reg : i2.reg, member: m("u1", at, inst, `r${round}t${at}`), holder: H(`r${round}t${at}`, "u1", at) };
        }),
      );
      const results: TakeResult[] = await Promise.all(tabs.map((t) => t.reg.takeSeat(DOC, t.holder, 2)));
      const byAt = new Map(tabs.map((t, k) => [t.at, { member: t.member, result: results[k]! }]));
      const memberOf = (at: number): string => byAt.get(at)!.member;

      expect(Object.keys(await members(DOC)).sort()).toEqual([memberOf(1003), memberOf(1004)].sort());
      for (const at of [1003, 1004]) expect(["seated", "replaced"]).toContain(byAt.get(at)!.result.outcome);
      const named = results.flatMap((r) => (r.outcome === "replaced" ? [r.replaced] : []));
      for (const x of named) expect([memberOf(1001), memberOf(1002)]).toContain(x);
      for (const at of [1001, 1002]) {
        const own = byAt.get(at)!.result.outcome === "full" ? 1 : 0;
        expect(own + named.filter((x) => x === memberOf(at)).length).toBe(1);
      }
    }
  });

  it("C03 leaves exactly one of three connections without a seat (A's two tabs and B's one, cap 2)", async () => {
    const i1 = build("i1");
    const i2 = build("i2");
    for (let round = 0; round < ROUNDS; round++) {
      ns = `t1034:${randomUUID()}`;
      const arrivals = shuffle([
        { user: "uA", at: 1001, inst: "i1" },
        { user: "uA", at: 1002, inst: "i2" },
        { user: "uB", at: 1001, inst: round % 2 === 0 ? "i1" : "i2" },
      ]).map((a, k) => ({
        ...a,
        reg: a.inst === "i1" ? i1.reg : i2.reg,
        member: m(a.user, a.at, a.inst, `r${round}c${k}`),
        holder: H(`r${round}c${k}`, a.user, a.at),
      }));
      const results = await Promise.all(arrivals.map((a) => a.reg.takeSeat(DOC, a.holder, 2)));
      expect(await R.zcard(keyFor(DOC))).toBe(2);
      const named = results.flatMap((r) => (r.outcome === "replaced" ? [r.replaced] : []));
      const losers = arrivals.filter((a, k) => results[k]!.outcome === "full" || named.includes(a.member));
      expect(losers).toHaveLength(1);
      const b = arrivals.findIndex((a) => a.user === "uB");
      if (losers[0]!.user === "uB") expect(results[b]!.outcome).toBe("full");
    }
  });

  it("C04 leaves no seat behind for a connection that left while its script was in flight", async () => {
    const i1 = build("i1");
    const i2 = build("i2");
    for (let round = 0; round < ROUNDS; round++) {
      ns = `t1034:${randomUUID()}`;
      const held = i1.w.hold("eval");
      const p = i1.reg.takeSeat(DOC, H(`r${round}s1`, "u1", 5000), 2);
      await held.executed;
      await i1.reg.unregister(DOC, `r${round}s1`);
      held.release();
      expect(await p).toEqual({ outcome: "gone" });
      expect(await i2.reg.count(DOC)).toBe(0);
    }
  });
});

/** One connection in the D01 model. */
interface ModelConn {
  user: string;
  inst: 0 | 1;
  socketId: string;
  member: string;
  arrivedAtMs: number;
  readOnly: boolean;
  closed: boolean;
}

/**
 * Two registries, the connections they hold and the wiring the hooks would
 * do with each answer: `full` and `lost` make a connection
 * read-only, `replaced(x)` queues a demote of x, `unknown` and `gone` change
 * nothing. Script replies are held until a command delivers them, in any
 * order; Redis still runs every script in the order it was sent.
 */
class World {
  readonly conns: ModelConn[] = [];
  readonly demotes: string[] = [];
  readonly replies: (() => void)[] = [];
  /** Rule breaks seen inside reply callbacks, asserted after every step. */
  readonly problems: string[] = [];
  readonly regs: [ConnectionRegistry, ConnectionRegistry];
  readonly ws: [WrappedRedis, WrappedRedis];
  readonly key: string;
  private next = 0;

  constructor(
    readonly cap: number,
    real: [Redis, Redis],
  ) {
    this.key = keyFor(DOC);
    this.ws = [wrapRedis(real[0]), wrapRedis(real[1])];
    this.regs = [0, 1].map((k) =>
      createConnectionRegistry({
        redis: this.ws[k]!.client,
        instanceId: `i${k + 1}`,
        pingIntervalMs: PING,
        seatExpiryMs: EXPIRY,
        now: () => clock,
        keyFor,
      }),
    ) as [ConnectionRegistry, ConnectionRegistry];
    for (const w of this.ws) {
      w.gateScripts((sent) => sent.then((reply) => new Promise((resolve) => this.replies.push(() => resolve(reply)))));
    }
  }

  /** @returns Connections that have not disconnected. */
  open(): ModelConn[] {
    return this.conns.filter((c) => !c.closed);
  }

  /**
   * The model connection a member belongs to.
   * @param member - A member string.
   * @returns The connection, if it is one of ours.
   */
  byMember(member: string): ModelConn | undefined {
    return this.conns.find((c) => c.member === member);
  }

  /**
   * Check a replacement against the takeover rule (invariant 4) and queue
   * the demote the hook would publish.
   * @param arriving - The member that took the seat.
   * @param replaced - The member it took it from.
   */
  checkReplaced(arriving: string, replaced: string): void {
    const a = this.byMember(arriving);
    const [user, at] = replaced.split(":");
    const earlier = Number(at) < (a?.arrivedAtMs ?? 0) || (Number(at) === a?.arrivedAtMs && replaced < arriving);
    if (!a || user !== a.user || !earlier) this.problems.push(`${arriving} replaced ${replaced}`);
    this.demotes.push(replaced);
  }

  /**
   * Act on a takeSeat answer the way the `connected` hook does.
   * @param conn - The arriving connection.
   * @param result - The answer.
   */
  onTake(conn: ModelConn, result: TakeResult): void {
    if (result.outcome === "full") conn.readOnly = true;
    if (result.outcome === "replaced") this.checkReplaced(conn.member, String(result.replaced));
  }

  /**
   * Act on a pong's answers the way the pong handler does. Every connection
   * has a socket of its own, so whatever the pong returns is about `conn`.
   * @param conn - The connection whose socket answered.
   * @param items - What refreshSocket returned.
   */
  onAlive(conn: ModelConn, items: RefreshItem[]): void {
    for (const item of items) {
      if (item.documentName !== DOC) {
        this.problems.push(`pong answered for unknown document ${item.documentName}`);
        continue;
      }
      if (item.outcome === "full" || item.outcome === "lost") conn.readOnly = true;
      if (item.outcome === "replaced") this.checkReplaced(conn.member, String(item.replaced));
    }
  }

  /** @returns Once every reply already delivered has been acted on. */
  async settle(): Promise<void> {
    await this.ws[0].flush();
    await this.ws[1].flush();
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    await this.ws[0].flush();
    await this.ws[1].flush();
  }

  /** @returns Once ZCARD has been checked against the cap (invariant 1). */
  async checkCard(): Promise<void> {
    expect(this.problems).toEqual([]);
    expect(await R.zcard(this.key)).toBeLessThanOrEqual(this.cap);
  }

  /**
   * A new connection arrives.
   * @param user - Who.
   * @param inst - On which instance.
   * @param at - When it entered the document.
   */
  arrive(user: string, inst: 0 | 1, at: number): void {
    const socketId = `d${this.next++}`;
    const conn: ModelConn = {
      user,
      inst,
      socketId,
      arrivedAtMs: at,
      member: m(user, at, `i${inst + 1}`, socketId),
      readOnly: false,
      closed: false,
    };
    this.conns.push(conn);
    void this.regs[inst].takeSeat(DOC, H(socketId, user, at), this.cap).then((r) => this.onTake(conn, r));
  }

  /**
   * A connection's socket answers a ping.
   * @param conn - The connection.
   */
  alive(conn: ModelConn): void {
    void this.regs[conn.inst].refreshSocket(conn.socketId).then((items) => this.onAlive(conn, items));
  }

  /**
   * Deliver a demote request the way seat-handover's subscriber does.
   * @param member - The member named.
   * @returns Once the seat has been let go.
   */
  async deliverDemote(member: string): Promise<void> {
    const conn = this.byMember(member);
    if (!conn || conn.closed) return;
    conn.readOnly = true;
    await this.regs[conn.inst].forgetSeat(DOC, member);
  }

  /** @returns Once every held reply and every queued demote has been delivered, faults off. */
  async drain(): Promise<void> {
    for (const w of this.ws) {
      w.clearRules();
      w.gateScripts(undefined);
    }
    while (this.replies.length > 0) {
      this.replies.shift()!();
      await this.settle();
    }
    while (this.demotes.length > 0) {
      await this.deliverDemote(this.demotes.shift()!);
      await this.settle();
    }
  }
}

type Cmd = fc.AsyncCommand<World, World>;

/**
 * A model command whose run is one function.
 * @param label - What it prints when shrunk.
 * @param run - The action.
 * @param check - When it may run.
 * @returns The command.
 */
function cmd(label: string, run: (w: World) => Promise<void> | void, check: (w: Readonly<World>) => boolean = () => true): Cmd {
  return {
    check,
    async run(_model: World, world: World): Promise<void> {
      await run(world);
      await world.settle();
      await world.checkCard();
    },
    toString: () => label,
  };
}

const commandArbs = [
  fc
    .record({ user: fc.integer({ min: 0, max: 2 }), inst: fc.constantFrom<0 | 1>(0, 1), at: fc.integer({ min: 1000, max: 1005 }) })
    .map(({ user, inst, at }) => cmd(`Arrive(u${user}, i${inst + 1}, ${at})`, (w) => w.arrive(`u${user}`, inst, at))),
  fc.nat().map((k) =>
    cmd(`Pong(${k})`, (w) => {
      const open = w.open();
      w.alive(open[k % open.length]!);
    }, (w) => w.conns.some((c) => !c.closed)),
  ),
  fc.nat().map((k) =>
    cmd(
      `Disconnect(${k})`,
      async (w) => {
        const open = w.open();
        const conn = open[k % open.length]!;
        conn.closed = true;
        await w.regs[conn.inst].unregister(DOC, conn.socketId);
      },
      (w) => w.conns.some((c) => !c.closed),
    ),
  ),
  fc.integer({ min: 1, max: 70_000 }).map((ms) =>
    cmd(`Advance(${ms})`, () => {
      clock += ms;
    }),
  ),
  fc.constantFrom<0 | 1>(0, 1).map((inst) =>
    cmd(`Prune(i${inst + 1})`, async (w) => {
      await w.regs[inst].count(DOC);
    }),
  ),
  fc.constant(
    cmd("KeyExpire", async (w) => {
      await R.del(w.key);
    }),
  ),
  fc
    .record({ inst: fc.constantFrom<0 | 1>(0, 1), kind: fc.constantFrom("reject-before-send" as const, "send-then-reject" as const) })
    .map(({ inst, kind }) => cmd(`FailNextEval(i${inst + 1}, ${kind})`, (w) => w.ws[inst].fail("eval", kind))),
  fc.nat().map((k) =>
    cmd(`DeliverReply(${k})`, (w) => {
      w.replies.splice(k % w.replies.length, 1)[0]!();
    }, (w) => w.replies.length > 0),
  ),
  fc.nat().map((k) =>
    cmd(`DeliverDemote(${k})`, async (w) => {
      await w.deliverDemote(w.demotes.splice(k % w.demotes.length, 1)[0]!);
    }, (w) => w.demotes.length > 0),
  ),
  fc.nat().map((k) =>
    cmd(`DropDemote(${k})`, (w) => {
      w.demotes.splice(k % w.demotes.length, 1);
    }, (w) => w.demotes.length > 0),
  ),
];

describe("D · any interleaving keeps the cap and leaves no stray seat", () => {
  let reals: [Redis, Redis];

  beforeAll(() => {
    reals = [
      createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-seat-d1" }),
      createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-seat-d2" }),
    ];
  });

  afterAll(async () => {
    await Promise.all(reals.map((c) => c.quit()));
  });

  it("D01 arrivals, pongs, disconnects, expiry, failures and late replies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(1, 2, 3), fc.commands(commandArbs, { maxCommands: 40 }), async (cap, cmds) => {
        ns = `t1034:${randomUUID()}`;
        clock = T;
        const world = new World(cap, reals);
        await fc.asyncModelRun(() => ({ model: world, real: world }), cmds);

        // Wind down: every reply delivered, no more faults, two rounds of
        // pongs with every demote they cause delivered.
        await world.drain();
        for (let round = 0; round < 2; round++) {
          for (const conn of world.open()) {
            world.alive(conn);
            await world.settle();
            await world.checkCard();
          }
          await world.drain();
        }

        const writable = world.open().filter((c) => !c.readOnly);
        const set = Object.keys(await members(DOC)).sort();
        expect(writable.length).toBeLessThanOrEqual(cap);
        for (const conn of writable) {
          const mark = world.ws[conn.inst].log.length;
          expect(await world.regs[conn.inst].refreshSocket(conn.socketId)).toEqual([]);
          expect(evalsOn(world.ws[conn.inst].log.slice(mark), world.key)).toHaveLength(1);
          expect(set).toContain(conn.member);
        }
        for (const conn of world.conns.filter((c) => c.readOnly || c.closed)) expect(set).not.toContain(conn.member);
        expect(set).toEqual(writable.map((c) => c.member).sort());
      }),
      { numRuns: 100, verbose: true },
    );
  });
});
