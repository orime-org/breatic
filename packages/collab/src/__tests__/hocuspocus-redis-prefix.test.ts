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
import { EventEmitter } from "node:events";
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
  loggerWarnSpy,
  authRedisStub,
  sessionLookupSpy,
  throttleCountSpy,
  testConfig,
} = vi.hoisted(() => ({
  connectionGateSpy: vi.fn(),
  failedAuthWrapperSpy: vi.fn(),
  loggerInfoSpy: vi.fn(),
  loggerWarnSpy: vi.fn(),
  redisExtensionSpy: vi.fn(),
  serverSpy: vi.fn(),
  registryStub: {
    start: vi.fn(),
    stop: vi.fn(),
    unregister: vi.fn(async () => undefined),
    count: vi.fn(async () => 0),
    takeSeat: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ outcome: "seated" })),
    hasOwnSeat: vi.fn(async (..._args: unknown[]): Promise<unknown> => "no"),
    refreshSocket: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
    forgetSeat: vi.fn(async () => undefined),
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
    warn: loggerWarnSpy,
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
import { OutgoingMessage } from "@hocuspocus/server";

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

describe("createCollabServer — the connected hook takes the seat (inner#1034)", () => {
  const PID = "11111111-1111-4111-8111-111111111111";
  const DOC = `project-${PID}/canvas-22222222-2222-4222-9222-222222222222`;
  const META = `project-${PID}/meta`;

  beforeEach(() => {
    serverSpy.mockClear();
    registryStub.takeSeat.mockReset().mockResolvedValue({ outcome: "seated" });
    registryStub.unregister.mockClear();
    collabRedisStub.publish.mockClear();
    loggerWarnSpy.mockClear();
    // The two re-reads `connected` makes after the seat agree with the
    // handshake, so nothing here is closed for an unrelated reason.
    loadProjectRoleStub.mockReset().mockResolvedValue("editor");
    sessionLookupSpy.mockResolvedValue("u1");
  });

  /** A connection stand-in whose socket emits and records what it sends. */
  type FakeConnection = {
    readOnly: boolean;
    close: ReturnType<typeof vi.fn>;
    context: Record<string, unknown>;
    document: Y.Doc;
    webSocket: EventEmitter & { send: ReturnType<typeof vi.fn> };
  };

  /**
   * Build the server, and run its `connected` hook the way Hocuspocus would.
   * @param args - What the handshake settled.
   * @param args.documentName - Document the connection opened.
   * @param args.seatCap - The ceiling the handshake judged by, null for no seat.
   * @returns The connection, the hooks and the running hook's promise.
   */
  async function startConnected(args: { documentName?: string; seatCap?: number | null } = {}): Promise<{
    connection: FakeConnection;
    running: Promise<void> | undefined;
    onDisconnect: (payload: unknown) => Promise<void>;
  }> {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls.at(-1)?.[0] as {
      connected?: (payload: unknown) => Promise<void>;
      onDisconnect: (payload: unknown) => Promise<void>;
    };
    expect(typeof config.connected).toBe("function");
    const documentName = args.documentName ?? DOC;
    const context = {
      user: { id: "u1", role: "editor" },
      seatCap: args.seatCap === undefined ? 2 : args.seatCap,
      arrivedAtMs: 4242,
      session: { token: "tok", id: "tok-id" },
    };
    const connection: FakeConnection = {
      readOnly: false,
      close: vi.fn(),
      context,
      document: new Y.Doc(),
      webSocket: Object.assign(new EventEmitter(), { send: vi.fn() }),
    };
    loggerWarnSpy.mockClear();
    const running = config.connected?.({
      documentName,
      socketId: "sock-1",
      context,
      instance: { documents: new Map() },
      connectionConfig: { readOnly: false },
      connection,
    });
    return { connection, running, onDisconnect: config.onDisconnect };
  }

  /**
   * Whether a warn carrying this tag was logged.
   * @param tag - The log tag.
   * @returns The logged fields, when one was.
   */
  function warnFields(tag: string): Record<string, unknown> | undefined {
    const call = loggerWarnSpy.mock.calls.find(([fields, message]) =>
      message === tag || (fields as { tag?: unknown; reason?: unknown } | undefined)?.tag === tag
      || (fields as { reason?: unknown } | undefined)?.reason === tag,
    );
    return call?.[0] as Record<string, unknown> | undefined;
  }

  const readOnlyFrame = (documentName: string): Uint8Array =>
    new OutgoingMessage(documentName).writeAuthenticated(true).toUint8Array();

  it("E-C01 takes no seat for a connection the handshake gave no ceiling", async () => {
    const { connection, running } = await startConnected({ seatCap: null });
    await running;
    expect(registryStub.takeSeat).not.toHaveBeenCalled();
    expect(collabRedisStub.publish).not.toHaveBeenCalled();
    expect(connection.webSocket.send).not.toHaveBeenCalled();
    expect(connection.readOnly).toBe(false);
  });

  it("E-C02 takes the seat with the handshake's ceiling and arrival moment, and does nothing more when seated", async () => {
    const { connection, running } = await startConnected();
    await running;
    expect(registryStub.takeSeat).toHaveBeenCalledTimes(1);
    expect(registryStub.takeSeat).toHaveBeenCalledWith(DOC, { socketId: "sock-1", userId: "u1", arrivedAtMs: 4242 }, 2);
    expect(collabRedisStub.publish).not.toHaveBeenCalled();
    expect(connection.webSocket.send).not.toHaveBeenCalled();
    expect(connection.readOnly).toBe(false);
  });

  it("E-C03 asks for the replaced connection to be demoted and stays writable", async () => {
    registryStub.takeSeat.mockResolvedValueOnce({ outcome: "replaced", replaced: "u1:1000:i2:sx" });
    const { connection, running } = await startConnected();
    await running;
    expect(collabRedisStub.publish).toHaveBeenCalledTimes(1);
    expect(collabRedisStub.publish).toHaveBeenCalledWith(
      "dev:collab:seat-demote",
      JSON.stringify({ documentName: DOC, member: "u1:1000:i2:sx" }),
    );
    expect(connection.readOnly).toBe(false);
  });

  it("E-C04 stays writable until the answer, then goes read-only when the race for the last seat was lost", async () => {
    let answer!: (value: unknown) => void;
    registryStub.takeSeat.mockReturnValueOnce(new Promise((resolve) => {
      answer = resolve;
    }));
    const { connection, running } = await startConnected();
    await vi.waitFor(() => expect(registryStub.takeSeat).toHaveBeenCalledTimes(1));
    expect(connection.readOnly).toBe(false);
    expect(connection.webSocket.send).not.toHaveBeenCalled();

    answer({ outcome: "full", liveCount: 2 });
    await running;

    expect(connection.readOnly).toBe(true);
    expect(connection.webSocket.send).toHaveBeenCalledTimes(1);
    expect(connection.webSocket.send.mock.calls[0]![0]).toEqual(readOnlyFrame(DOC));
    expect(warnFields("connection_cap_race_degraded")).toEqual(
      expect.objectContaining({ socketId: "sock-1", userId: "u1", documentName: DOC, projectId: PID, liveCount: 2, cap: 2 }),
    );
    expect(warnFields("connection_cap_degraded")).toBeUndefined();
    expect(collabRedisStub.publish).not.toHaveBeenCalled();
  });

  // The registry logs a failed script once; the hook does not
  // log it again.
  it("E-C05 lets the connection write on when Redis could not answer", async () => {
    registryStub.takeSeat.mockResolvedValueOnce({ outcome: "unknown" });
    const { connection, running } = await startConnected();
    await running;
    expect(connection.readOnly).toBe(false);
    expect(connection.webSocket.send).not.toHaveBeenCalled();
    expect(collabRedisStub.publish).not.toHaveBeenCalled();
    expect(warnFields("conn_registry_take_failed")).toBeUndefined();
  });

  it("E-C06 does nothing when the connection left or was demoted before the answer", async () => {
    registryStub.takeSeat.mockResolvedValueOnce({ outcome: "gone" });
    const { connection, running } = await startConnected();
    await running;
    expect(connection.readOnly).toBe(false);
    expect(connection.webSocket.send).not.toHaveBeenCalled();
    expect(collabRedisStub.publish).not.toHaveBeenCalled();
    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it("E-C07 releases the seat of a content document on disconnect, and never asks for the meta document", async () => {
    const { running, onDisconnect } = await startConnected();
    await running;
    await onDisconnect({ documentName: DOC, context: { user: { id: "u1" } }, socketId: "sock-1" });
    expect(registryStub.unregister).toHaveBeenCalledWith(DOC, "sock-1");
    registryStub.unregister.mockClear();
    await onDisconnect({ documentName: META, context: { user: { id: "u1" } }, socketId: "sock-1" });
    expect(registryStub.unregister).not.toHaveBeenCalled();
  });

  describe("one connection per document on a socket", () => {
    /** The hooks of one server, and a way to run `connected` on it. */
    async function serverHooks(): Promise<{
      connect: (context: Record<string, unknown>) => Promise<FakeConnection>;
      onDisconnect: (payload: unknown) => Promise<void>;
    }> {
      await createCollabServer({
        collabRedisUrl: "redis://localhost:6379/3",
        port: 1234,
        redisKeyPrefix: "dev",
        shutdownDeadline: () => undefined,
      });
      const config = serverSpy.mock.calls.at(-1)?.[0] as {
        connected: (payload: unknown) => Promise<void>;
        onDisconnect: (payload: unknown) => Promise<void>;
      };
      // Both connections ride the one socket.
      const webSocket = Object.assign(new EventEmitter(), { send: vi.fn() });
      return {
        async connect(context): Promise<FakeConnection> {
          const connection: FakeConnection = { readOnly: false, close: vi.fn(), context, document: new Y.Doc(), webSocket };
          await config.connected({
            documentName: DOC,
            socketId: "sock-1",
            context,
            instance: { documents: new Map() },
            connectionConfig: { readOnly: false },
            connection,
          });
          return connection;
        },
        onDisconnect: config.onDisconnect,
      };
    }

    /**
     * A handshake's context for this document.
     * @param arrivedAtMs - When it began.
     * @returns The context.
     */
    const contextAt = (arrivedAtMs: number): Record<string, unknown> => ({
      user: { id: "u1", role: "editor" },
      seatCap: 2,
      arrivedAtMs,
      session: { token: "tok", id: "tok-id" },
    });

    it("refuses a second connection for a document the socket already carries, and its close leaves the first one's seat alone", async () => {
      const { connect, onDisconnect } = await serverHooks();
      const first = await connect(contextAt(1000));
      loggerWarnSpy.mockClear();
      const secondContext = contextAt(2000);
      const second = await connect(secondContext);

      expect(second.close).toHaveBeenCalledTimes(1);
      expect(first.close).not.toHaveBeenCalled();
      expect(registryStub.takeSeat).toHaveBeenCalledTimes(1);
      expect(warnFields("duplicate_document_on_socket")).toEqual(
        expect.objectContaining({ userId: "u1", documentName: DOC, socketId: "sock-1" }),
      );
      expect(loggerWarnSpy.mock.calls.find(([, message]) => message === "auth_rejected")).toBeDefined();

      // The framework reports the refused connection's end like any other.
      await onDisconnect({ documentName: DOC, context: secondContext, socketId: "sock-1" });
      expect(registryStub.unregister).not.toHaveBeenCalled();
    });

    it("accepts the document again on that socket once the previous connection has closed", async () => {
      const { connect, onDisconnect } = await serverHooks();
      const firstContext = contextAt(1000);
      await connect(firstContext);
      await onDisconnect({ documentName: DOC, context: firstContext, socketId: "sock-1" });
      loggerWarnSpy.mockClear();

      const again = await connect(contextAt(2000));

      expect(again.close).not.toHaveBeenCalled();
      expect(registryStub.takeSeat).toHaveBeenCalledTimes(2);
      expect(warnFields("duplicate_document_on_socket")).toBeUndefined();
    });
  });

  describe("what a pong's renewal answers, through the real per-socket listener", () => {
    beforeEach(() => {
      registryStub.refreshSocket.mockReset().mockResolvedValue([]);
    });

    /**
     * Connect, then fire one pong on the connection's socket.
     * @param answer - What the renewal reports for this document.
     * @returns The connection.
     */
    async function pongAnswering(answer: Record<string, unknown>): Promise<FakeConnection> {
      const { connection, running } = await startConnected();
      await running;
      registryStub.refreshSocket.mockResolvedValueOnce([{ documentName: DOC, member: "u1:4242:i1:sock-1", ...answer }]);
      connection.webSocket.emit("pong");
      await vi.waitFor(() => expect(registryStub.refreshSocket).toHaveBeenCalledWith("sock-1"));
      for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return connection;
    }

    it("E-P07 asks the demote channel the server built to demote the replaced connection", async () => {
      const connection = await pongAnswering({ outcome: "replaced", replaced: "u1:1000:i2:sx" });
      expect(collabRedisStub.publish).toHaveBeenCalledWith(
        "dev:collab:seat-demote",
        JSON.stringify({ documentName: DOC, member: "u1:1000:i2:sx" }),
      );
      expect(connection.readOnly).toBe(false);
    });

    it("E-P08 makes the connection read-only when its retried arrival found the document full", async () => {
      const connection = await pongAnswering({ outcome: "full", liveCount: 2, cap: 2 });
      expect(connection.readOnly).toBe(true);
      expect(connection.webSocket.send).toHaveBeenCalledTimes(1);
      expect(connection.webSocket.send.mock.calls[0]![0]).toEqual(readOnlyFrame(DOC));
      expect(warnFields("connection_cap_race_degraded")).toEqual({
        socketId: "sock-1", userId: "u1", documentName: DOC, projectId: PID, liveCount: 2, cap: 2, reason: "connection_cap_race_degraded",
      });
    });

    it("E-P09 makes the connection read-only when its seat was lost", async () => {
      const connection = await pongAnswering({ outcome: "lost", liveCount: 2, cap: 2 });
      expect(connection.readOnly).toBe(true);
      expect(connection.webSocket.send).toHaveBeenCalledTimes(1);
      expect(connection.webSocket.send.mock.calls[0]![0]).toEqual(readOnlyFrame(DOC));
      expect(warnFields("connection_seat_lost")).toEqual({
        socketId: "sock-1", userId: "u1", documentName: DOC, projectId: PID, liveCount: 2, cap: 2, reason: "connection_seat_lost",
      });
    });
  });

  // E-A10's wiring half: the handshake the server installs counts and asks,
  // and never takes a seat — a connection whose document then fails to load
  // never reaches `connected`, so it must hold nothing.
  it("E-A10 authenticates without taking a seat, asking the registry whether the person holds one", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls.at(-1)?.[0] as { onAuthenticate: (payload: unknown) => Promise<unknown> };
    const meta = new Y.Doc();
    const space = new Y.Map();
    meta.getMap("spaces").set("22222222-2222-4222-9222-222222222222", space);
    space.set("id", "22222222-2222-4222-9222-222222222222");
    space.set("type", "canvas");
    registryStub.count.mockResolvedValueOnce(100);
    registryStub.hasOwnSeat.mockReset().mockResolvedValueOnce("yes");
    const connectionConfig = { readOnly: false };

    const ctx = (await config.onAuthenticate({
      token: "__cookie_auth__",
      documentName: DOC,
      requestHeaders: new Headers({ cookie: "breatic_session_wiring-test=tok" }),
      connectionConfig,
      instance: { documents: new Map([[META, meta]]), createDocument: vi.fn(), unloadDocument: vi.fn() },
      request: new Request("http://localhost/"),
      socketId: "sock-1",
    })) as { seatCap: number | null };

    expect(registryStub.hasOwnSeat).toHaveBeenCalledWith(DOC, "u1");
    expect(registryStub.takeSeat).not.toHaveBeenCalled();
    expect(connectionConfig.readOnly).toBe(false);
    expect(ctx.seatCap).toBe(100);
    meta.destroy();
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
   * @returns The captured pong listener.
   */
  async function fireConnectedFor(args: {
    documentName: string;
    document: Y.Doc;
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
      context: { user: { id: "u-1" }, seatCap: args.documentName.endsWith("/meta") ? null : 2, arrivedAtMs: 1000 },
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
      context: { user: { id: "u-1", role: "editor" }, seatCap: 2, arrivedAtMs: 1000 },
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

describe("createCollabServer — frame reassembly wiring (inner#1585)", () => {
  /** The reassembly hooks and options handed to the server. */
  interface FrameWiring {
    websocketOptions?: { maxPayload?: number };
    receiveFrame?: (peer: unknown, message: unknown) => Uint8Array | undefined;
    onPeerClose?: (peer: unknown, event: unknown) => void;
    onPeerError?: (peer: unknown, error: unknown) => void;
    extensions: unknown[];
  }

  let nextPeer = 0;

  /**
   * A crossws peer as the reassembler sees it.
   * @param nodeReq - The upgrade request it belongs to.
   * @returns The peer.
   */
  function fakePeer(nodeReq: object = {}): { close: ReturnType<typeof vi.fn> } {
    const n = ++nextPeer;
    return { id: `w${n}`, remoteAddress: `10.1.0.${n}`, _hocuspocus: { socketId: `ws-${n}` }, _internal: { nodeReq }, close: vi.fn(), send: vi.fn() } as never;
  }

  /**
   * A declaration text frame.
   * @param bytes - Declared bytes.
   * @returns The message.
   */
  function declaration(bytes: number): unknown {
    const s = JSON.stringify({ type: "chunked", bytes });
    return { rawData: s, text: () => s, uint8Array: () => new TextEncoder().encode(s) };
  }

  /**
   * Build the server and return what it handed to `Server`.
   * @returns The wiring and a cleanup.
   */
  async function wired(): Promise<{ config: FrameWiring; done: () => Promise<void> }> {
    serverSpy.mockClear();
    const result = await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev",
      shutdownDeadline: () => undefined,
    });
    const config = serverSpy.mock.calls.at(-1)?.[0] as FrameWiring;
    return {
      config,
      done: async () => {
        sessionGateFrom(config.extensions).stop();
        result.storeLoop.stop();
        await result.seatHandover.stop();
      },
    };
  }

  it("W01 caps a single frame at the shared constant", async () => {
    const { COLLAB_FRAME_MAX_BYTES } = await import("@breatic/shared");
    const { config, done } = await wired();
    try {
      expect(config.websocketOptions?.maxPayload).toBe(131_072);
      expect(config.websocketOptions?.maxPayload).toBe(COLLAB_FRAME_MAX_BYTES);
    } finally {
      await done();
    }
  });

  it("W02 wires a reassembler built with the per-connection cap from the shipped config", async () => {
    const { config, done } = await wired();
    try {
      expect(config.receiveFrame).toBeTypeOf("function");
      expect(config.onPeerClose).toBeTypeOf("function");
      expect(config.onPeerError).toBeTypeOf("function");
      const over = fakePeer();
      const at = fakePeer();
      config.receiveFrame!(over, declaration(10_551_297));
      expect(over.close).toHaveBeenCalledWith(1009, "message too large");
      expect(config.receiveFrame!(at, declaration(10_551_296))).toBeUndefined();
      expect(at.close).not.toHaveBeenCalled();
      config.onPeerClose!(at, { code: 1000, reason: "" });
    } finally {
      await done();
    }
  });

  it("W03 wires the shipped process budget", async () => {
    const { config, done } = await wired();
    try {
      const peers = Array.from({ length: 7 }, () => fakePeer());
      for (const p of peers) config.receiveFrame!(p, declaration(10_551_296));
      for (const p of peers.slice(0, 6)) expect(p.close).not.toHaveBeenCalled();
      expect(peers[6]!.close).toHaveBeenCalledWith(1013, "reassembly budget exhausted");
      for (const p of peers) config.onPeerClose!(p, { code: 1000, reason: "" });
    } finally {
      await done();
    }
  });

  it("W04 wires the shipped idle timeout", async () => {
    const { config, done } = await wired();
    vi.useFakeTimers();
    try {
      const p = fakePeer();
      config.receiveFrame!(p, declaration(131_073));
      vi.advanceTimersByTime(29_999);
      expect(p.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(p.close).toHaveBeenCalledWith(1008, "reassembly idle timeout");
    } finally {
      vi.useRealTimers();
      await done();
    }
  });

  it("W05 keys the per-user share by the session gate's user", async () => {
    const { config, done } = await wired();
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const request = new IncomingMessage(stream as unknown as Socket);
    request.headers.cookie = "breatic_session_wiring-test=valid-session";
    try {
      await sessionGateFrom(config.extensions).onUpgrade({ request, socket: stream, head: Buffer.alloc(0) });
      const first = fakePeer(request);
      const second = fakePeer(request);
      config.receiveFrame!(first, declaration(10_551_296));
      config.receiveFrame!(second, declaration(10_551_296));
      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledWith(1013, "reassembly budget exhausted");
      config.onPeerClose!(first, { code: 1000, reason: "" });
      config.onPeerClose!(second, { code: 1000, reason: "" });
    } finally {
      stream.destroy();
      await done();
    }
  });
});
