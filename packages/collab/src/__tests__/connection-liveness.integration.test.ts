// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transport facts the seat and presence expiries are built on: how often
 * crossws pings, and that a socket it keeps open on messages alone keeps its
 * seat. It is somebody else's behaviour, so it is measured against a
 * real server over a real socket rather than reasoned about.
 *
 * This takes real seconds. There is no way around it: what is being checked
 * is how long a library waits, and a fake clock would only confirm that we
 * read the same constant it did.
 *
 * A note on which bundle runs. `@hocuspocus/server` ships two: the CJS one
 * inlines crossws 0.4.4, which has no liveness at all, and the ESM one
 * imports crossws from node_modules, which is 0.4.10 and does the sweep.
 * collab is ESM, so production gets the second. This fails outright if
 * anything ever resolves the other one — no pong would arrive.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";

import { createRedisClient, initCore } from "@breatic/core";
import { getCollabConfig } from "@collab/config";
import { createConnectionRegistry } from "@collab/services/connection-registry.js";
import {
  createLiveConnections,
  type HeldConnection,
} from "@collab/services/live-connections.js";

const WIRE_AUTH = 2;
const AUTH_SUB_TOKEN = 0;
const WIRE_QUERY_AWARENESS = 3;

/**
 * The frame a client opens with, carrying the document it wants.
 * @param docName - Document to open.
 * @param token - Auth token; this server accepts anything.
 * @returns The encoded frame.
 */
function authFrame(docName: string, token: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, docName);
  encoding.writeVarUint(e, WIRE_AUTH);
  encoding.writeVarUint(e, AUTH_SUB_TOKEN);
  encoding.writeVarString(e, token);
  return encoding.toUint8Array(e);
}

/**
 * A frame that asks for the document's awareness: harmless, and a message.
 * @param docName - Document it is for.
 * @returns The encoded frame.
 */
function queryAwarenessFrame(docName: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, docName);
  encoding.writeVarUint(e, WIRE_QUERY_AWARENESS);
  return encoding.toUint8Array(e);
}

let teardown: (() => void)[] = [];

afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

describe("crossws liveness", () => {
  it("pings every connection at the interval the config declares", async () => {
    // The seat and presence expiries are both this interval doubled, so a
    // library upgrade that changed it would silently make both wrong: one
    // ping period would stop being an "a beat was missed" margin and start
    // being a whole missed cycle.
    const declared = getCollabConfig().connection_ping_interval_ms;
    // Guard rather than assume: every duration below is derived from this,
    // and an absent key turns them all into NaN, which setTimeout quietly
    // rewrites to 1ms — the whole test would then pass through in
    // milliseconds and say nothing.
    expect(declared).toBeGreaterThan(0);
    const pongs: number[] = [];
    const t0 = Date.now();

    const server = new Server({
      port: 0,
      // Bound to the address the case connects to: a port the OS hands out for
      // every interface can be held on 127.0.0.1 by another local server, which
      // then takes the connection and answers 404.
      address: "127.0.0.1",
      quiet: true,
      stopOnSignals: false,
      // Take this server's OWN liveness check out of the picture: hocuspocus
      // closes a connection that has sent no DATA frame for `timeout`, and a
      // client that only answers pings sends none, so at the default 60s it
      // would end this measurement partway through. This is about crossws.
      timeout: 3_600_000,
      onAuthenticate: async () => ({ user: { id: "probe" } }),
      connected: async ({ connection }: { connection: unknown }) => {
        // crossws swallows its own heartbeat pong before dispatching its
        // `pong` hook, but that `return` leaves only crossws's handler —
        // every other listener on the same emitter still fires. That is what
        // makes the client's answer usable as the seat's refresh signal, with
        // no timer of ours and no extra frames on the wire.
        const raw = (connection as { webSocket: WebSocket }).webSocket;
        raw.on("pong", () => pongs.push(Date.now() - t0));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await server.listen();
    teardown.push(() => server.destroy());
    const address = (
      server as unknown as { httpServer: { address(): { port: number } } }
    ).httpServer.address();

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/`);
    teardown.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(authFrame("ping-interval-doc", "__probe__"));

    // Two beats, plus enough slack that a loaded machine does not decide it.
    await new Promise((r) => setTimeout(r, declared * 2 + 5_000));

    expect(pongs.length).toBeGreaterThanOrEqual(2);
    const gaps = pongs.slice(1).map((at, i) => at - pongs[i]!);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(declared * 0.8);
      expect(gap).toBeLessThan(declared * 1.2);
    }
  }, 90_000);
});

describe("seat liveness follows the transport's", () => {
  it("keeps the seat of a socket on its messages alone", async () => {
    // Messages alone must refresh the seat within one seat expiry: crossws
    // counts any message as a sign of life, and a seat that expired under a
    // socket it keeps open would let a newcomer exceed the cap.
    initCore(process.env);
    const redis = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-liveness-seat" });
    teardown.push(() => void redis.quit());
    const ns = `t1034-liveness:${randomUUID()}`;
    const doc = "seat-doc";
    // Far shorter than the transport's own ping interval, so no ping reaches
    // the socket while this runs and only its messages can refresh the seat
    // before it expires.
    const registry = createConnectionRegistry({
      redis,
      instanceId: "i-1",
      pingIntervalMs: 200,
      seatExpiryMs: 400,
      keyFor: (documentName: string) => `${ns}:${documentName}`,
    });
    const live = createLiveConnections({
      onAlive: (socketId: string, _held: unknown, heardAt: number) => void registry.refreshSocket(socketId, heardAt),
      pingIntervalMs: 200,
    });

    const server = new Server({
      port: 0,
      address: "127.0.0.1",
      quiet: true,
      stopOnSignals: false,
      timeout: 3_600_000,
      onAuthenticate: async () => ({ user: { id: "probe" } }),
      connected: async ({ connection, socketId, documentName }: {
        connection: unknown;
        socketId: string;
        documentName: string;
      }) => {
        live.remember(socketId, documentName, connection as HeldConnection);
        await registry.takeSeat(documentName, { socketId, userId: "u-1", arrivedAtMs: Date.now() }, 1);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await server.listen();
    teardown.push(() => server.destroy());
    const address = (
      server as unknown as { httpServer: { address(): { port: number } } }
    ).httpServer.address();

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/`);
    teardown.push(() => ws.terminate());
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(authFrame(doc, "__probe__"));
    await expect.poll(() => registry.count(doc)).toBe(1);

    // Five seat expiries of messages and nothing else.
    const sending = setInterval(() => ws.send(queryAwarenessFrame(doc)), 100);
    teardown.push(() => clearInterval(sending));
    await new Promise((r) => setTimeout(r, 2_000));

    expect(await registry.count(doc)).toBe(1);
    const newcomer = await registry.takeSeat(doc, { socketId: "s-2", userId: "u-2", arrivedAtMs: Date.now() }, 1);
    expect(newcomer.outcome).toBe("full");
  }, 30_000);
});
