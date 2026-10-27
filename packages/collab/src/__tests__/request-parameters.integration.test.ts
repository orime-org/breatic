// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The request parameters a real upgrade produces, end to end through crossws.
 *
 * `socket-ceilings.test.ts` pins the per-request parse on a stub request. This
 * file checks the assumption that makes the patch work at all: crossws hands
 * every hook on one connection the same request object, so the parse cached
 * on it is shared (inner#1589). The upgrade is written by hand over
 * `node:http` because the `ws` client would encode the `"` in a path and
 * would not send a `Host` carrying `?` as it stands.
 */

import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import { Server } from "@hocuspocus/server";
import { SOCKET_CEILINGS } from "@collab/infra/socket-ceilings.js";
import { authFrame, waitFor } from "./helpers/live-hocuspocus.js";

/** One `onAuthenticate` call as the server saw it. */
type Seen = { documentName: string; request: unknown; params: URLSearchParams };

let running: Server | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await running?.destroy();
  running = undefined;
});

/**
 * Start a server whose authentication records what it is handed and never
 * settles, so each document stays pending.
 * @param seen - Where calls are recorded.
 * @returns The port it listens on.
 */
async function holdingServer(seen: Seen[]): Promise<number> {
  const server = new Server({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    timeout: 60_000,
    ...SOCKET_CEILINGS,
    onAuthenticate: (data: { documentName: string; request: unknown; requestParameters: URLSearchParams }) => {
      seen.push({ documentName: data.documentName, request: data.request, params: data.requestParameters });
      return new Promise<never>(() => {});
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  running = server;
  await server.listen();
  return server.address.port;
}

/**
 * Open a WebSocket by hand, with the request target and `Host` exactly as given.
 * @param port - The server's port.
 * @param path - The request target.
 * @param host - The `Host` header.
 * @returns The upgraded socket.
 * @throws {Error} When the server answers with a status instead of upgrading.
 */
function upgrade(port: number, path: string, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Host: host,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
    });
    request.on("upgrade", (_response, socket: Socket) => {
      socket.on("data", () => {});
      sockets.push(socket);
      resolve(socket);
    });
    request.on("response", (response) => reject(new Error(`status ${response.statusCode}`)));
    request.on("error", reject);
    request.end();
  });
}

/**
 * Wrap a payload in a masked binary WebSocket frame, as a client must send it.
 * @param payload - The bytes to send.
 * @returns The frame.
 */
function clientFrame(payload: Uint8Array): Buffer {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, masked]);
}

/**
 * The upstream parse, what every result must still equal.
 * @param url - The URL crossws builds.
 * @returns A fresh parse.
 */
function oracle(url: string): Array<[string, string]> {
  return [...new URL(url).searchParams.entries()];
}

describe("request parameters through a real upgrade", () => {
  it.each([
    ["a query string", "/ws?a=1&b=2", undefined, [["a", "1"], ["b", "2"]]],
    ["a query in Host", "/ws", "a?k=1", [["k", "1/ws"]]],
    ["a path the URL parser rewrites", `/ws/${'"'.repeat(50)}`, undefined, []],
    ["an upper-case Host", "/ws", "A".repeat(50), []],
    ["the plain production URL", "/ws", undefined, []],
  ])("hands both pending documents one request and one parse for %s", async (_label, path, hostOverride, expected) => {
    const seen: Seen[] = [];
    const port = await holdingServer(seen);
    const host = hostOverride ?? `127.0.0.1:${port}`;
    const socket = await upgrade(port, path, host);

    socket.write(clientFrame(authFrame("i01-a", "t")));
    socket.write(clientFrame(authFrame("i01-b", "t")));
    await waitFor(() => seen.length === 2, "two authentications");

    expect(seen[1]?.request).toBe(seen[0]?.request);
    expect(seen[1]?.params).toBe(seen[0]?.params);
    expect([...seen[0]!.params.entries()]).toEqual(expected);
    expect([...seen[0]!.params.entries()]).toEqual(oracle(`http://${host}${path}`));
  });

  it("gives two real connections with the same target and Host a parse each", async () => {
    const seen: Seen[] = [];
    const port = await holdingServer(seen);
    const one = await upgrade(port, "/ws?a=1&b=2", `127.0.0.1:${port}`);
    const other = await upgrade(port, "/ws?a=1&b=2", `127.0.0.1:${port}`);

    one.write(clientFrame(authFrame("i02-1", "t")));
    other.write(clientFrame(authFrame("i02-2", "t")));
    await waitFor(() => seen.length === 2, "one authentication per connection");

    expect(seen[1]?.params).not.toBe(seen[0]?.params);
    expect([...seen[0]!.params.entries()]).toEqual([["a", "1"], ["b", "2"]]);
    expect([...seen[1]!.params.entries()]).toEqual([["a", "1"], ["b", "2"]]);
  });
});
