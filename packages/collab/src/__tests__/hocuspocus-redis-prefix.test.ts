// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * Everything that would open a socket or a timer is mocked; the YAML config
 * is read for real (it is a pure file read).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { redisExtensionSpy, serverSpy } = vi.hoisted(() => ({
  redisExtensionSpy: vi.fn(),
  serverSpy: vi.fn(),
}));

vi.mock("@hocuspocus/extension-redis", () => ({
  Redis: class {
    constructor(config: unknown) {
      redisExtensionSpy(config);
    }
  },
}));

vi.mock("@hocuspocus/server", () => ({
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@breatic/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  createRedisClient: vi.fn(() => ({ on: vi.fn() })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
}));

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    count: vi.fn(async () => 0),
  })),
}));

vi.mock("@collab/services/handling-sweeper.js", () => ({
  createHandlingSweeper: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  scheduleLoadSweep: vi.fn(),
  resolveLeaseBudget: vi.fn(() => 3_600_000),
}));

import { createCollabServer } from "../hocuspocus.js";
import { getCollabConfig } from "../config.js";
import { socketCeilings } from "../infra/socket-ceilings.js";

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
    });

    expect(capturedPrefix()).toBe("dev:hocuspocus");
  });

  it("carries a per-deployment prefix through instead of hard-coding one", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/7",
      port: 1234,
      redisKeyPrefix: "dev-agent",
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
    });

    const config = serverSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(config).toMatchObject({
      // Both ceilings that close a whole socket, derived from one number.
      ...socketCeilings(getCollabConfig().max_documents_per_socket),
      // Broadcast on apply rather than coalescing per event-loop turn. The
      // library's own default is `0`, which batches; the Space RPC commit
      // boundary is built on the broadcast being the synchronous, observable
      // commit point, and `broadcastStateless` is never batched, so batching
      // would also let the activity signal overtake the change it announces.
      flushDelay: false,
    });
  });

  it("never uses the Redis URL as the prefix", async () => {
    await createCollabServer({
      collabRedisUrl: "redis://localhost:6379/3",
      port: 1234,
      redisKeyPrefix: "dev-studio",
    });

    expect(capturedPrefix()).not.toContain("redis://");
    expect(capturedPrefix()).toBe("dev-studio:hocuspocus");
  });
});
