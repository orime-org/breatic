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
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type * as ConnectionRegistryModuleShape from "@collab/services/connection-registry.js";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as ConnectionGateModuleShape from "@collab/infra/connection-gate.js";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";

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
  authRedisStub,
  sessionLookupSpy,
  throttleCountSpy,
  testConfig,
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
  authRedisStub: { on: vi.fn() },
  sessionLookupSpy: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => "user-a"),
  throttleCountSpy: vi.fn<(_identity: string) => Promise<boolean>>(async () => true),
  testConfig: { throttleEnabled: true },
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

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModuleShape>()),
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
  getRedis: vi.fn(() => authRedisStub),
  getSession: sessionLookupSpy,
  sessionCookieName: () => "breatic_session_wiring-test",
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

vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  return {
    ...real,
    getCollabConfig: () => ({ ...real.getCollabConfig(), throttle_enabled: testConfig.throttleEnabled }),
  };
});

vi.mock("@collab/services/space-rpc.js", () => ({
  handleSpaceRpc: vi.fn(async (_deps: unknown, _projectId: string, _caller: unknown, req: { id: string }) => ({
    id: req.id,
    ok: true,
    result: {},
  })),
}));

vi.mock("@collab/infra/connection-gate.js", async () => {
  const real = await vi.importActual<typeof ConnectionGateModuleShape>(
    "@collab/infra/connection-gate.js",
  );
  return {
    ...real,
    createConnectionGate: ((...args: Parameters<typeof real.createConnectionGate>) => {
      vi.spyOn(args[0], "count").mockImplementation(throttleCountSpy);
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
import {
  connectLiveClient,
  createLiveServer,
  statelessFrame,
  syncFrame,
  waitFor as waitForLive,
  WIRE,
} from "./helpers/live-hocuspocus.js";
import { SOCKET_CEILINGS } from "../infra/socket-ceilings.js";

/**
 * Read the `prefix` the Redis extension was constructed with.
 * @returns The prefix string passed to the extension.
 */
function capturedPrefix(): string {
  expect(redisExtensionSpy).toHaveBeenCalledTimes(1);
  const config = redisExtensionSpy.mock.calls[0]?.[0] as { prefix: string };
  return config.prefix;
}

beforeEach(() => {
  testConfig.throttleEnabled = true;
  sessionLookupSpy.mockReset().mockResolvedValue("user-a");
});

afterEach(() => {
  testConfig.throttleEnabled = true;
});

/** The independent lifecycle exposed by a session admission extension. */
interface WiredSessionGate {
  onUpgrade: (payload: { request: IncomingMessage; socket: Duplex; head: Buffer }) => Promise<void>;
  stop: () => void;
  onDestroy: unknown;
}

/**
 * Locate the session admission extension by its approved lifecycle contract.
 * @param extensions - The extensions passed to the real server constructor boundary.
 * @returns The single session admission extension.
 */
function sessionGateFrom(extensions: unknown[]): WiredSessionGate {
  const gates = extensions.filter((extension) => {
    if (typeof extension !== "object" || extension === null) return false;
    return typeof Reflect.get(extension, "onUpgrade") === "function"
      && typeof Reflect.get(extension, "stop") === "function"
      && typeof Reflect.get(extension, "onDestroy") === "function";
  });
  expect(gates).toHaveLength(1);
  return gates[0] as WiredSessionGate;
}

describe("createCollabServer — mandatory session admission", () => {
  beforeEach(() => {
    serverSpy.mockClear();
    connectionGateSpy.mockClear();
    sessionLookupSpy.mockClear();
    throttleCountSpy.mockClear();
  });

  it.each([true, false])("registers DB0 session admission with throttle enabled=%s", async (enabled) => {
    testConfig.throttleEnabled = enabled;
    const result = await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const request = new IncomingMessage(stream as unknown as Socket);
    request.headers.cookie = "breatic_session_wiring-test=valid-session";
    let gate: WiredSessionGate | undefined;
    try {
      const config = serverSpy.mock.calls.at(-1)?.[0] as { extensions: unknown[] };
      gate = sessionGateFrom(config.extensions);
      expect(connectionGateSpy).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) {
        const connectionGate = connectionGateSpy.mock.calls[0]?.[0];
        expect(config.extensions.indexOf(gate)).toBeGreaterThan(config.extensions.indexOf(connectionGate));
      }
      await gate.onUpgrade({ request, socket: stream, head: Buffer.alloc(0) });
      expect(sessionLookupSpy).toHaveBeenCalledExactlyOnceWith(authRedisStub, "valid-session");
      const stop = Reflect.get(result, "stopUpgradeSessions");
      expect(typeof stop).toBe("function");
      stop();
      expect(stream.destroyed).toBe(false);
    } finally {
      stream.destroy();
      gate?.stop();
      result.storeLoop.stop();
      await result.seatHandover.stop();
    }
  });

  it.each([true, false])("accounts a rejected session according to throttle enabled=%s", async (enabled) => {
    testConfig.throttleEnabled = enabled;
    const result = await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const stream = Object.assign(new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } }), {
      remoteAddress: "172.18.0.4",
    });
    const request = new IncomingMessage(stream as unknown as Socket);
    request.headers["x-real-ip"] = "203.0.113.9";
    request.headers["x-breatic-connection-verdict"] = "count";
    let gate: WiredSessionGate | undefined;
    try {
      const config = serverSpy.mock.calls.at(-1)?.[0] as { extensions: unknown[] };
      gate = sessionGateFrom(config.extensions);
      const outcome = await gate.onUpgrade({ request, socket: stream, head: Buffer.alloc(0) }).then(
        () => ({ rejected: false, error: undefined }),
        (error: unknown) => ({ rejected: true, error }),
      );
      expect(outcome.rejected).toBe(true);
      expect(Boolean(outcome.error)).toBe(false);
      expect(throttleCountSpy.mock.calls).toEqual(enabled ? [["203.0.113.9"]] : []);
      expect(sessionLookupSpy).not.toHaveBeenCalled();
    } finally {
      stream.destroy();
      gate?.stop();
      result.storeLoop.stop();
      await result.seatHandover.stop();
    }
  });

  it("returns a stop function that terminates a pending request through the registered gate", async () => {
    let finishLookup!: (userId: string | null) => void;
    sessionLookupSpy.mockReturnValueOnce(new Promise<string | null>((resolve) => { finishLookup = resolve; }));
    const result = await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const request = new IncomingMessage(stream as unknown as Socket);
    request.headers.cookie = "breatic_session_wiring-test=valid-session";
    let gate: WiredSessionGate | undefined;
    try {
      const config = serverSpy.mock.calls.at(-1)?.[0] as { extensions: unknown[] };
      gate = sessionGateFrom(config.extensions);
      const watched = gate.onUpgrade({ request, socket: stream, head: Buffer.alloc(0) }).then(
        () => ({ rejected: false, error: undefined }),
        (error: unknown) => ({ rejected: true, error }),
      );
      const stop = Reflect.get(result, "stopUpgradeSessions");
      expect(typeof stop).toBe("function");
      expect(stop()).toBeUndefined();
      expect(stream.destroyed).toBe(true);
      const outcome = await watched;
      expect(outcome.rejected).toBe(true);
      expect(Boolean(outcome.error)).toBe(false);
    } finally {
      finishLookup("user-a");
      stream.destroy();
      gate?.stop();
      result.storeLoop.stop();
      await result.seatHandover.stop();
    }
  });
});

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
    expect(banner?.[0]).toMatchObject({
      ...SOCKET_CEILINGS,
      concurrentEditorsFrom: "current Studio admin membership reading: configured or negotiated concurrent_editors",
    });
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

describe("createCollabServer — content sync receipts (inner#1641)", () => {
  const PID = "11111111-1111-4111-8111-111111111111";
  const SID = "22222222-2222-4222-9222-222222222222";
  const ID = "33333333-3333-4333-8333-333333333333";
  type StatelessHook = (payload: unknown) => Promise<void>;

  /**
   * Reads the dispatcher actually installed by the production server factory.
   * @returns The configured stateless hook.
   * @throws {AssertionError} When the factory omits the dispatcher.
   */
  async function dispatcher(): Promise<StatelessHook> {
    serverSpy.mockClear();
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3", port: 1234,
      redisKeyPrefix: "test", shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls[0]?.[0] as { onStateless: StatelessHook };
    expect(typeof config.onStateless).toBe("function");
    return config.onStateless;
  }

  it.each(["canvas", "document"])("confirms only the requesting live writable %s connection", async (kind) => {
    const hook = await dispatcher();
    const connection = { readOnly: false, context: {}, sendStateless: vi.fn() };
    const broadcastStateless = vi.fn();
    await hook({
      documentName: `project-${PID}/${kind}-${SID}`,
      document: { hasConnection: (candidate: unknown): boolean => candidate === connection, broadcastStateless },
      connection, payload: JSON.stringify({ type: "sync:confirm", id: ID }),
    });
    expect(connection.sendStateless).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sync:confirmed", id: ID, ok: true }));
    expect(broadcastStateless).toHaveBeenCalledTimes(0);
  });

  it("rejects a receipt from an attached readonly connection", async () => {
    const hook = await dispatcher();
    const connection = { readOnly: true, context: {}, sendStateless: vi.fn() };
    await hook({
      documentName: `project-${PID}/canvas-${SID}`,
      document: { hasConnection: (): boolean => true },
      connection, payload: JSON.stringify({ type: "sync:confirm", id: ID }),
    });
    expect(connection.sendStateless).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "sync:confirmed", id: ID, ok: false }));
  });

  it.each([`project-${PID}/meta`, `project-${PID}/timeline-${SID}`, "invalid"])("does not confirm the non-content document %s", async (documentName) => {
    const hook = await dispatcher();
    const connection = { readOnly: false, context: {}, sendStateless: vi.fn() };
    await hook({ documentName, document: { hasConnection: (): boolean => true }, connection, payload: JSON.stringify({ type: "sync:confirm", id: ID }) });
    expect(connection.sendStateless).toHaveBeenCalledTimes(0);
  });

  it("does not confirm a connection already detached from the document", async () => {
    const hook = await dispatcher();
    const connection = { readOnly: false, context: {}, sendStateless: vi.fn() };
    await hook({ documentName: `project-${PID}/canvas-${SID}`, document: { hasConnection: (): boolean => false }, connection, payload: JSON.stringify({ type: "sync:confirm", id: ID }) });
    const successes = connection.sendStateless.mock.calls.map(([body]) => JSON.parse(String(body))).filter((body) => body.ok === true);
    expect(successes).toEqual([]);
  });

  it.each(["{", "null", JSON.stringify({ type: "sync:confirm", id: "bad" }), JSON.stringify({ type: "sync:confirm", id: ID, extra: 1 }), JSON.stringify({ type: "sync:confirmed", id: ID, ok: true })])("ignores invalid content receipt input %s", async (payload) => {
    const hook = await dispatcher();
    const connection = { readOnly: false, context: {}, sendStateless: vi.fn() };
    await hook({ documentName: `project-${PID}/canvas-${SID}`, document: { hasConnection: (): boolean => true }, connection, payload });
    expect(connection.sendStateless).toHaveBeenCalledTimes(0);
  });

  it.each(["applied", "rejected"] as const)("settles the preceding real Connection update as %s before handling its receipt", async (outcome) => {
    const hook = await dispatcher();
    const documentName = `project-${PID}/document-${SID}`;
    let releaseUpdate: (() => void) | undefined;
    let rejectUpdate: ((reason: Error) => void) | undefined;
    let updateEntered = false;
    const heldUpdate = new Promise<void>((resolve, reject) => { releaseUpdate = resolve; rejectUpdate = reject; });
    const failure = new Error("Injected preceding-update failure");
    const appliedAtReply: string[] = [];
    const server = createLiveServer({
      onAuthenticate: async (): Promise<Record<string, never>> => ({}),
      beforeHandleMessage: async (): Promise<void> => {
        updateEntered = true;
        await heldUpdate;
      },
      onStateless: async (payload: { document: Y.Doc }): Promise<void> => {
        appliedAtReply.push(payload.document.getText('body').toString());
        await hook(payload);
      },
    });
    const client = await connectLiveClient(server, documentName);
    const document = server.documents.get(documentName)!;
    const local = new Y.Doc();
    const errors = vi.spyOn(console, "error");
    try {
      local.getText('body').insert(0, 'pending content');
      client.send(syncFrame(documentName, 0, 2, Y.encodeStateAsUpdate(local)));
      client.send(statelessFrame(documentName, JSON.stringify({ type: 'sync:confirm', id: ID })));
      await waitForLive(() => updateEntered, 'the preceding update entered the real queue');
      expect(appliedAtReply).toEqual([]);
      expect(client.frames().filter((frame) => frame.stateless !== undefined)).toEqual([]);
      if (outcome === "rejected") {
        rejectUpdate?.(failure);
        await waitForLive(() => client.frames().some((frame) => frame.type === WIRE.close || frame.stateless !== undefined), 'the failed update reached a close or receipt outcome');
        expect(client.frames().filter((frame) => frame.stateless !== undefined)).toEqual([]);
        expect(client.frames().filter((frame) => frame.type === WIRE.close).map((frame) => frame.docName)).toEqual([documentName]);
        expect(document.getText('body').toString()).toBe('');
        expect(document.getConnectionsCount()).toBe(0);
        expect(appliedAtReply).toEqual([]);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining('closing connection'), failure);
        return;
      }
      releaseUpdate?.();
      await waitForLive(() => appliedAtReply.length === 1, 'the confirmation entered the real dispatcher');
      expect(appliedAtReply).toEqual(['pending content']);
      await waitForLive(() => client.frames().some((frame) => frame.stateless !== undefined), 'the production sync confirmation reply');
      expect(client.frames().filter((frame) => frame.stateless !== undefined).map((frame) => JSON.parse(frame.stateless!))).toEqual([{ type: 'sync:confirmed', id: ID, ok: true }]);
    } finally {
      releaseUpdate?.();
      client.close();
      local.destroy();
      errors.mockRestore();
    }
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
