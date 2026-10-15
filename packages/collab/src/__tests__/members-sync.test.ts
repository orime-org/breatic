// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * members-sync subscriber tests.
 *
 * Every collab instance receives each control event, so each one sends the
 * resulting signal only to its own connections (`relayStateless`): a
 * `broadcastStateless` would go through the Redis extension to the other
 * instances too, and each client would get one copy per instance (inner#1497 §6.5).
 *
 *   - `members:changed` kicks the affected user's project ws connections and
 *     relays a stateless invalidate signal on the meta doc
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
  membersChangedChannel,
  projectConnectionsCloseChannel,
  type MembersChangedEvent,
} from "@breatic/shared";

// The deployment prefix under test. `vi.hoisted` because the `vi.mock` factory
// below is hoisted above these lines and would otherwise capture it undefined.
const { TEST_PREFIX } = vi.hoisted(() => ({ TEST_PREFIX: "test-deploy" }));

// `createLogger` now comes from `@breatic/core` (the unified logger), which
// reads the injected config at call time. Spread the real core barrel and
// override only `createLogger` with a no-op stub so the module-level
// `createLogger("members-sync")` doesn't require initCore under test.
vi.mock("@breatic/core", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    // members-sync now takes its PSUBSCRIBE pattern from core (the single
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

import { startMembersSync } from "../services/members-sync.js";

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

  const source = subscriber; // members-sync immediately .duplicate()s
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

describe("startMembersSync — members:changed", () => {
  it("kicks the affected user's connections to the project, then relays stateless to this instance only", async () => {
    const closeSpy = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map(),
    };
    // The connection is the map KEY (v4 shape); the value only carries the
    // set of client ids, which this path never reads.
    metaDoc.connections.set(
      { context: { user: { id: "victim" } }, close: closeSpy },
      { clients: new Set() },
    );
    // Bystander on the same project — should NOT be kicked.
    metaDoc.connections.set(
      { context: { user: { id: "other" } }, close: vi.fn() },
      { clients: new Set() },
    );

    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();

    // Cast: FakeRedis only stubs the surface members-sync touches
    // (duplicate / psubscribe / punsubscribe / quit / EventEmitter
    // pmessage handler). The full ioredis Redis type has 350+ other
    // members irrelevant to this test.
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
    // Allow psubscribe callback (sync in our fake) to run.
    await Promise.resolve();

    const event: MembersChangedEvent = {
      type: "project-members:changed",
      projectId: PID,
      affectedUserId: "victim",
      action: "remove",
      ts: Date.now(),
    };
    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      membersChangedChannel(TEST_PREFIX, PID),
      JSON.stringify(event),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(closeSpy).toHaveBeenCalledWith({
      code: 4403,
      reason: expect.stringContaining("Permission changed"),
    });
    expect(metaDoc.relayStateless).toHaveBeenCalledWith(JSON.stringify(event));
    expect(metaDoc.broadcastStateless).not.toHaveBeenCalled();
  });

  it("on owner-transfer ('all') kicks both fromUserId and toUserId", async () => {
    const fromClose = vi.fn();
    const toClose = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map([
        [{ context: { user: { id: "from" } }, close: fromClose }, { clients: new Set<number>() }],
        [{ context: { user: { id: "to" } }, close: toClose }, { clients: new Set<number>() }],
      ]),
    };

    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    const event: MembersChangedEvent = {
      type: "project-members:changed",
      projectId: PID,
      affectedUserId: "all",
      action: "owner-transfer",
      fromUserId: "from",
      toUserId: "to",
      ts: Date.now(),
    };
    subscriber.emit(
      "pmessage",
      `${TEST_PREFIX}:project:*`,
      membersChangedChannel(TEST_PREFIX, PID),
      JSON.stringify(event),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fromClose).toHaveBeenCalled();
    expect(toClose).toHaveBeenCalled();
    expect(metaDoc.relayStateless).toHaveBeenCalledWith(JSON.stringify(event));
    expect(metaDoc.broadcastStateless).not.toHaveBeenCalled();
  });
});

describe("startMembersSync — activity:new", () => {
  it("relays the activity signal to this instance's connections only", async () => {
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      relayStateless: vi.fn(),
      connections: new Map(),
    };
    const { hocuspocus } = buildHocuspocus(metaDoc);
    const { subscriber } = buildRedis();
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
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

describe("startMembersSync — connections:close", () => {
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
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
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

describe("startMembersSync — a control event it cannot act on", () => {
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
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
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
