// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The connection gate against a real listening server, driven by a real
 * WebSocket client.
 *
 * The unit tests next door exercise the gate's own logic. This one pins the
 * part the gate cannot own: that a header rewritten during the upgrade is
 * still there when the connection hooks run. That chain is three components
 * deep — hocuspocus runs the upgrade hooks, hands the node request to crossws,
 * and crossws builds the standard Request from that request's headers — and it
 * is the whole reason the gate is allowed to decide during the upgrade at all.
 *
 * The offline probe that first measured this rebuilt crossws's two lines by
 * hand, because the class they live in is not exported. This test removes that
 * caveat by running the real thing end to end.
 *
 * A real client is needed because `onConnect` is a per-document hook: it does
 * not fire on the bare upgrade, only once the client names a document. Hence
 * the handshake and the first frame.
 *
 * A socket to 127.0.0.1 has a loopback peer, so it only reaches the exempt
 * branch. The counting branch is reached by connecting to this machine's own
 * non-loopback address, whose peer is that address.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { connect as connectTcp } from "node:net";
import { networkInterfaces } from "node:os";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import { Server } from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import { createConnectionGate, recordingFailedAuth } from "@collab/infra/connection-gate.js";
import { isLoopbackIp } from "@breatic/core";

// The gate logs its refusals; this file runs without initCore, so the logger
// is a stand-in and everything else is the real module.
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** Outer message type of an auth frame, as it appears on the wire. */
const WIRE_AUTH = 2;

/** Sub-type of the auth frame a client opens a document with. */
const AUTH_SUB_TOKEN = 0;

let running: Server | undefined;

afterEach(async () => {
  await running?.destroy();
  running = undefined;
});

/** The first frame a client sends, which is what makes onConnect fire. */
function authFrame(docName: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docName);
  encoding.writeVarUint(encoder, WIRE_AUTH);
  encoding.writeVarUint(encoder, AUTH_SUB_TOKEN);
  encoding.writeVarString(encoder, "__cookie_auth__");
  return encoding.toUint8Array(encoder);
}

/**
 * Start a server whose only job is to record one header as the connect hook
 * sees it, with the gate installed ahead of the recorder.
 */
async function serverRecording(
  header: string,
): Promise<{ port: number; seen: (string | null)[] }> {
  const seen: (string | null)[] = [];
  const server = new Server({
    port: 0,
    // Bound to the address the case connects to: a port the OS hands out for
    // every interface can be held on 127.0.0.1 by another local server, which
    // then takes the connection and answers 404.
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    extensions: [
      createConnectionGate({ count: async () => true, isBanned: async () => false }),
      {
        // Runs after the gate on the same hook, so it observes exactly what
        // the rest of the connection path will see.
        onConnect: async (data: { requestHeaders: Headers }) => {
          seen.push(data.requestHeaders.get(header));
        },
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return { port: server.address.port, seen };
}

/** Connect, send the opening frame, and give the hooks a turn to run. */
async function openDocument(
  port: number,
  headers: Record<string, string> = {},
): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  socket.send(authFrame("project-live/meta"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  socket.close();
}

describe("connection gate on a live server", () => {
  it("carries the identity it wrote during the upgrade into the connect hook", async () => {
    const { port, seen } = await serverRecording("x-real-ip");

    // Nothing named x-real-ip goes out on the wire, so whatever the connect
    // hook reads can only have been written during the upgrade.
    await openDocument(port);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
    expect(isLoopbackIp(seen[0] as string)).toBe(true);
  });

  it("overwrites an x-real-ip the client supplied itself", async () => {
    const { port, seen } = await serverRecording("x-real-ip");

    await openDocument(port, { "x-real-ip": "9.9.9.9" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe("9.9.9.9");
    expect(isLoopbackIp(seen[0] as string)).toBe(true);
  });

  it("overwrites a verdict a client tried to award itself", async () => {
    // The verdict header decides whether a connection is counted at all, so a
    // client able to set it would exempt itself. A local socket's peer is
    // loopback, which the gate answers "exempt" — so the client sends the
    // OPPOSITE value here. Anything but "exempt" arriving would mean the
    // client's own string survived.
    const { port, seen } = await serverRecording("x-breatic-connection-verdict");

    await openDocument(port, { "x-breatic-connection-verdict": "count" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("exempt");
  });

  it("strips x-forwarded-for before anything downstream can read it", async () => {
    const { port, seen } = await serverRecording("x-forwarded-for");

    await openDocument(port, { "x-forwarded-for": "1.2.3.4" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeNull();
  });
});

/**
 * An address of this machine that is not loopback, so a connection to it has
 * a non-loopback peer and reaches the gate's counting branch.
 * @returns The address.
 * @throws {Error} When the machine has no such address.
 */
function lanAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  throw new Error("this machine has no non-loopback IPv4 address to connect through");
}

/**
 * Start a server listening on every interface with the given throttle.
 * @param throttle - The throttle the gate counts with.
 * @returns The port.
 */
async function serverCounting(
  throttle: {
    count: (identity: string) => Promise<boolean>;
    isBanned: (identity: string) => Promise<boolean>;
  },
  rejectAuth = false,
): Promise<number> {
  const gate = createConnectionGate(throttle);
  const server = new Server({
    port: 0,
    address: "0.0.0.0",
    quiet: true,
    stopOnSignals: false,
    extensions: [gate],
    ...(rejectAuth
      ? {
          onAuthenticate: recordingFailedAuth(async () => {
            throw new Error("session_not_found");
          }, gate),
        }
      : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return server.address.port;
}

describe("connection gate counting on a live server", () => {
  it("counts a WebSocket and its failed authentication once, however many documents fail", async () => {
    // Pins what the failure tally relies on: hocuspocus hands every document
    // on one socket the same request object.
    const host = lanAddress();
    const count = vi.fn(async () => true);
    const port = await serverCounting({ count, isBanned: async () => false }, true);

    const socket = new WebSocket(`ws://${host}:${port}/`, { headers: { "x-real-ip": "203.0.113.9" } });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    for (const doc of ["project-live/meta", "project-live/canvas-a", "project-live/canvas-b"]) {
      socket.send(authFrame(doc));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.close();

    expect(count).toHaveBeenCalledTimes(2);
  });

  it("answers 429 and releases the socket for an address over the limit", async () => {
    const host = lanAddress();
    const port = await serverCounting({ count: async () => false, isBanned: async () => false });

    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://${host}:${port}/`, { headers: { "x-real-ip": "203.0.113.9" } });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.on("open", () => reject(new Error("the upgrade went through")));
      socket.on("error", () => undefined);
    });

    expect(status).toBe(429);
  });

  it("survives a client that resets the connection while the count is pending", async () => {
    const host = lanAddress();
    let release!: () => void;
    const counting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = await serverCounting({
      count: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        return true;
      },
      isBanned: async () => false,
    });

    const raw = connectTcp({ host, port });
    await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
    raw.write(
      [
        "GET / HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "x-real-ip: 203.0.113.9",
        "",
        "",
      ].join("\r\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    raw.resetAndDestroy();
    await counting;
    // Give the reset error a turn to surface; an unhandled one fails the run.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(raw.destroyed).toBe(true);
  });
});
