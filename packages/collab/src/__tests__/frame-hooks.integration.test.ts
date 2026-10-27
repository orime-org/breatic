// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three crossws hooks our Hocuspocus patch exposes (inner#1585), through
 * a real `Server` on loopback: `receiveFrame` decides what reaches
 * Hocuspocus, `onPeerClose` runs before Hocuspocus handles the close, and
 * `onPeerError` takes over ws errors. Unset, the server behaves as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import { SOCKET_CEILINGS } from "@collab/infra/socket-ceilings.js";
import { authFrame, statelessFrame, waitFor } from "./helpers/live-hocuspocus.js";

let running: Server | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await running?.destroy();
  running = undefined;
  vi.restoreAllMocks();
});

/**
 * Start a real server on loopback that admits every document.
 * @param extra - Extra server options (the patched hooks, extensions, ws options).
 * @returns The port.
 */
async function serve(extra: Record<string, unknown>): Promise<number> {
  const server = new Server({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    timeout: 60_000,
    ...SOCKET_CEILINGS,
    onAuthenticate: async () => ({ user: { id: "member-a" } }),
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return server.address.port;
}

/**
 * Open a ws client and wait until it is open.
 * @param port - Server port.
 * @returns The client and the close code it later receives.
 */
async function connect(port: number): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  clients.push(ws);
  ws.on("error", () => {});
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, closed };
}

/**
 * A stateless frame whose total length is exactly n bytes.
 * @param doc - Document name.
 * @param n - Total frame length.
 * @returns The frame.
 */
function statelessOfSize(doc: string, n: number): Uint8Array {
  let k = Math.max(0, n - 32);
  for (;;) {
    const f = statelessFrame(doc, "x".repeat(k));
    if (f.byteLength === n) return f;
    k += n - f.byteLength;
  }
}

/**
 * Authenticate a document and wait until the server has accepted it.
 * @param ws - Client.
 * @param doc - Document name.
 * @param seen - Documents the server has authenticated so far.
 */
async function authenticate(ws: WebSocket, doc: string, seen: string[]): Promise<void> {
  ws.send(authFrame(doc, "t"));
  await waitFor(() => seen.includes(doc), `auth of ${doc}`);
}

describe("patched crossws hooks", () => {
  it("IP01 without the hooks the server behaves as before, with no frame cap of ours", async () => {
    const authed: string[] = [];
    const stateless: string[] = [];
    const consoleError = vi.spyOn(console, "error");
    const port = await serve({
      connected: async ({ documentName }: { documentName: string }) => { authed.push(documentName); },
      onStateless: async ({ payload }: { payload: string }) => { stateless.push(payload); },
    });
    const { ws } = await connect(port);
    await authenticate(ws, "ip01", authed);
    ws.send(statelessOfSize("ip01", 2_048));
    ws.send(statelessOfSize("ip01", 200_000));
    await waitFor(() => stateless.length === 2, "two stateless frames");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("IP02 hands Hocuspocus whatever receiveFrame returns, and nothing for undefined", async () => {
    const authed: string[] = [];
    const stateless: string[] = [];
    const markerA = new Uint8Array([0xa1, 0xa1, 0xa1, 0xa1]);
    const markerB = new Uint8Array([0xb2, 0xb2, 0xb2, 0xb2]);
    const replacement = statelessOfSize("ip02", 100);
    const received: Uint8Array[] = [];
    const port = await serve({
      connected: async ({ documentName }: { documentName: string }) => { authed.push(documentName); },
      onStateless: async ({ payload }: { payload: string }) => { stateless.push(payload); },
      receiveFrame: (_peer: unknown, message: { uint8Array: () => Uint8Array }) => {
        const bytes = message.uint8Array();
        received.push(bytes);
        if (Buffer.from(bytes).equals(Buffer.from(markerA))) return replacement;
        if (Buffer.from(bytes).equals(Buffer.from(markerB))) return undefined;
        return bytes;
      },
    });
    const { ws } = await connect(port);
    await authenticate(ws, "ip02", authed);
    ws.send(markerA);
    await waitFor(() => stateless.length === 1, "replacement reached Hocuspocus");
    ws.send(markerB);
    ws.send(statelessOfSize("ip02", 64));
    await waitFor(() => stateless.length === 2, "the frame after the swallowed one");
    expect(stateless[0]).toBe("x".repeat(stateless[0]!.length));
    expect(received.some((b) => Buffer.from(b).equals(Buffer.from(markerB)))).toBe(true);
  });

  it("IP03 calls onPeerClose before Hocuspocus handles the close", async () => {
    const authed: string[] = [];
    const order: string[] = [];
    let code: number | undefined;
    const port = await serve({
      connected: async ({ documentName }: { documentName: string }) => { authed.push(documentName); },
      onDisconnect: async () => { order.push("onDisconnect"); },
      onPeerClose: (_peer: unknown, event: { code?: number }) => { order.push("onPeerClose"); code = event.code; },
    });
    const { ws } = await connect(port);
    await authenticate(ws, "ip03", authed);
    ws.close(4000);
    await waitFor(() => order.length === 2, "both close handlers");
    expect(order).toEqual(["onPeerClose", "onDisconnect"]);
    expect(code).toBe(4000);
  });

  it("IP04 routes a ws error to onPeerError in place of console.error", async () => {
    const errors: Array<{ name: string; message: string }> = [];
    const consoleError = vi.spyOn(console, "error");
    const port = await serve({
      websocketOptions: { maxPayload: 131_072 },
      onPeerError: (_peer: unknown, error: { name: string; message: string }) => { errors.push(error); },
    });
    const { ws, closed } = await connect(port);
    ws.send(new Uint8Array(131_073));
    expect(await closed).toBe(1009);
    await waitFor(() => errors.length === 1, "onPeerError");
    expect(errors[0]!.name).toBe("WSError");
    expect(errors[0]!.message).toContain("Max payload size exceeded");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("IP05 hands the hooks the peer that carries the upgrade request and the socket id", async () => {
    const authed: string[] = [];
    let request: IncomingMessage | undefined;
    let socketId: string | undefined;
    let peer: { _internal?: { nodeReq?: unknown }; _hocuspocus?: { socketId?: string }; remoteAddress?: string } | undefined;
    const port = await serve({
      extensions: [{ onUpgrade: async (data: { request: IncomingMessage }) => { request = data.request; } }],
      onConnect: async (data: { socketId: string }) => { socketId = data.socketId; },
      connected: async ({ documentName }: { documentName: string }) => { authed.push(documentName); },
      receiveFrame: (p: typeof peer, message: { uint8Array: () => Uint8Array }) => { peer = p; return message.uint8Array(); },
    });
    const { ws } = await connect(port);
    await authenticate(ws, "ip05", authed);
    expect(peer?._internal?.nodeReq).toBe(request);
    expect(peer?._hocuspocus?.socketId).toBe(socketId);
    expect(peer?.remoteAddress).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });
});
