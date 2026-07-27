// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * members-sync subscriber tests.
 *
 * Covers the only branch left after PR-b — `members:changed` (Space
 * lifecycle moved to collab stateless RPC; see ADR 2026-05-23
 * yjs-collab-only-write-authz). The handler:
 *
 *   - kicks the affected user's project ws connections
 *   - broadcasts a stateless invalidate signal on the meta doc
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
  membersChangedChannel,
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
  connections: Map<string, { connection: { context: unknown; close: ReturnType<typeof vi.fn> } }>;
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
  it("kicks the affected user's connections to the project, then broadcasts stateless", async () => {
    const closeSpy = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      connections: new Map(),
    };
    metaDoc.connections.set("conn-1", {
      connection: {
        context: { user: { id: "victim" } },
        close: closeSpy,
      },
    });
    // Bystander on the same project — should NOT be kicked.
    metaDoc.connections.set("conn-2", {
      connection: {
        context: { user: { id: "other" } },
        close: vi.fn(),
      },
    });

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
    expect(metaDoc.broadcastStateless).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("on owner-transfer ('all') kicks both fromUserId and toUserId", async () => {
    const fromClose = vi.fn();
    const toClose = vi.fn();
    const metaDoc: DocSpy = {
      doc: new Y.Doc(),
      broadcastStateless: vi.fn(),
      connections: new Map([
        ["c1", { connection: { context: { user: { id: "from" } }, close: fromClose } }],
        ["c2", { connection: { context: { user: { id: "to" } }, close: toClose } }],
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
    expect(metaDoc.broadcastStateless).toHaveBeenCalledWith(JSON.stringify(event));
  });
});
