// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three bounded windows in which a writable content connection may hold
 * no seat (inner#1034 invariant 3), each closed within one pong:
 *
 *   1  between the handshake and the `arrive` reply
 *   2  after an `arrive` that Redis could not answer, until the next pong
 *   3  after being replaced, until the demote arrives or the next pong
 *
 * Real Redis, the real registry, the real pong handler and the real demote
 * channel. The connections are stand-ins carrying `readOnly` and a socket
 * whose `send` is recorded; pongs are fired by calling the handler directly.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { OutgoingMessage } from "@hocuspocus/server";

import { createRedisClient, initCore, type Redis } from "@breatic/core";
import { createConnectionRegistry, type ConnectionRegistry } from "@collab/services/connection-registry.js";
import { createSeatHandover, type SeatHandover } from "@collab/services/seat-handover.js";
import { createLivenessHandler } from "@collab/services/socket-liveness.js";

import { evalsOn, m, wrapRedis, type WrappedRedis } from "./helpers/seat-redis.js";

const PING = 30_000;
const EXPIRY = 60_000;
const T = 1_700_000_000_000;
const DOC = "doc";

/** A connection as the pong handler and the demote channel see it. */
interface FakeConn {
  readOnly: boolean;
  document: object;
  webSocket: { send: ReturnType<typeof vi.fn> };
}

type LiveSocketConnections = Parameters<ReturnType<typeof createLivenessHandler>>[1];

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
 * A fresh, writable connection stand-in.
 * @returns The connection.
 */
function conn(): FakeConn {
  return { readOnly: false, document: {}, webSocket: { send: vi.fn() } };
}

/** The frame that tells a client its connection is now read-only. */
const READ_ONLY_FRAME = new OutgoingMessage(DOC).writeAuthenticated(true).toUint8Array();

/** Everything one case wires together. */
interface Rig {
  reg: ConnectionRegistry;
  w: WrappedRedis;
  handover: SeatHandover;
  sockets: Map<string, Map<string, FakeConn>>;
  /** Fire a pong on a socket and wait until its consequences have landed. */
  alive(socketId: string): Promise<void>;
  /** Register a connection under its socket. */
  hold(socketId: string, c: FakeConn): FakeConn;
  /** How many connections are writable. */
  writable(): number;
}

/**
 * Wire a registry, a demote channel and the pong handler.
 * @param real - Whether the demote channel uses real pub/sub (else publishes go nowhere).
 * @returns The rig.
 */
async function rig(real = false): Promise<Rig> {
  const client = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-windows" });
  opened.push(client);
  const w = wrapRedis(client);
  const reg = createConnectionRegistry({
    redis: w.client,
    instanceId: "i1",
    pingIntervalMs: PING,
    seatExpiryMs: EXPIRY,
    now: () => clock,
    keyFor,
  });
  const sockets = new Map<string, Map<string, FakeConn>>();
  let publisher: Redis;
  let subscriber: Redis;
  if (real) {
    publisher = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-windows-pub" });
    subscriber = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-windows-sub" });
    opened.push(publisher, subscriber);
  } else {
    // The demote request is published and lost: nobody receives it.
    publisher = { publish: async (): Promise<number> => 0 } as unknown as Redis;
    subscriber = {
      on: (): unknown => subscriber,
      subscribe: async (): Promise<number> => 1,
      unsubscribe: async (): Promise<number> => 1,
    } as unknown as Redis;
  }
  const handover = createSeatHandover({
    channelPrefix: ns,
    publisher,
    subscriber,
    findConnection: (documentName, socketId) => sockets.get(socketId)?.get(documentName),
    forgetSeat: (documentName, member) => reg.forgetSeat(documentName, member),
  });
  if (real) await handover.start();
  const onAlive = createLivenessHandler({
    refreshSeats: (socketId: string, heardAt: number) => reg.refreshSocket(socketId, heardAt),
    requestDemote: (documentName: string, member: string) => handover.requestDemote(documentName, member),
    presencePolicy: { now: () => clock, staleAfterMs: 60_000 },
  });
  const all: FakeConn[] = [];
  return {
    reg,
    w,
    handover,
    sockets,
    async alive(socketId: string): Promise<void> {
      const carried: ReadonlyMap<string, unknown> = sockets.get(socketId) ?? new Map();
      onAlive(socketId, carried as LiveSocketConnections, clock);
      await w.flush();
      for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      await w.flush();
    },
    hold(socketId: string, c: FakeConn): FakeConn {
      const docs = sockets.get(socketId) ?? new Map<string, FakeConn>();
      docs.set(DOC, c);
      sockets.set(socketId, docs);
      all.push(c);
      return c;
    },
    writable(): number {
      return all.filter((c) => !c.readOnly).length;
    },
  };
}

beforeAll(() => {
  initCore(process.env);
  R = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-windows-raw" });
});

beforeEach(() => {
  ns = `t1034:${randomUUID()}`;
  clock = T;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.quit()));
});

afterAll(async () => {
  await R.quit();
});

describe("B · invariant 3: each window closes within one pong", () => {
  it("B01 window 1: no seat and still writable until the arrive reply, then the reply decides", async () => {
    const { reg, w, hold } = await rig();
    await R.zadd(keyFor(DOC), T, m("u2", 1000, "i2", "x2"));
    await R.zadd(keyFor(DOC), T, m("u3", 1000, "i2", "x3"));
    const c1 = hold("s1", conn());
    const held = w.hold("eval");
    let settled = false;
    const p = reg.takeSeat(DOC, { socketId: "s1", userId: "u1", arrivedAtMs: 5000 }, 2).finally(() => {
      settled = true;
    });
    await held.executed;
    await w.flush();

    expect(settled).toBe(false);
    expect(await R.zscore(keyFor(DOC), m("u1", 5000, "i1", "s1"))).toBeNull();
    expect(c1.readOnly).toBe(false);
    held.release();
    expect(await p).toEqual({ outcome: "full", liveCount: 2 });
  });

  it("B02 window 2: an arrival Redis could not answer is corrected on its next pong", async () => {
    const r = await rig();
    await r.reg.takeSeat(DOC, { socketId: "s2", userId: "u2", arrivedAtMs: 1000 }, 2);
    await r.reg.takeSeat(DOC, { socketId: "s3", userId: "u3", arrivedAtMs: 1000 }, 2);
    r.hold("s2", conn());
    r.hold("s3", conn());
    const c1 = r.hold("s1", conn());
    r.w.fail("eval", "reject-before-send");
    expect(await r.reg.takeSeat(DOC, { socketId: "s1", userId: "u1", arrivedAtMs: 5000 }, 2)).toEqual({ outcome: "unknown" });
    expect(r.writable()).toBe(3);

    await r.alive("s1");

    expect(c1.readOnly).toBe(true);
    expect(c1.webSocket.send).toHaveBeenCalledTimes(1);
    expect(c1.webSocket.send.mock.calls[0]![0]).toEqual(READ_ONLY_FRAME);
    expect(r.writable()).toBe(2);
    expect(await R.zscore(keyFor(DOC), m("u1", 5000, "i1", "s1"))).toBeNull();
  });

  it("B03 window 3: a replaced connection whose demote was lost goes read-only on its next pong", async () => {
    const r = await rig();
    const ca = r.hold("sa", conn());
    r.hold("sb", conn());
    await r.reg.takeSeat(DOC, { socketId: "sa", userId: "u1", arrivedAtMs: 1000 }, 2);
    await r.reg.takeSeat(DOC, { socketId: "sb", userId: "u2", arrivedAtMs: 1000 }, 2);
    const c9 = r.hold("s9", conn());
    const taken = await r.reg.takeSeat(DOC, { socketId: "s9", userId: "u1", arrivedAtMs: 5000 }, 2);
    expect(taken).toEqual({ outcome: "replaced", replaced: m("u1", 1000, "i1", "sa") });
    await r.handover.requestDemote(DOC, m("u1", 1000, "i1", "sa"));
    expect(ca.readOnly).toBe(false);
    expect(r.writable()).toBe(3);

    await r.alive("sa");

    expect(ca.readOnly).toBe(true);
    expect(ca.webSocket.send).toHaveBeenCalledTimes(1);
    expect(ca.webSocket.send.mock.calls[0]![0]).toEqual(READ_ONLY_FRAME);
    expect(r.writable()).toBe(2);
    const mark = r.w.log.length;
    await r.reg.refreshSocket("sa", clock);
    expect(evalsOn(r.w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
    expect(c9.readOnly).toBe(false);
  });

  it("B04 a delivered demote is the only demote: the next pong neither demotes again nor renews", async () => {
    const r = await rig(true);
    const ca = r.hold("sa", conn());
    r.hold("sb", conn());
    await r.reg.takeSeat(DOC, { socketId: "sa", userId: "u1", arrivedAtMs: 1000 }, 2);
    await r.reg.takeSeat(DOC, { socketId: "sb", userId: "u2", arrivedAtMs: 1000 }, 2);
    r.hold("s9", conn());
    const taken = await r.reg.takeSeat(DOC, { socketId: "s9", userId: "u1", arrivedAtMs: 5000 }, 2);
    expect(taken).toEqual({ outcome: "replaced", replaced: m("u1", 1000, "i1", "sa") });

    await r.handover.requestDemote(DOC, m("u1", 1000, "i1", "sa"));
    await vi.waitFor(() => expect(ca.readOnly).toBe(true));
    await r.w.flush();

    const mark = r.w.log.length;
    await r.alive("sa");

    expect(ca.webSocket.send).toHaveBeenCalledTimes(1);
    expect(evalsOn(r.w.log.slice(mark), keyFor(DOC))).toHaveLength(0);
    const set = await R.zrange(keyFor(DOC), 0, -1);
    expect(set.sort()).toEqual([m("u1", 5000, "i1", "s9"), m("u2", 1000, "i1", "sb")].sort());
    await r.handover.stop();
  });
});
