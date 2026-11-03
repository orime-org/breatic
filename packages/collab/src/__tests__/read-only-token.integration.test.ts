// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A connection that presents the read-only token reads and nothing else
 * (inner#1552).
 *
 * The browser reads a Space the agent asked for over a socket of its own, and
 * that read must not cost anyone a seat: with the ordinary placeholder token
 * a full document lets the same person in writable and replaces their earlier
 * seat, which would demote the tab they are editing in. The token only ever
 * lowers what its own connection may do; who the person is still comes from
 * the cookie alone.
 *
 * Production hooks from `createCollabServer`, the real seat registry on real
 * Redis and the real demote channel; the handshake is driven through the
 * production `onAuthenticate` with the meta doc held in memory, and the
 * transport is a stand-in as in `duplicate-document-on-socket`.
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
    // The cookie's session token is the user id here.
    getSession: async (_redis: unknown, token: string): Promise<string> => token,
    projectAuthService: { ...real.projectAuthService, loadProjectRole: async () => "editor" },
    // One writable seat per document, so a second writer is visible at once.
    getProjectConcurrentEditorLimit: async (): Promise<number> => 1,
  };
});

import { initCore, sessionCookieName } from "@breatic/core";
import { projectMetaDocName, READ_ONLY_COLLAB_TOKEN, spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";

/** The placeholder token an ordinary browser connection sends. */
const COOKIE_AUTH_TOKEN = "__cookie_auth__";

/** A connection stand-in that ends the way the framework ends one. */
interface FakeConnection {
  readOnly: boolean;
  closed: boolean;
  close: () => void;
  context: Record<string, unknown>;
  document: Y.Doc;
  webSocket: EventEmitter & { send: ReturnType<typeof vi.fn> };
}

/** The production hooks this suite drives. */
interface Hooks {
  onAuthenticate: (payload: unknown) => Promise<Record<string, unknown>>;
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
 * @returns The hooks it registered.
 */
async function startServer(): Promise<Hooks> {
  serverSpy.mockClear();
  const result = await createCollabServer({
    collabRedisUrl: process.env.REDIS_COLLAB_URL!,
    port: 0,
    redisKeyPrefix: `itest-ro-${randomUUID()}`,
    shutdownDeadline: () => undefined,
  });
  stops.push(() => result.storeLoop.stop(), () => result.stopUpgradeSessions(), () => result.seatHandover.stop());
  return serverSpy.mock.calls.at(-1)?.[0] as Hooks;
}

/** One canvas Space, listed in its project's meta doc held in memory. */
interface World {
  hooks: Hooks;
  documentName: string;
  instance: { documents: Map<string, Y.Doc> };
  open: (userId: string, socketId: string, token: string) => Promise<FakeConnection>;
}

/**
 * A fresh server and canvas document, and a way to open it.
 * @returns The world.
 */
async function world(): Promise<World> {
  const hooks = await startServer();
  const projectId = randomUUID();
  const spaceId = randomUUID();
  const documentName = spaceContentDocName(projectId, spaceId, "canvas");
  const meta = new Y.Doc();
  const entry = new Y.Map<unknown>();
  entry.set("id", spaceId);
  entry.set("type", "canvas");
  entry.set("name", "Cast");
  meta.getMap("spaces").set(spaceId, entry);
  const instance = { documents: new Map([[projectMetaDocName(projectId), meta]]) };
  const sockets = new Map<string, FakeConnection["webSocket"]>();

  /**
   * Run a handshake and, when it lets the connection in, its `connected` hook.
   * @param userId - Whose cookie.
   * @param socketId - The socket it rides.
   * @param token - The token in the auth frame.
   * @returns The connection, as the framework would hold it.
   */
  async function open(userId: string, socketId: string, token: string): Promise<FakeConnection> {
    const connectionConfig = { readOnly: false };
    const context = await hooks.onAuthenticate({
      token,
      documentName,
      requestHeaders: new Headers({ cookie: `${sessionCookieName()}=${userId}` }),
      connectionConfig,
      instance,
      request: new Request(`http://localhost/${documentName}`),
      socketId,
    });
    const webSocket = sockets.get(socketId) ?? Object.assign(new EventEmitter(), { send: vi.fn() });
    sockets.set(socketId, webSocket);
    const connection: FakeConnection = {
      readOnly: connectionConfig.readOnly,
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
    await hooks.connected({
      documentName,
      socketId,
      context,
      instance: { documents: new Map() },
      connectionConfig,
      connection,
    });
    // Let a demote request travel the real channel and come back.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    return connection;
  }

  return { hooks, documentName, instance, open };
}

describe("a connection presenting the read-only token", () => {
  it("is read-only and judged against no seat", async () => {
    const w = await world();
    const reader = await w.open("alice", "sock-read", READ_ONLY_COLLAB_TOKEN);

    expect(reader.readOnly).toBe(true);
    expect(reader.context.seatCap).toBeNull();
    expect(reader.context.user).toEqual({ id: "alice", role: "editor" });
  });

  it("takes no seat, so the one seat is still there for a writer", async () => {
    const w = await world();
    await w.open("alice", "sock-read", READ_ONLY_COLLAB_TOKEN);
    const writer = await w.open("bob", "sock-bob", COOKIE_AUTH_TOKEN);

    expect(writer.readOnly).toBe(false);
    expect(writer.context.seatCap).toBe(1);
  });

  it("leaves the same person's writable connection on another socket writable and seated", async () => {
    const w = await world();
    const editing = await w.open("alice", "sock-tab", COOKIE_AUTH_TOKEN);
    expect(editing.readOnly).toBe(false);

    const reader = await w.open("alice", "sock-read", READ_ONLY_COLLAB_TOKEN);

    expect(reader.readOnly).toBe(true);
    expect(editing.readOnly).toBe(false);
    expect(editing.webSocket.send).not.toHaveBeenCalled();
    // The tab still holds the one seat: a stranger arriving now is let in read-only.
    const stranger = await w.open("carol", "sock-carol", COOKIE_AUTH_TOKEN);
    expect(stranger.readOnly).toBe(true);
  });

  it("does not demote anyone else's writable connection", async () => {
    const w = await world();
    const bob = await w.open("bob", "sock-bob", COOKIE_AUTH_TOKEN);
    await w.open("alice", "sock-read", READ_ONLY_COLLAB_TOKEN);

    expect(bob.readOnly).toBe(false);
    expect(bob.webSocket.send).not.toHaveBeenCalled();
  });

  it("is still refused for a Space the meta doc does not list", async () => {
    const w = await world();
    const projectId = randomUUID();
    const unlisted = spaceContentDocName(projectId, randomUUID(), "canvas");
    await expect(
      w.hooks.onAuthenticate({
        token: READ_ONLY_COLLAB_TOKEN,
        documentName: unlisted,
        requestHeaders: new Headers({ cookie: `${sessionCookieName()}=alice` }),
        connectionConfig: { readOnly: false },
        instance: { documents: new Map([[projectMetaDocName(projectId), new Y.Doc()]]) },
        request: new Request(`http://localhost/${unlisted}`),
        socketId: "sock-read",
      }),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("a connection presenting any other token", () => {
  it("is writable and seated on a document with room", async () => {
    const w = await world();
    const writer = await w.open("alice", "sock-a", COOKIE_AUTH_TOKEN);

    expect(writer.readOnly).toBe(false);
    expect(writer.context.seatCap).toBe(1);
  });

  it("is let in writable by the same person on a full document, and their earlier connection is demoted", async () => {
    const w = await world();
    const first = await w.open("alice", "sock-a", COOKIE_AUTH_TOKEN);
    const second = await w.open("alice", "sock-b", "anything-else");

    expect(second.readOnly).toBe(false);
    expect(first.readOnly).toBe(true);
  });

  it("is degraded to read-only for someone else on a full document", async () => {
    const w = await world();
    await w.open("alice", "sock-a", COOKIE_AUTH_TOKEN);
    const bob = await w.open("bob", "sock-b", COOKIE_AUTH_TOKEN);

    expect(bob.readOnly).toBe(true);
    expect(bob.context.seatCap).toBeNull();
  });
});
