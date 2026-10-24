// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage as HttpIncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, connect, type Socket, type Server as TcpServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi, type Mock, type MockInstance } from "vitest";
import { Server } from "@hocuspocus/server";
import WebSocket from "ws";
import * as encoding from "lib0/encoding";
import {
  createRedisClient,
  env,
  initCore,
  initLogger,
  revokeSession,
  sessionCookieName,
  setSession,
  type Redis,
} from "@breatic/core";
import { createConnectionGate } from "@collab/infra/connection-gate.js";
import { createUpgradeSessionGate } from "@collab/infra/upgrade-session-gate.js";

/** The native stream facts observed independently of the gate's state. */
interface ObservedSocket {
  socket: Socket;
  closed: boolean;
  errorListeners: number;
  endListeners: number;
}

/** A listening native Hocuspocus server and its production admission hook. */
interface RunningServer {
  server: Server;
  gate: ReturnType<typeof createUpgradeSessionGate>;
  port: number;
  rawSockets: ObservedSocket[];
  allocations: MockInstance<Server["hocuspocus"]["handleConnection"]>;
  authenticate: Mock<() => Promise<{ user: { id: string } }>>;
  failures: Mock<(request: HttpIncomingMessage) => Promise<void>>;
}

/** A real Redis transport whose incoming replies can be delayed deterministically. */
interface RedisTransport {
  client: Redis;
  server: TcpServer;
  sockets: Set<Socket>;
  upstreams: Set<Socket>;
}

const running: RunningServer[] = [];
const clients: WebSocket[] = [];
const redisClients: Redis[] = [];
const transports: RedisTransport[] = [];
const keys: { redis: Redis; key: string }[] = [];
const logsRoot = mkdtempSync(join(tmpdir(), "upgrade-session-logs-"));

beforeAll(() => {
  initCore(process.env);
  initLogger("upgrade-session-test", { logsRoot, debug: true, console: "none" });
});

afterAll(() => {
  rmSync(logsRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const transport of transports) {
    for (const upstream of transport.upstreams) upstream.resume();
  }
  for (const client of clients.splice(0)) client.terminate();
  for (const active of running.splice(0)) {
    active.gate.stop();
    for (const observed of active.rawSockets) observed.socket.destroy();
    await active.server.destroy();
  }
  const deletions = await Promise.allSettled(keys.splice(0).map(({ redis, key }) => redis.del(key)));
  for (const redis of redisClients.splice(0)) redis.disconnect();
  for (const transport of transports.splice(0)) {
    transport.client.disconnect();
    for (const socket of transport.sockets) socket.destroy();
    for (const socket of transport.upstreams) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      transport.server.close((error) => error ? reject(error) : resolve());
    });
  }
  vi.restoreAllMocks();
  const failedDeletion = deletions.find((result) => result.status === "rejected");
  if (failedDeletion?.status === "rejected") throw failedDeletion.reason;
});

/**
 * Open an isolated session client against the shared container.
 * @returns The connected, test-owned client.
 * @throws {Error} When Redis cannot be reached.
 */
async function sessionClient(): Promise<Redis> {
  const redis = createRedisClient(inject("REDIS_URL"), {
    name: "upgrade-session-integration",
    keyPrefix: `upgrade-${randomUUID()}:`,
  });
  redisClients.push(redis);
  await redis.ping();
  return redis;
}

/**
 * Save a real session and its cleanup key.
 * @param redis - The session database client.
 * @returns Its opaque token.
 * @throws {Error} When Redis cannot write the session.
 */
async function session(redis: Redis): Promise<string> {
  const token = `private-${randomUUID()}`;
  await setSession(redis, token, "11111111-1111-4111-8111-111111111111");
  keys.push({ redis, key: `${env.ENV}:session:${token}` });
  return token;
}

/**
 * Listen with the real library's native upgrade chain.
 * @param redis - The actual Redis session client.
 * @param throttleEnabled - Whether the existing optional source gate is installed.
 * @returns The server and independent allocation observations.
 * @throws {Error} When the OS cannot bind a loopback listener.
 */
async function listen(redis: Redis, throttleEnabled = false): Promise<RunningServer> {
  const connectionGate = throttleEnabled
    ? createConnectionGate({ count: async () => true, isBanned: async () => false })
    : null;
  const failures = vi.fn(async (request: HttpIncomingMessage): Promise<void> => {
    await connectionGate?.recordFailedUpgrade(request);
  });
  const gate = createUpgradeSessionGate({ redis, recordFailedUpgrade: failures });
  const rawSockets: ObservedSocket[] = [];
  const authenticate = vi.fn(async () => ({ user: { id: "member-a" } }));
  const server = new Server({
    address: "127.0.0.1",
    port: 0,
    quiet: true,
    timeout: 1_000,
    extensions: [
      {
        onUpgrade: async ({ socket }): Promise<void> => {
          const raw = socket as Socket;
          const observed: ObservedSocket = {
            socket: raw,
            closed: false,
            errorListeners: raw.listenerCount("error"),
            endListeners: raw.listenerCount("end"),
          };
          raw.once("close", () => { observed.closed = true; });
          rawSockets.push(observed);
        },
      },
      ...(connectionGate ? [connectionGate] : []),
      gate,
    ],
    onAuthenticate: authenticate,
  });
  const allocations = vi.spyOn(server.hocuspocus, "handleConnection");
  await server.listen();
  const active = { server, gate, port: server.address.port, rawSockets, allocations, authenticate, failures };
  running.push(active);
  return active;
}

/**
 * Try a real WebSocket upgrade and consume its actual HTTP result.
 * @param port - The native server's listener.
 * @param cookie - The optional browser Cookie header.
 * @returns The observed HTTP status, body and client.
 * @throws {Error} When a transport error occurs before an HTTP result.
 */
async function upgrade(
  port: number,
  cookie?: string,
): Promise<{ status: number; body: string; connection: string | undefined; client: WebSocket }> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  clients.push(client);
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve({ status: 101, body: "", connection: "Upgrade", client }));
    client.once("unexpected-response", (request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const result = {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          connection: response.headers.connection,
          client,
        };
        client.on("error", () => {});
        request.destroy();
        client.terminate();
        resolve(result);
      });
      response.once("error", reject);
    });
    client.once("error", reject);
  });
}

/**
 * Wait for actual server-side close and check that gate listeners were removed.
 * @param active - The server that refused the client.
 * @param expectedSockets - The number of actual upgrade requests in this check.
 * @throws {Error} When a native socket or its listeners remain held.
 */
async function expectReleased(active: RunningServer, expectedSockets = 1): Promise<void> {
  expect(active.rawSockets).toHaveLength(expectedSockets);
  await expect.poll(() => active.rawSockets.every(({ socket, closed }) => socket.destroyed && closed), {
    timeout: 5_000,
  }).toBe(true);
  for (const observed of active.rawSockets) {
    expect(observed.socket.listenerCount("end")).toBe(observed.endListeners);
    expect(observed.socket.listenerCount("error")).toBe(observed.errorListeners);
  }
}

/**
 * Read the actual synchronous pino output for the production gate.
 * @returns The emitted JSON lines.
 * @throws {Error} When the test log cannot be read.
 */
function recordedLogs(): string {
  const directory = join(logsRoot, "upgrade-session-test");
  return readdirSync(directory).map((file) => readFileSync(join(directory, file), "utf8")).join("");
}

/**
 * Encode the actual document-auth frame used by the installed protocol.
 * @param name - The target document.
 * @returns Its binary wire frame.
 */
function authFrame(name: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, name);
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarString(encoder, "__cookie_auth__");
  return encoding.toUint8Array(encoder);
}

/**
 * Proxy the real Redis container so a response can be held after GET was sent.
 * @param commandTimeout - The bound used for this transport fault scenario.
 * @returns The connected client and controllable transport sockets.
 * @throws {Error} When either listener or Redis cannot connect.
 */
async function redisTransport(commandTimeout = 5_000): Promise<RedisTransport> {
  const target = new URL(inject("REDIS_URL"));
  const sockets = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    const upstream = connect({ host: target.hostname, port: Number(target.port) });
    upstreams.add(upstream);
    socket.on("error", () => {});
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.on("close", () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on("close", () => upstreams.delete(upstream));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener address");
  const client = createRedisClient(`redis://127.0.0.1:${address.port}/0`, {
    name: "upgrade-session-delayed-transport",
    commandTimeout,
    enableReadyCheck: false,
    keyPrefix: `upgrade-transport-${randomUUID()}:`,
  });
  const transport = { client, server, sockets, upstreams };
  transports.push(transport);
  await client.ping();
  return transport;
}

describe("upgrade session admission with real Redis and native WebSocket transport", () => {
  it.each([false, true])("refuses invalid cookies before allocating ClientConnection when throttle=%s", async (enabled) => {
    const redis = await sessionClient();
    const active = await listen(redis, enabled);
    const cookieName = sessionCookieName();
    for (const cookie of [undefined, `${cookieName}=`, `${cookieName}=unknown`, `${cookieName}=%E0%A4%A`]) {
      const result = await upgrade(active.port, cookie);
      expect(result.status).toBe(401);
      expect(result.connection).toBe("close");
      expect(result.body).toBe("");
    }
    expect(active.allocations).toHaveBeenCalledTimes(0);
    expect(active.authenticate).toHaveBeenCalledTimes(0);
    expect(active.failures).toHaveBeenCalledTimes(4);
    await expectReleased(active, 4);
  });

  it("refuses actual expired and revoked session records before allocation", async () => {
    const redis = await sessionClient();
    const expired = await session(redis);
    await redis.pexpire(`${env.ENV}:session:${expired}`, 1);
    await expect.poll(() => redis.get(`${env.ENV}:session:${expired}`)).toBe(null);
    const revoked = await session(redis);
    await revokeSession(redis, revoked);
    const active = await listen(redis);
    for (const token of [expired, revoked]) {
      expect((await upgrade(active.port, `${sessionCookieName()}=${token}`)).status).toBe(401);
    }
    expect(active.allocations).toHaveBeenCalledTimes(0);
    await expectReleased(active, 2);
  });

  it("admits a real current session and lets the native document-auth path run", async () => {
    const redis = await sessionClient();
    const token = await session(redis);
    const active = await listen(redis, true);
    const result = await upgrade(active.port, `${sessionCookieName()}=${token}`);
    expect(result.status).toBe(101);
    expect(active.allocations).toHaveBeenCalledTimes(1);
    result.client.send(authFrame("project-session/meta"));
    await expect.poll(() => active.authenticate.mock.calls.length).toBe(1);
    expect(active.failures).toHaveBeenCalledTimes(0);
    active.gate.stop();
    expect(result.client.readyState).toBe(WebSocket.OPEN);
  });

  it("returns 503 for a real Redis WRONGTYPE error and admits a fresh request after recovery", async () => {
    const redis = await sessionClient();
    const token = `private-${randomUUID()}`;
    const key = `${env.ENV}:session:${token}`;
    keys.push({ redis, key });
    await redis.rpush(key, "wrong-type");
    const active = await listen(redis);
    expect((await upgrade(active.port, `${sessionCookieName()}=${token}`)).status).toBe(503);
    expect(active.allocations).toHaveBeenCalledTimes(0);
    await expectReleased(active);
    const log = recordedLogs();
    expect(log).toContain("collab_upgrade_session_error");
    expect(log).toContain("WRONGTYPE");
    expect(log).not.toContain(token);
    expect(log).not.toContain(encodeURIComponent(token));
    expect(log).not.toContain('"command":');
    await redis.del(key);
    await setSession(redis, token, "11111111-1111-4111-8111-111111111111");
    expect((await upgrade(active.port, `${sessionCookieName()}=${token}`)).status).toBe(101);
    expect(active.allocations).toHaveBeenCalledTimes(1);
    expect(active.failures).toHaveBeenCalledTimes(1);
  });

  it("times out an actual withheld Redis reply and recovers on the same gate", async () => {
    const transport = await redisTransport(200);
    const token = await session(transport.client);
    const active = await listen(transport.client);
    for (const upstream of transport.upstreams) upstream.pause();
    const response = await upgrade(active.port, `${sessionCookieName()}=${token}`);
    expect(response.status).toBe(503);
    expect(active.allocations).toHaveBeenCalledTimes(0);
    await expectReleased(active);
    expect(recordedLogs()).toContain("Command timed out");
    expect(recordedLogs()).not.toContain(token);
    for (const upstream of transport.upstreams) upstream.resume();
    await transport.client.ping();
    const recovered = await upgrade(active.port, `${sessionCookieName()}=${token}`);
    expect(recovered.status).toBe(101);
    expect(active.allocations).toHaveBeenCalledTimes(1);
    expect(active.failures).toHaveBeenCalledTimes(1);
  });

  it.each(["fin", "reset", "stop"] as const)("releases an in-flight real GET after %s and consumes its late reply", async (event) => {
    const transport = await redisTransport();
    const token = await session(transport.client);
    const active = await listen(transport.client);
    for (const upstream of transport.upstreams) upstream.pause();
    const get = vi.spyOn(transport.client, "get");
    const socket = connect({ host: "127.0.0.1", port: active.port });
    socket.on("error", () => {});
    const closed = once(socket, "close");
    await once(socket, "connect");
    socket.write([
      "GET / HTTP/1.1", `Host: 127.0.0.1:${active.port}`, "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: c2Vzc2lvbi10ZXN0LWtleQ==",
      `Cookie: ${sessionCookieName()}=${token}`, "", "",
    ].join("\r\n"));
    await expect.poll(() => get.mock.calls.length).toBe(1);
    if (event === "fin") socket.end();
    else if (event === "reset") socket.resetAndDestroy();
    else expect(active.gate.stop()).toBe(undefined);
    await expectReleased(active);
    expect(active.allocations).toHaveBeenCalledTimes(0);
    expect(active.failures).toHaveBeenCalledTimes(0);
    for (const upstream of transport.upstreams) upstream.resume();
    await transport.client.ping();
    socket.destroy();
    await closed;
    expect(active.allocations).toHaveBeenCalledTimes(0);
  });

  it("reads only the current deployment cookie using the supplied Redis keyPrefix", async () => {
    const redis = await sessionClient();
    const token = await session(redis);
    const active = await listen(redis);
    const get = vi.spyOn(redis, "get");
    expect((await upgrade(active.port, `breatic_session_other=${token}`)).status).toBe(401);
    expect(get).toHaveBeenCalledTimes(0);
    expect((await upgrade(active.port, `${sessionCookieName()}=${token}`)).status).toBe(101);
    expect(get).toHaveBeenCalledExactlyOnceWith(`${env.ENV}:session:${token}`);
  });
});
