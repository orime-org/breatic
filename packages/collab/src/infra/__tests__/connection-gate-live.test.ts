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
 * A local socket's peer is always loopback, so only the exempt branch is
 * reachable here. The refusal branch is covered by the unit tests, which can
 * hand the gate any peer address they like.
 */

import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import { Server } from "@hocuspocus/server";
import { createConnectionGate } from "@collab/infra/connection-gate.js";
import { isLoopbackIp } from "@collab/infra/client-identity.js";

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
    quiet: true,
    extensions: [
      createConnectionGate({ throttle: 1000, banTime: 1 }),
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
