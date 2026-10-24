// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asserts what `createCollabServer` hands to the Hocuspocus server and its
 * Redis extension — the values whose type gives the compiler nothing to check,
 * so that wiring the wrong one still compiles and only shows up in production.
 * The Redis channel prefix (#1831) is the main case.
 *
 * Why this narrow test exists: the prefix is what keeps two deployments
 * sharing a Redis instance from delivering each other's document updates.
 * Redis pub/sub ignores the DB number, so the `REDIS_*_URL` split — which
 * isolates every ordinary key — cannot cover channels; this one string is
 * the entire isolation mechanism.
 *
 * And the compiler cannot guard it: `collabRedisUrl` and `redisKeyPrefix`
 * are both `string`, so wiring the wrong one in still typechecks and only
 * shows up as production cross-talk. Hence an explicit assertion on what
 * the extension actually receives.
 *
 * The same blind spot covers the lifecycle hooks: a hook that is never
 * registered, or registered without one of the arguments it needs, compiles
 * and runs. The hooks have their own tests, but those stand up a server and
 * wire it themselves, so only a case here can see whether production wired it
 * at all.
 *
 * Everything that would open a socket or a timer is mocked; the YAML config
 * is read for real (it is a pure file read).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TimelinePersistenceResponseSchema } from "@breatic/shared";
import type { TimelinePersistenceRequest, TimelinePersistenceResponse } from "@breatic/shared";

import type * as ConnectionRegistryModuleShape from "@collab/services/connection-registry.js";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as TimelinePersistenceModule from "@collab/services/timeline-persistence.js";
import type * as ConnectionGateModuleShape from "@collab/infra/connection-gate.js";

/** The real module, so the mock can keep everything it does not replace. */
type ConnectionRegistryModule = typeof ConnectionRegistryModuleShape;

const {
  redisExtensionSpy,
  serverSpy,
  registryStub,
  registryFactorySpy,
  collabRedisStub,
  loadProjectRoleStub,
  connectionGateSpy,
  failedAuthWrapperSpy,
  loggerInfoSpy,
} = vi.hoisted(() => ({
  connectionGateSpy: vi.fn(),
  failedAuthWrapperSpy: vi.fn(),
  loggerInfoSpy: vi.fn(),
  redisExtensionSpy: vi.fn(),
  serverSpy: vi.fn(),
  registryStub: {
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    count: vi.fn(async () => 0),
    refreshSocket: vi.fn(async () => undefined),
    forgetSeat: vi.fn(async () => undefined),
    claimSeatFrom: vi.fn(async () => ({ outcome: "none" as const })),
  },
  registryFactorySpy: vi.fn(),
  collabRedisStub: { on: vi.fn(), publish: vi.fn(async () => 1) },
  // The `connected` hook re-reads the role; by default it reads back what
  // the handshake granted, so nothing is closed.
  loadProjectRoleStub: vi.fn(async (): Promise<string | undefined> => undefined),
}));

vi.mock("@hocuspocus/extension-redis", () => ({
  Redis: class {
    constructor(config: unknown) {
      redisExtensionSpy(config);
    }
  },
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

vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    info: loggerInfoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  // The seat-handover channel takes a dedicated client and subscribes on it.
  createRedisClient: vi.fn(() => ({
    on: vi.fn(),
    subscribe: vi.fn(async () => 1),
    unsubscribe: vi.fn(async () => 1),
  })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => collabRedisStub),
  // The timed store's alert arm (#40) reaches operations through core's
  // mailer, and its rescue directory resolves from the monorepo root.
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  MONOREPO_ROOT: "/tmp",
  // Injected into the auth hook as the per-project writable-connection
  // ceiling (#88). Nothing here exercises the ceiling, but the wiring reads
  // the export at module scope, so it has to exist.
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  projectAuthService: { loadProjectRole: loadProjectRoleStub },
  runWithConsent: <T>(_consent: unknown, fn: () => T): T => fn(),
}));

vi.mock("@collab/services/space-rpc.js", () => ({
  handleSpaceRpc: vi.fn(async (_deps: unknown, _projectId: string, _caller: unknown, req: { id: string }) => ({
    id: req.id,
    ok: true,
    result: {},
  })),
}));

vi.mock("@collab/services/timeline-persistence.js", async (importOriginal) => {
  const real = await importOriginal<typeof TimelinePersistenceModule>();
  return {
    ...real,
    handleTimelinePersistenceRpc: vi.fn<typeof real.handleTimelinePersistenceRpc>(),
  };
});

vi.mock("@collab/infra/connection-gate.js", async () => {
  const real = await vi.importActual<typeof ConnectionGateModuleShape>(
    "@collab/infra/connection-gate.js",
  );
  return {
    ...real,
    createConnectionGate: ((...args: Parameters<typeof real.createConnectionGate>) => {
      const gate = real.createConnectionGate(...args);
      connectionGateSpy(gate);
      return gate;
    }) as typeof real.createConnectionGate,
    recordingFailedAuth: ((...args: Parameters<typeof real.recordingFailedAuth>) => {
      const wrapped = real.recordingFailedAuth(...args);
      failedAuthWrapperSpy(wrapped);
      return wrapped;
    }) as typeof real.recordingFailedAuth,
  };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", async () => {
  const real = await vi.importActual<ConnectionRegistryModule>(
    "@collab/services/connection-registry.js",
  );
  return {
    ...real,
    createConnectionRegistry: vi.fn((options: unknown) => {
      registryFactorySpy(options);
      return registryStub;
    }),
  };
});

import * as Y from "yjs";

import { createCollabServer } from "../hocuspocus.js";
import { getConnectionTimings } from "../config.js";
import { readPresence } from "../hooks/presence.js";
import { SOCKET_CEILINGS } from "../infra/socket-ceilings.js";
import { handleSpaceRpc } from "../services/space-rpc.js";
import { handleTimelinePersistenceRpc } from "../services/timeline-persistence.js";

/**
 * Read the `prefix` the Redis extension was constructed with.
 * @returns The prefix string passed to the extension.
 */
function capturedPrefix(): string {
  expect(redisExtensionSpy).toHaveBeenCalledTimes(1);
  const config = redisExtensionSpy.mock.calls[0]?.[0] as { prefix: string };
  return config.prefix;
}

describe("createCollabServer — Redis channel prefix", () => {
  beforeEach(() => {
    redisExtensionSpy.mockClear();
    serverSpy.mockClear();
  });

  it("derives the channel prefix from redisKeyPrefix", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    expect(capturedPrefix()).toBe("dev:hocuspocus");
  });

  it("carries a per-deployment prefix through instead of hard-coding one", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/7",
      port: 1234,
      redisKeyPrefix: "dev-agent",
      shutdownDeadline: () => undefined,
    });

    expect(capturedPrefix()).toBe("dev-agent:hocuspocus");
  });

  // The two infra fields are both plain strings, so this guards against the
  // wiring silently reading the URL — which would put credentials in a
  // channel name AND make every deployment on one Redis share it again.
  // infra.port is the other value that reaches Hocuspocus from index.ts now
  // that the port left collab.yaml. Nothing else asserts it lands on the Server.
  it("passes infra.port through to the Hocuspocus server", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1244,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const config = serverSpy.mock.calls[0]?.[0] as { port: number };
    expect(config.port).toBe(1244);
  });

  // Every option below is one the library supplies a default for, so leaving
  // it out costs nothing at build time and changes behaviour in production.
  // `socket-ceilings.test.ts` pins what the ceilings have to be; these pin
  // that they are used at all. They are asserted as one object rather than
  // one case each because the failure they guard against is a whole config
  // block being tidied, not one line going missing.
  it("passes every option it must not inherit a default for", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const config = serverSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      // Both ceilings that close a whole socket.
      ...SOCKET_CEILINGS,
      // Broadcast on apply rather than coalescing per event-loop turn. The
      // library's own default is `0`, which batches; the Space RPC commit
      // boundary is built on the broadcast being the synchronous, observable
      // commit point, and `broadcastStateless` is never batched, so batching
      // would also let the activity signal overtake the change it announces.
      flushDelay: false,
    });
  });

  it("prints the socket ceilings it runs with in the startup log", async () => {
    loggerInfoSpy.mockClear();
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const banner = loggerInfoSpy.mock.calls.find(
      ([, message]) => message === "Hocuspocus server configured",
    );
    expect(banner?.[0]).toMatchObject(SOCKET_CEILINGS);
  });

  it("counts a rejected authentication with the connection gate", async () => {
    failedAuthWrapperSpy.mockClear();
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const config = serverSpy.mock.calls[0]?.[0] as { onAuthenticate: unknown };
    expect(failedAuthWrapperSpy).toHaveBeenCalledTimes(1);
    expect(config.onAuthenticate).toBe(failedAuthWrapperSpy.mock.calls[0]?.[0]);
  });

  it("registers the connection gate it built as an extension", async () => {
    // The per-WebSocket count and the ban check run only as this extension's
    // onUpgrade and onConnect, so a gate that is built but not registered
    // leaves production unthrottled while every gate test stays green.
    connectionGateSpy.mockClear();
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const config = serverSpy.mock.calls.at(-1)?.[0] as { extensions: unknown[] };
    expect(connectionGateSpy).toHaveBeenCalledTimes(1);
    expect(config.extensions).toContain(connectionGateSpy.mock.calls[0]?.[0]);
  });

  it("never uses the Redis URL as the prefix", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev-studio",
      shutdownDeadline: () => undefined,
    });

    expect(capturedPrefix()).not.toContain("redis://");
    expect(capturedPrefix()).toBe("dev-studio:hocuspocus");
  });
});

describe("createCollabServer — the identity rule is registered", () => {
  beforeEach(() => {
    redisExtensionSpy.mockClear();
    serverSpy.mockClear();
  });

  // The rule itself and the payload reading are covered elsewhere, both
  // against a real server. What no other case reaches is this last link: that
  // the hook is on the config handed to Hocuspocus, and that the arguments it
  // forwards are the ones the rule needs. Those tests stand up their own
  // server and wire the hooks themselves, so deleting the wiring here — or
  // dropping `connection` from what it forwards — leaves every one of them
  // green while carets go out unstamped in production. The sibling suite's own
  // header records that failure happening twice already
  // (`hooks/__tests__/presence-wiring.test.ts`).
  it("wires the awareness hook so an inbound frame comes back stamped", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const config = serverSpy.mock.calls[0]?.[0] as {
      beforeHandleAwareness?: (payload: unknown) => Promise<void>;
    };
    expect(typeof config.beforeHandleAwareness).toBe("function");

    const states = new Map<number, Record<string, unknown>>([
      [4242, { cursor: { anchor: 1, head: 1 }, user: { id: "u-victim" } }],
    ]);
    await config.beforeHandleAwareness?.({
      states,
      documentName: "project-p/canvas-s",
      connection: { context: { user: { id: "u-alice" } } },
    });

    expect(states.get(4242)?.user).toEqual({ id: "u-alice" });
  });
});

describe("createCollabServer — only writable connections take a seat", () => {
  beforeEach(() => {
    serverSpy.mockClear();
    registryStub.register.mockClear();
    registryStub.unregister.mockClear();
  });

  /**
   * Run the registered `connected` hook the way Hocuspocus would.
   * @param documentName - Which document the connection opened.
   * @param readOnly - What the auth hook settled on `connectionConfig`.
   * @returns Nothing; assert on the registry stub afterwards.
   */
  async function fireConnected(
    documentName: string,
    readOnly: boolean,
  ): Promise<void> {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls[0]?.[0] as {
      connected?: (payload: unknown) => Promise<void>;
    };
    expect(typeof config.connected).toBe("function");
    await config.connected?.({
      documentName,
      socketId: "sock-1",
      context: { user: { id: "u-1" }, handedOverFrom: null },
      instance: { documents: new Map() },
      connectionConfig: { readOnly },
      // The socket the pong listener goes on. One per connection in
      // production; the same one every time here, since these cases are
      // about which documents take a seat.
      connection: {
        readOnly,
        webSocket: { send: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() },
      },
    });
  }

  // #88's central rule, at the one place it is actually applied. Everything
  // else about it is covered against `shouldRegisterConnection` as a pure
  // function, and that leaves this call site free: swapping it back to
  // `shouldTrackConnection(documentName)` — the pre-#88 behaviour, where a
  // read-only connection took a seat like any other — was measured to leave
  // all 476 collab tests green. Acceptance item 18 rests entirely on this line.
  it("registers a writable connection to a Space document", async () => {
    await fireConnected("project-p/canvas-s", false);
    expect(registryStub.register).toHaveBeenCalledWith(
      "project-p/canvas-s",
      expect.objectContaining({ socketId: "sock-1", userId: "u-1" }),
    );
  });

  it("does NOT register a read-only connection to the same document", async () => {
    await fireConnected("project-p/canvas-s", true);
    expect(registryStub.register).not.toHaveBeenCalled();
  });

  // The meta doc is exempt from the ceiling entirely, writable or not — it is
  // project infrastructure everybody must hold, never a measure of how many
  // people can collaborate.
  it("does NOT register the project meta document", async () => {
    await fireConnected("project-p/meta", false);
    expect(registryStub.register).not.toHaveBeenCalled();
  });
});

describe("createCollabServer — the facts a connection and its pong carry", () => {
  beforeEach(() => {
    serverSpy.mockClear();
    registryStub.refreshSocket.mockClear();
    registryFactorySpy.mockClear();
    collabRedisStub.publish.mockClear();
  });

  /** A meta document holding two Spaces, the second one newer. */
  function metaDocWithTwoSpaces(): Y.Doc {
    const doc = new Y.Doc();
    const spaces = doc.getMap("spaces");
    doc.transact(() => {
      for (const [id, createdAt] of [
        ["space-old", 1_000],
        ["space-new", 2_000],
      ] as const) {
        const entry = new Y.Map<unknown>();
        spaces.set(id, entry);
        entry.set("id", id);
        entry.set("createdAt", createdAt);
      }
    });
    return doc;
  }

  /**
   * Run the `connected` hook the way Hocuspocus would, and hand back the one
   * listener the transport would later call.
   * @param args - What the handshake settled.
   * @param args.documentName - Document the connection opened.
   * @param args.document - The Yjs document behind it.
   * @param args.handedOverFrom - Member string the handshake claimed, if any.
   * @returns The captured pong listener.
   */
  async function fireConnectedFor(args: {
    documentName: string;
    document: Y.Doc;
    handedOverFrom?: string | null;
  }): Promise<() => void> {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls[0]?.[0] as {
      connected?: (payload: unknown) => Promise<void>;
    };
    const listeners = new Map<string, () => void>();
    const connection = {
      readOnly: false,
      context: { user: { id: "u-1" }, handedOverFrom: args.handedOverFrom ?? null },
      document: args.document,
      webSocket: {
        send: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
          listeners.set(event, listener);
        }),
        once: vi.fn(),
        off: vi.fn(),
      },
    };
    await config.connected?.({
      documentName: args.documentName,
      socketId: "sock-1",
      context: connection.context,
      instance: { documents: new Map([[args.documentName, args.document]]) },
      connectionConfig: { readOnly: false },
      connection,
    });
    const pong = listeners.get("pong");
    expect(typeof pong).toBe("function");
    return pong as () => void;
  }

  // One pong, two facts, through the wiring that carries them. Cutting
  // `onPong` out of the options — or either half out of the handler it is
  // built from — left all 523 cases in this package green, which is the
  // same shape the presence defect shipped in one round earlier: the module
  // was correct and nothing called it.
  it("moves both the seats and the presence record when a socket answers", async () => {
    const doc = metaDocWithTwoSpaces();
    const pong = await fireConnectedFor({
      documentName: "project-p/meta",
      document: doc,
    });
    // Put the record where a missed refresh would leave it, so the assertion
    // reads the pong's own write rather than the one `connected` just made.
    const record = doc.getMap("users").get("u-1") as Y.Map<unknown>;
    doc.transact(() => {
      record.set("online", false);
      record.set("lastSeenAt", 0);
    });

    pong();

    expect(registryStub.refreshSocket).toHaveBeenCalledWith("sock-1");
    const after = readPresence(doc, "u-1");
    expect(after?.online).toBe(true);
    expect(after?.lastSeenAt).toBeGreaterThan(0);
  });

  // Two of the three things a handover owes the tab it took a seat from:
  // telling the instance that holds it, and naming which seat. Dropping the
  // call leaves that tab writable with no notice and the document one
  // connection over the ceiling its tier sells.
  it("asks the holder of a claimed seat to demote it", async () => {
    await fireConnectedFor({
      documentName: "project-p/canvas-s",
      document: new Y.Doc(),
      handedOverFrom: "u-1:1000:inst-a:sock-old",
    });

    expect(collabRedisStub.publish).toHaveBeenCalledWith(
      "dev:collab:seat-demote",
      JSON.stringify({
        documentName: "project-p/canvas-s",
        member: "u-1:1000:inst-a:sock-old",
      }),
    );
  });

  // `pingIntervalMs` and `seatExpiryMs` are adjacent options of the same
  // type, and the first is what decides whether a seat counts as one that
  // stopped answering. Passing the second makes the handover take the tab
  // the member is typing in instead of the one their blip left behind.
  it("hands the registry the ping interval and the seat expiry it declares", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });

    const timings = getConnectionTimings();
    expect(registryFactorySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pingIntervalMs: timings.pingIntervalMs,
        seatExpiryMs: timings.seatExpiryMs,
      }),
    );
  });
});

describe("createCollabServer — a connection re-reads its role once registered", () => {
  const DOC = "project-11111111-1111-4111-8111-111111111111/canvas-22222222-2222-4222-9222-222222222222";

  beforeEach(() => {
    serverSpy.mockClear();
    loadProjectRoleStub.mockReset();
  });

  it("closes a connection whose role changed between its handshake and its registration", async () => {
    loadProjectRoleStub.mockResolvedValue("viewer");
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls[0]?.[0] as {
      connected?: (payload: unknown) => Promise<void>;
    };
    const close = vi.fn();
    await config.connected?.({
      documentName: DOC,
      socketId: "sock-1",
      context: { user: { id: "u-1", role: "editor" }, handedOverFrom: null },
      instance: { documents: new Map() },
      connectionConfig: { readOnly: false },
      connection: {
        readOnly: false,
        close,
        webSocket: { send: vi.fn(), on: vi.fn(), once: vi.fn(), off: vi.fn() },
      },
    });
    expect(loadProjectRoleStub).toHaveBeenCalledWith("u-1", "11111111-1111-4111-8111-111111111111");
    expect(close).toHaveBeenCalledWith({ code: 4403, reason: "Permission changed, please reconnect" });
  });
});

describe("createCollabServer — Timeline persistence dispatcher", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const SPACE_ID = "22222222-2222-4222-9222-222222222222";
  const ACTION_ID = "33333333-3333-4333-8333-333333333333";
  const TIMELINE = `project-${PROJECT_ID}/timeline-${SPACE_ID}`;
  const REQUEST: TimelinePersistenceRequest = {
    version: 1,
    id: "timeline-request",
    type: "timeline:persistence:query",
    payload: { actionIds: [ACTION_ID] },
  };
  const RESPONSE: TimelinePersistenceResponse = {
    version: 1,
    id: REQUEST.id,
    type: "timeline:persistence:result",
    ok: true,
    result: { documentVersion: 1, persistedRecords: [], missingActionIds: [ACTION_ID] },
  };

  interface StatelessInput {
    documentName: string;
    payload: string;
    document: { broadcastStateless: (message: string) => void };
    connection: {
      context?: { user?: { id?: string; role?: "owner" | "editor" | "viewer" } };
      readOnly: boolean;
      sendStateless: (message: string) => void;
    };
  }

  type StatelessHook = (input: StatelessInput) => Promise<void>;
  type Factory = Awaited<ReturnType<typeof createCollabServer>>;

  beforeEach(() => {
    serverSpy.mockClear();
    vi.mocked(handleSpaceRpc).mockClear();
    vi.mocked(handleTimelinePersistenceRpc).mockReset();
    vi.mocked(handleTimelinePersistenceRpc).mockResolvedValue(RESPONSE);
  });

  /**
   * Exercise the actual factory-installed hook and release its owned resources.
   * @param check - Assertions using the captured production hook and factory.
   * @returns Once the assertions and resource cleanup finish.
   * @throws {Error} When factory creation, assertions or cleanup fails.
   */
  async function withStatelessHook(check: (hook: StatelessHook, factory: Factory) => Promise<void>): Promise<void> {
    const factory = await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "timeline-wiring",
      shutdownDeadline: () => undefined,
    });
    try {
      expect(serverSpy).toHaveBeenCalledTimes(1);
      const config = serverSpy.mock.calls[0]?.[0] as { onStateless: StatelessHook };
      await check(config.onStateless, factory);
    } finally {
      factory.storeLoop.stop();
      await factory.seatHandover.stop();
    }
  }

  it.each([
    { type: "timeline:persistence:query" as const, readOnly: true, role: "owner" as const },
    { type: "timeline:persistence:retry" as const, readOnly: false, role: "viewer" as const },
  ])("routes $type with actual connection readOnly=$readOnly and the factory store loop", async ({ type, readOnly, role }) => {
    await withStatelessHook(async (hook, factory) => {
      const sendStateless = vi.fn();
      const broadcastStateless = vi.fn();
      const requestStore = vi.spyOn(factory.storeLoop, "requestStore").mockResolvedValue("stored");
      try {
        const request = { ...REQUEST, type, payload: { actionIds: [ACTION_ID, ACTION_ID] } };
        await hook({
          documentName: TIMELINE,
          payload: JSON.stringify(request),
          document: { broadcastStateless },
          connection: { context: { user: { id: "connected-user", role } }, readOnly, sendStateless },
        });

        expect(handleTimelinePersistenceRpc).toHaveBeenCalledTimes(1);
        const delegated = vi.mocked(handleTimelinePersistenceRpc).mock.calls[0];
        expect(delegated?.[0]).toEqual({
          documentName: TIMELINE,
          userId: "connected-user",
          readOnly,
          requestStore: expect.any(Function),
        });
        // Deduplication is the real shared schema's transform, not a mocked parser.
        expect(delegated?.[1]).toEqual({ ...REQUEST, type });
        expect(sendStateless).toHaveBeenCalledExactlyOnceWith(JSON.stringify(RESPONSE));
        expect(broadcastStateless).not.toHaveBeenCalled();
        expect(handleSpaceRpc).not.toHaveBeenCalled();
        expect(requestStore).not.toHaveBeenCalled();

        const context = delegated?.[0];
        expect(context).toBeDefined();
        expect(await context?.requestStore(TIMELINE)).toBe("stored");
        expect(requestStore).toHaveBeenCalledExactlyOnceWith(TIMELINE);
      } finally {
        requestStore.mockRestore();
      }
    });
  });

  it("delegates authenticated users without requiring a cached role", async () => {
    await withStatelessHook(async (hook) => {
      const sendStateless = vi.fn();
      await hook({
        documentName: TIMELINE,
        payload: JSON.stringify(REQUEST),
        document: { broadcastStateless: vi.fn() },
        connection: { context: { user: { id: "current-member" } }, readOnly: true, sendStateless },
      });
      expect(handleTimelinePersistenceRpc).toHaveBeenCalledTimes(1);
      expect(vi.mocked(handleTimelinePersistenceRpc).mock.calls[0]?.[0]).toEqual({
        documentName: TIMELINE,
        userId: "current-member",
        readOnly: true,
        requestStore: expect.any(Function),
      });
      expect(sendStateless).toHaveBeenCalledExactlyOnceWith(JSON.stringify(RESPONSE));
    });
  });

  it("returns a correlated protocol refusal when authenticated user identity is absent", async () => {
    await withStatelessHook(async (hook) => {
      for (const context of [undefined, {}, { user: { role: "owner" as const } }]) {
        const sendStateless = vi.fn<(message: string) => void>();
        const broadcastStateless = vi.fn();
        await hook({
          documentName: TIMELINE,
          payload: JSON.stringify(REQUEST),
          document: { broadcastStateless },
          connection: { ...(context !== undefined && { context }), readOnly: false, sendStateless },
        });
        expect(sendStateless).toHaveBeenCalledTimes(1);
        const encoded = sendStateless.mock.calls[0]?.[0];
        expect(typeof encoded).toBe("string");
        const response = TimelinePersistenceResponseSchema.parse(JSON.parse(encoded ?? "null"));
        expect(response).toEqual({
          version: 1,
          id: REQUEST.id,
          type: "timeline:persistence:result",
          ok: false,
          error: { code: "FORBIDDEN", message: expect.any(String) },
        });
        expect(broadcastStateless).not.toHaveBeenCalled();
      }
      expect(handleTimelinePersistenceRpc).not.toHaveBeenCalled();
      expect(handleSpaceRpc).not.toHaveBeenCalled();
    });
  });

  it("ignores malformed and strict-schema-invalid messages including caller-supplied identity", async () => {
    await withStatelessHook(async (hook) => {
      const sendStateless = vi.fn();
      const broadcastStateless = vi.fn();
      const invalidMessages = [
        "{",
        "null",
        JSON.stringify({ ...REQUEST, version: 2 }),
        JSON.stringify({ ...REQUEST, payload: { actionIds: ["not-a-uuid"] } }),
        ...["projectId", "documentName", "docName", "userId", "readOnly"].flatMap((field) => [
          JSON.stringify({ ...REQUEST, [field]: "attacker-selected" }),
          JSON.stringify({ ...REQUEST, payload: { ...REQUEST.payload, [field]: "attacker-selected" } }),
        ]),
      ];
      for (const payload of invalidMessages) {
        await hook({
          documentName: TIMELINE,
          payload,
          document: { broadcastStateless },
          connection: { context: { user: { id: "connected-user", role: "owner" } }, readOnly: false, sendStateless },
        });
      }
      expect(handleTimelinePersistenceRpc).not.toHaveBeenCalled();
      expect(handleSpaceRpc).not.toHaveBeenCalled();
      expect(sendStateless).not.toHaveBeenCalled();
      expect(broadcastStateless).not.toHaveBeenCalled();
    });
  });

  it("does not route Timeline messages from other document namespaces", async () => {
    await withStatelessHook(async (hook) => {
      const sendStateless = vi.fn();
      const broadcastStateless = vi.fn();
      for (const documentName of [
        `project-${PROJECT_ID}/canvas-${SPACE_ID}`,
        `project-${PROJECT_ID}/document-${SPACE_ID}`,
        `project-${PROJECT_ID}/meta`,
        "invalid-document-name",
      ]) {
        await hook({
          documentName,
          payload: JSON.stringify(REQUEST),
          document: { broadcastStateless },
          connection: { context: { user: { id: "connected-user", role: "owner" } }, readOnly: false, sendStateless },
        });
      }
      expect(handleTimelinePersistenceRpc).not.toHaveBeenCalled();
      expect(handleSpaceRpc).not.toHaveBeenCalled();
      expect(sendStateless).not.toHaveBeenCalled();
      expect(broadcastStateless).not.toHaveBeenCalled();
    });
  });

  it("retains independent meta Space RPC routing and ignores Space RPC on Timeline content", async () => {
    await withStatelessHook(async (hook, factory) => {
      const sendStateless = vi.fn();
      const broadcastStateless = vi.fn();
      const request = { id: "space-request", type: "space:delete", payload: { spaceId: SPACE_ID } };
      const input: StatelessInput = {
        documentName: TIMELINE,
        payload: JSON.stringify(request),
        document: { broadcastStateless },
        connection: { context: { user: { id: "connected-user", role: "owner" } }, readOnly: false, sendStateless },
      };
      await hook(input);
      expect(handleSpaceRpc).not.toHaveBeenCalled();
      expect(sendStateless).not.toHaveBeenCalled();

      await hook({ ...input, documentName: `project-${PROJECT_ID}/meta` });
      expect(handleSpaceRpc).toHaveBeenCalledExactlyOnceWith(
        { hocuspocus: factory.hocuspocus },
        PROJECT_ID,
        { userId: "connected-user", role: "owner" },
        request,
      );
      expect(sendStateless).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ id: request.id, ok: true, result: {} }));
      expect(handleTimelinePersistenceRpc).not.toHaveBeenCalled();
      expect(broadcastStateless).not.toHaveBeenCalled();
    });
  });
});

describe("createCollabServer — a Space RPC answer goes to its sender", () => {
  const META = "project-11111111-1111-4111-8111-111111111111/meta";
  const REQUEST = JSON.stringify({
    id: "r1",
    type: "space:delete",
    payload: { spaceId: "22222222-2222-4222-9222-222222222222" },
  });

  beforeEach(() => {
    serverSpy.mockClear();
  });

  /**
   * The `onStateless` hook handed to Hocuspocus.
   * @returns The hook.
   */
  async function onStateless(): Promise<(payload: unknown) => Promise<void>> {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls[0]?.[0] as {
      onStateless: (payload: unknown) => Promise<void>;
    };
    return config.onStateless;
  }

  it("sends the reply on the requesting connection only", async () => {
    const hook = await onStateless();
    const broadcastStateless = vi.fn();
    const sendStateless = vi.fn();

    await hook({
      documentName: META,
      document: { broadcastStateless },
      payload: REQUEST,
      connection: { context: { user: { id: "u-1", role: "owner" } }, sendStateless },
    });

    expect(sendStateless).toHaveBeenCalledWith(JSON.stringify({ id: "r1", ok: true, result: {} }));
    expect(broadcastStateless).not.toHaveBeenCalled();
  });

  it("refuses an anonymous request on its own connection only", async () => {
    const hook = await onStateless();
    const broadcastStateless = vi.fn();
    const sendStateless = vi.fn();

    await hook({
      documentName: META,
      document: { broadcastStateless },
      payload: REQUEST,
      connection: { context: {}, sendStateless },
    });

    expect(sendStateless).toHaveBeenCalledWith(
      JSON.stringify({ id: "r1", ok: false, error: { code: "FORBIDDEN", message: "Anonymous caller" } }),
    );
    expect(broadcastStateless).not.toHaveBeenCalled();
  });
});
