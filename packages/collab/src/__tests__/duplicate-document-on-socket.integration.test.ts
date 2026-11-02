// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Two connections to one document on one socket must not outrun the cap
 * (inner#1034).
 *
 * A session-aware client (`documentName\0sessionId`) can open the same
 * document twice on one socket, and both connections arrive with the same
 * document name and socket id. Every per-connection record the server keeps
 * is keyed by that pair, so a second one let in would overwrite the first's,
 * and closing it would take the first one's seat away while that connection
 * went on writing.
 *
 * Production hooks from `createCollabServer`, the real seat registry on real
 * Redis and the real demote channel; only the transport is a stand-in, which
 * reports a connection's end the way Hocuspocus does, through `onDisconnect`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";

import type * as CoreModuleShape from "@breatic/core";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type { Redis } from "@breatic/core";

const { serverSpy, clients } = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  clients: [] as { quit(): Promise<unknown> }[],
}));

vi.mock("@hocuspocus/server", async (importOriginal) => ({
  ...(await importOriginal<typeof HocuspocusServerModule>()),
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@hocuspocus/extension-redis", () => ({ Redis: class {} }));

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const real = await importOriginal<typeof CoreModuleShape>();
  return {
    ...real,
    createRedisClient: (...args: Parameters<typeof real.createRedisClient>): Redis => {
      const client = real.createRedisClient(...args);
      clients.push(client);
      return client;
    },
    // The handshake is not run here; the two re-reads `connected` makes after
    // the seat agree with what it would have granted.
    getSession: async (_redis: unknown, token: string): Promise<string> => token,
    projectAuthService: { ...real.projectAuthService, loadProjectRole: async () => "editor" },
  };
});

import { initCore } from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";

/** A connection stand-in that ends the way the framework ends one. */
interface FakeConnection {
  readOnly: boolean;
  closed: boolean;
  close: () => void;
  context: Record<string, unknown>;
  document: Y.Doc;
  webSocket: EventEmitter & { send: ReturnType<typeof vi.fn> };
}

/** The production hooks this case drives. */
interface Hooks {
  connected: (payload: unknown) => Promise<void>;
  onDisconnect: (payload: unknown) => Promise<void>;
}

const stops: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  initCore(process.env);
});

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

afterAll(async () => {
  for (const client of clients.splice(0)) await client.quit().catch(() => undefined);
});

/**
 * Start a server and hand back its hooks.
 * @returns The `connected` and `onDisconnect` hooks it registered.
 */
async function startServer(): Promise<Hooks> {
  serverSpy.mockClear();
  const result = await createCollabServer({
    collabRedisUrl: process.env.REDIS_COLLAB_URL!,
    port: 0,
    redisKeyPrefix: `itest-dup-${randomUUID()}`,
    shutdownDeadline: () => undefined,
  });
  stops.push(() => result.storeLoop.stop(), () => result.stopUpgradeSessions(), () => result.seatHandover.stop());
  return serverSpy.mock.calls.at(-1)?.[0] as Hooks;
}

describe("two connections to one document on one socket", () => {
  it("cannot leave more writers than the cap", async () => {
    const hooks = await startServer();
    const documentName = `project-${randomUUID()}/canvas-${randomUUID()}`;
    const sockets = new Map<string, FakeConnection["webSocket"]>();
    const all: FakeConnection[] = [];

    /**
     * Open the document on a socket the way the framework does once the
     * handshake let the connection in writable under a cap of two.
     * @param userId - Whose connection.
     * @param socketId - The socket it rides.
     * @param arrivedAtMs - When its handshake began.
     * @returns The connection.
     */
    async function open(userId: string, socketId: string, arrivedAtMs: number): Promise<FakeConnection> {
      const webSocket = sockets.get(socketId) ?? Object.assign(new EventEmitter(), { send: vi.fn() });
      sockets.set(socketId, webSocket);
      const context = {
        user: { id: userId, role: "editor" },
        seatCap: 2,
        arrivedAtMs,
        session: { token: userId, id: `${userId}-session` },
      };
      const connection: FakeConnection = {
        readOnly: false,
        closed: false,
        close(): void {
          if (connection.closed) return;
          connection.closed = true;
          void hooks.onDisconnect({ documentName, context, socketId });
        },
        context,
        document: new Y.Doc(),
        webSocket,
      };
      all.push(connection);
      await hooks.connected({
        documentName,
        socketId,
        context,
        instance: { documents: new Map() },
        connectionConfig: { readOnly: false },
        connection,
      });
      // Let a demote request travel the real channel and come back.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      return connection;
    }

    const now = Date.now();
    await open("alice", "sock-a", now - 3_000);
    await open("bob", "sock-b", now - 2_000);
    // Alice holds a seat, so the handshake lets her second session in
    // writable; it rides the socket her first one is on.
    const second = await open("alice", "sock-a", now - 1_000);
    second.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    await open("carol", "sock-c", now);

    const writers = all.filter((c) => !c.closed && !c.readOnly);
    expect(writers.length).toBeLessThanOrEqual(2);
  });
});
