// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project control-plane subscriber tests.
 *
 * Every collab instance receives each control event, so each one sends the
 * resulting signal only to its own connections (`relayStateless`): a
 * `broadcastStateless` would go through the Redis extension to the other
 * instances too, and each client would get one copy per instance (inner#1497 §6.5).
 *
 *   - `activity:new` relays the activity signal on the meta doc
 *   - `connections:close` closes every connection of the project
 *
 * Mocks ioredis pub/sub via a thin EventEmitter so we can drive
 * `pmessage` events synchronously, and stubs Hocuspocus to capture
 * doc / connection interactions.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import type { Redis } from "@breatic/core";
import type { Hocuspocus } from "@hocuspocus/server";
import {
  activityNewChannel,
  CREDITS_CHANGED_SIGNAL,
  creditsChangedChannel,
  projectConnectionsCloseChannel,
} from "@breatic/shared";

// The deployment prefix under test. `vi.hoisted` because the `vi.mock` factory
// below is hoisted above these lines and would otherwise capture it undefined.
const { TEST_PREFIX } = vi.hoisted(() => ({ TEST_PREFIX: "test-deploy" }));

// `createLogger` now comes from `@breatic/core` (the unified logger), which
// reads the injected config at call time. Spread the real core barrel and
// override only `createLogger` with a no-op stub so the module-level
// `createLogger("project-control-sync")` doesn't require initCore under test.
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    // The subscriber takes its PSUBSCRIBE pattern from core (the single
    // place the deployment prefix is injected), so the stub must agree with
    // the prefix the emitted channels below are built with.
    projectControlChannelPattern: () => `${TEST_PREFIX}:project:*`,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

import { startProjectControlSync } from "../services/project-control-sync.js";

type FakeRedis = EventEmitter & {
  duplicate: () => FakeRedis;
  psubscribe: ReturnType<typeof vi.fn>;
  punsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

function buildRedis(): { source: FakeRedis; subscriber: FakeRedis } {
  const subscriber = Object.assign(new EventEmitter(), {
    psubscribe: vi.fn((_pattern: string, cb?: (err: Error | null) => void) => {
      cb?.(null);
    }),
    punsubscribe: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  }) as FakeRedis;
  // duplicate() returns the subscriber so all event-emitter handlers
  // attach to the same instance the tests publish to.
  subscriber.duplicate = () => subscriber;

  const source = subscriber; // the subscriber immediately .duplicate()s
  return { source, subscriber };
}

const PID = "11111111-1111-4111-8111-111111111111";

interface DocSpy {
  doc: Y.Doc;
  broadcastStateless: ReturnType<typeof vi.fn>;
  relayStateless: ReturnType<typeof vi.fn>;
  // Connection as the KEY, matching the real Document (the value only carries
  // the set of client ids, which nothing on this path reads).
  connections: Map<
    { context: unknown; close: ReturnType<typeof vi.fn> },
    { clients: Set<number> }
  >;
}

function buildHocuspocus(metaDoc?: DocSpy): { hocuspocus: Hocuspocus } {
  const documents = new Map<string, DocSpy>();
  if (metaDoc) {
    documents.set(`project-${PID}/meta`, metaDoc);
  }

  const hocuspocus = {
    documents,
  } as unknown as Hocuspocus;

  return { hocuspocus };
}

describe("startProjectControlSync — activity:new", () => {
  it("relays the activity signal to this instance's connections only", async () => {
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map(),
    };
    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    startProjectControlSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      activityNewChannel(TEST_PREFIX, PID),
      JSON.stringify({ type: "project-activity:new", projectId: PID, ts: Date.now() }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(metaDoc.relayStateless).toHaveBeenCalledTimes(1);
    expect(metaDoc.broadcastStateless).not.toHaveBeenCalled();
  });
});

describe("startProjectControlSync — credits:changed", () => {
  it("relays the credits signal on the project's meta doc", async () => {
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map(),
    };
    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    startProjectControlSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      creditsChangedChannel(TEST_PREFIX, PID),
      JSON.stringify({ type: "project-credits:changed", projectId: PID, ts: Date.now() }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(metaDoc.relayStateless).toHaveBeenCalledWith(
      JSON.stringify({ t: CREDITS_CHANGED_SIGNAL, projectId: PID }),
    );
  });
});

describe("startProjectControlSync — connections:close", () => {
  it("closes every connection this instance holds on the project with the event's reason", async () => {
    const close = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map([[{ context: { user: { id: "anyone" } }, close }, { clients: new Set<number>() }]]),
    };
    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    startProjectControlSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      projectConnectionsCloseChannel(TEST_PREFIX, PID),
      JSON.stringify({ type: "project-connections:close", projectId: PID, reason: "archived", ts: Date.now() }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledWith({ code: 4407, reason: "Project archived" });
  });
});

describe("startProjectControlSync — a control event it cannot act on", () => {
  it("leaves connections alone and does not reject when the close reason is unknown", async () => {
    const close = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map([[{ context: { user: { id: "anyone" } }, close }, { clients: new Set<number>() }]]),
    };
    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    startProjectControlSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      projectConnectionsCloseChannel(TEST_PREFIX, PID),
      JSON.stringify({ type: "project-connections:close", projectId: PID, reason: "something-new", ts: Date.now() }),
    );
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", onRejection);

    expect(close).not.toHaveBeenCalled();
    expect(rejections).toEqual([]);
  });
});
