// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two facts about the transport that the seat and presence expiries are
 * built on. Both are somebody else's behaviour, so both are measured against
 * a real server over a real socket rather than reasoned about.
 *
 * These take real seconds. There is no way around it: what is being checked
 * is how long a library waits, and a fake clock would only confirm that we
 * read the same constant it did.
 *
 * A note on which bundle runs. `@hocuspocus/server` ships two: the CJS one
 * inlines crossws 0.4.4, which has no liveness at all, and the ESM one
 * imports crossws from node_modules, which is 0.4.10 and does the sweep.
 * collab is ESM, so production gets the second. The first test here fails
 * outright if anything ever resolves the other one — no pong would arrive.
 */

import { describe, it, expect, afterEach } from "vitest";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";

import { getCollabConfig } from "@collab/config";

const WIRE_AUTH = 2;
const AUTH_SUB_TOKEN = 0;

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

let teardown: (() => void)[] = [];

afterEach(() => {
  for (const fn of teardown.reverse()) fn();
  teardown = [];
});

describe("what the transport does on its own", () => {
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
      quiet: true,
      // Take this server's OWN liveness check out of the picture — see the
      // second test for what it does. This one is about crossws.
      timeout: 3_600_000,
      onAuthenticate: async () => ({ user: { id: "probe" } }),
      connected: async ({ connection }) => {
        // crossws swallows its own heartbeat pong before dispatching its
        // `pong` hook, but that `return` leaves only crossws's handler —
        // every other listener on the same emitter still fires. That is what
        // makes the client's answer usable as the seat's refresh signal, with
        // no timer of ours and no extra frames on the wire.
        const raw = (connection as unknown as { webSocket: WebSocket })
          .webSocket;
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
    const gaps = pongs.slice(1).map((at, i) => at - pongs[i]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThan(declared * 0.8);
      expect(gap).toBeLessThan(declared * 1.2);
    }
  }, 90_000);

  it("keeps a connection that answers pings but sends no data frames", async () => {
    // Hocuspocus runs a SECOND liveness check of its own, and it asks a
    // different question: `ClientConnection.check` compares now against
    // `lastMessageReceivedAt`, which only `handleMessage` sets — inbound DATA
    // frames. A protocol pong never touches it.
    //
    // That is precisely the judgement this task moves away from. A tab hidden
    // for more than five minutes has its JavaScript timers throttled to about
    // once a minute, so the awareness frame that happens to feed this clock
    // arrives at roughly the same rate as the library's default ceiling. The
    // connection is alive the whole time — its network stack is answering
    // every ping — and gets terminated for being quiet.
    const declared = getCollabConfig().connection_ping_interval_ms;
    expect(declared).toBeGreaterThan(0);
    const disconnects: string[] = [];

    const server = new Server({
      port: 0,
      quiet: true,
      onAuthenticate: async () => ({ user: { id: "probe" } }),
      onDisconnect: async ({ socketId }) => {
        disconnects.push(socketId);
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
    ws.send(authFrame("silent-client-doc", "__probe__"));

    // Past two ping periods with not one data frame sent. The library's own
    // default would have terminated this socket by now.
    await new Promise((r) => setTimeout(r, declared * 2 + 10_000));

    expect(disconnects).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  }, 120_000);
});
