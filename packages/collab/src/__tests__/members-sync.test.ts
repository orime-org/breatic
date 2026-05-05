/**
 * members-sync subscriber tests.
 *
 * The subscriber wires three branches:
 *
 *   - `members:changed`    → kick affected user's project ws + broadcast
 *                            stateless invalidate signal
 *   - `space:created`      → meta.spaces[id] = {...} (Y.Map.set)
 *   - `space:deleted`      → meta.spaces.delete(id)
 *
 * Mocks ioredis pub/sub via a thin EventEmitter so we can drive
 * `pmessage` events synchronously, and stubs Hocuspocus to capture
 * doc / connection interactions.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import * as Y from "yjs";
import type Redis from "ioredis";
import type { Hocuspocus } from "@hocuspocus/server";
import {
  membersChangedChannel,
  spaceCreatedChannel,
  spaceDeletedChannel,
  type MembersChangedEvent,
  type SpaceCreatedEvent,
  type SpaceDeletedEvent,
} from "@breatic/shared";
import { startMembersSync } from "../members-sync.js";

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
const SID = "22222222-2222-4222-9222-222222222222";

interface DocSpy {
  doc: Y.Doc;
  broadcastStateless: ReturnType<typeof vi.fn>;
  connections: Map<string, { connection: { context: unknown; close: ReturnType<typeof vi.fn> } }>;
}

function buildHocuspocus(metaDoc?: DocSpy): {
  hocuspocus: Hocuspocus;
  applied: { metaDoc: Y.Doc | null };
  disconnectSpy: ReturnType<typeof vi.fn>;
  openSpy: ReturnType<typeof vi.fn>;
} {
  const applied = { metaDoc: null as Y.Doc | null };
  const disconnectSpy = vi.fn(async () => undefined);
  const openSpy = vi.fn(async () => {
    const doc = new Y.Doc();
    applied.metaDoc = doc;
    return {
      transact: async (cb: (doc: Y.Doc) => void) => {
        cb(doc);
      },
      disconnect: disconnectSpy,
    };
  });

  const documents = new Map<string, DocSpy>();
  if (metaDoc) {
    documents.set(`project-${PID}/meta`, metaDoc);
  }

  const hocuspocus = {
    documents,
    openDirectConnection: openSpy,
  } as unknown as Hocuspocus;

  return { hocuspocus, applied, disconnectSpy, openSpy };
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
      "project:*",
      membersChangedChannel(PID),
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
    // Cast: FakeRedis only stubs the surface members-sync touches
    // (duplicate / psubscribe / punsubscribe / quit / EventEmitter
    // pmessage handler). The full ioredis Redis type has 350+ other
    // members irrelevant to this test.
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
      "project:*",
      membersChangedChannel(PID),
      JSON.stringify(event),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fromClose).toHaveBeenCalled();
    expect(toClose).toHaveBeenCalled();
    expect(metaDoc.broadcastStateless).toHaveBeenCalledWith(JSON.stringify(event));
  });
});

describe("startMembersSync — space:created", () => {
  it("opens meta doc and writes the spaces[spaceId] entry", async () => {
    const { hocuspocus, applied, openSpy } = buildHocuspocus();
    const { subscriber } = buildRedis();
    // Cast: FakeRedis only stubs the surface members-sync touches
    // (duplicate / psubscribe / punsubscribe / quit / EventEmitter
    // pmessage handler). The full ioredis Redis type has 350+ other
    // members irrelevant to this test.
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    const event: SpaceCreatedEvent = {
      type: "project-space:created",
      projectId: PID,
      spaceId: SID,
      spaceType: "canvas",
      name: "Untitled",
      createdBy: "user-1",
      ts: Date.now(),
    };
    subscriber.emit(
      "pmessage",
      "project:*",
      spaceCreatedChannel(PID),
      JSON.stringify(event),
    );
    // Allow the async openDirectConnection chain to settle.
    await new Promise((r) => setImmediate(r));

    expect(openSpy).toHaveBeenCalledWith(
      `project-${PID}/meta`,
      expect.any(Object),
    );

    const spaces = applied.metaDoc!.getMap("spaces");
    const entry = spaces.get(SID) as Y.Map<unknown> | undefined;
    expect(entry).toBeInstanceOf(Y.Map);
    expect(entry!.get("id")).toBe(SID);
    expect(entry!.get("type")).toBe("canvas");
    expect(entry!.get("name")).toBe("Untitled");
    expect(entry!.get("locked")).toBe(false);
    expect(entry!.get("createdBy")).toBe("user-1");
  });
});

describe("startMembersSync — space:deleted", () => {
  it("removes the spaces[spaceId] entry from the meta doc", async () => {
    const { hocuspocus, applied, openSpy } = buildHocuspocus();
    const { subscriber } = buildRedis();
    // Cast: FakeRedis only stubs the surface members-sync touches
    // (duplicate / psubscribe / punsubscribe / quit / EventEmitter
    // pmessage handler). The full ioredis Redis type has 350+ other
    // members irrelevant to this test.
    startMembersSync(hocuspocus, subscriber as unknown as Redis);
    await Promise.resolve();

    // Seed an existing entry by walking through space:created first.
    const created: SpaceCreatedEvent = {
      type: "project-space:created",
      projectId: PID,
      spaceId: SID,
      spaceType: "canvas",
      name: "ToDelete",
      createdBy: "user-1",
      ts: Date.now(),
    };
    subscriber.emit("pmessage", "project:*", spaceCreatedChannel(PID), JSON.stringify(created));
    await new Promise((r) => setImmediate(r));
    expect((applied.metaDoc!.getMap("spaces") as Y.Map<unknown>).has(SID)).toBe(true);

    const deleted: SpaceDeletedEvent = {
      type: "project-space:deleted",
      projectId: PID,
      spaceId: SID,
      deletedBy: "user-1",
      ts: Date.now(),
    };
    subscriber.emit("pmessage", "project:*", spaceDeletedChannel(PID), JSON.stringify(deleted));
    await new Promise((r) => setImmediate(r));

    expect((applied.metaDoc!.getMap("spaces") as Y.Map<unknown>).has(SID)).toBe(false);
    // Both events should have triggered openDirectConnection; the
    // delete branch goes through the same meta doc.
    expect(openSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
