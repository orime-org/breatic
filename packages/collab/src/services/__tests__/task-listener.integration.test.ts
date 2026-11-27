// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Task events across two collab instances (inner#1497 §6.1, B1, B2, B3).
 *
 * Two Hocuspocus servers share one Redis and one Postgres the way production
 * runs them, and each runs its own task listener in one consumer group. Every
 * case uses its own stream and key prefix, so a lease, version or hand-over
 * record left by one case is never seen by another.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Server, type Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { ExecutionError, Redlock, type ExecutionStats } from "@sesamecare-oss/redlock";

import { createRedisClient, db, initCore, schema, type Redis } from "@breatic/core";
import { eq } from "drizzle-orm";
import {
  CANVAS_NODES_KEY, documentBodyFragment, documentSpaceDocName, FOCUS_IMAGE_UPLOAD_EVENT_TYPE, MAX_FOCUS_ENTRIES, SCENE_FORMAT_VERSION,
  SPACE_TASKS_KEY, SPACE_TASKS_VERSION, threeDSpaceDocName, timelineSpaceDocName, webAnimationSpaceDocName,
  type DocumentUploadEvent, type NodeTaskCountsEvent, type SceneLookPictureEvent, type SceneLookSettledControlEvent,
} from "@breatic/shared";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";
import {
  attachTimelineRecord, initializeTimelineDocument, timelineRecordJson, type TimelineUploadEvent,
} from "@breatic/shared/space-content";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import {
  createPersistenceExtension,
  staysLoaded,
  storeDocumentNow,
} from "@collab/services/persistence.js";
import { createUnloadGate } from "@collab/hooks/unload-gate.js";
import { createChangeTrackingExtension } from "@collab/services/change-tracking.js";
import type { GroupConsumer } from "@collab/services/stream-group-consumer.js";
import { startTaskListener, type TaskListenerSettings } from "@collab/services/task-listener.js";
import { isNewerStreamId } from "@collab/services/stream-id.js";

const PID = "77777777-7777-4777-8777-777777777777";
const OWNER_ID = randomUUID();
const STUDIO_ID = randomUUID();

const SETTINGS: TaskListenerSettings = {
  maxHeld: 128,
  blockMs: 100,
  leaseRetryMs: 50,
  claimIntervalMs: 15_000,
  claimIdleMs: 60_000,
  retryMinMs: 50,
  retryMaxMs: 200,
  maxFailures: 3,
  stopDeadlineMs: 3000,
  forgetIdleConsumerMs: 24 * 60 * 60 * 1000,
  keyConcurrency: 4,
  docLeaseMs: 30_000,
  handoffPollMs: 20,
  handoffWaitMs: 200,
};

let instanceA: Hocuspocus;
let instanceB: Hocuspocus;
let stream: Redis;
let coordination: Redis;
const servers: Server[] = [];
const listeners: GroupConsumer[] = [];
/** Documents an unload gate wrote to a rescue file. */
const rescues: string[] = [];

/**
 * One collab server wired as production wires it: change tracking,
 * persistence, the Redis extension, and the unload gate that stores a
 * document before it leaves memory.
 * @param name - Distinguishes the two servers' Redis clients.
 * @returns Its Hocuspocus instance.
 */
async function startInstance(name: string): Promise<Hocuspocus> {
  const storeGate: { current?: ReturnType<typeof createUnloadGate> } = {};
  const server = new Server({
    port: 0,
    address: "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    debounce: 50,
    unloadImmediately: true,
    extensions: [
      createChangeTrackingExtension(),
      createPersistenceExtension(),
      new RedisExtension({
        createClient: () => createRedisClient(process.env.REDIS_COLLAB_URL!, { name }),
        prefix: "itest:hocuspocus",
      }),
      {
        beforeUnloadDocument: async (payload: { documentName: string; document: Y.Doc }): Promise<void> => {
          await storeGate.current?.beforeUnloadDocument(payload);
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[],
  });
  storeGate.current = createUnloadGate({
    instanceId: name,
    encode: (document: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(document),
    staysLoaded: (docName) => staysLoaded(server.hocuspocus, docName),
    storeNow: ({ name: docName }) => storeDocumentNow(server.hocuspocus, docName),
    writeRescue: async ({ documentName }) => {
      rescues.push(documentName);
      return "itest-rescue";
    },
    writeRescueNote: async () => {},
    alert: async () => {},
    retry: { windowMs: 1500, intervalMs: 100, rescueReserveMs: 0 },
    shutdownDeadline: () => undefined,
  });
  await server.listen();
  servers.push(server);
  return server.hocuspocus;
}

beforeAll(async () => {
  initCore(process.env);
  // Media persistence resolves the Project's live Studio before accepting a snapshot.
  await db.insert(schema.users).values({
    id: OWNER_ID, email: `task-listener-${OWNER_ID}@example.com`, emailVerified: true,
  });
  await db.insert(schema.studios).values({
    id: STUDIO_ID, createdByUserId: OWNER_ID, slug: `tl-${STUDIO_ID}`,
    type: "personal", name: "Task listener Studio",
  });
  await db.insert(schema.projects).values({
    id: PID, studioId: STUDIO_ID, createdByUserId: OWNER_ID,
    name: "Task listener Project", slug: `tl-${PID}`,
  });
  stream = createRedisClient(process.env.REDIS_STREAM_URL!, { name: "itest-task-stream" });
  coordination = createRedisClient(process.env.REDIS_COLLAB_URL!, { name: "itest-task-coord" });
  instanceA = await startInstance("itest-task-a");
  instanceB = await startInstance("itest-task-b");
});

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((l) => l.stop()));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.destroy()));
  await stream.quit();
  await coordination.quit();
  await db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, PID));
  await db.update(schema.studios).set({ deletedAt: new Date() }).where(eq(schema.studios.id, STUDIO_ID));
  await db.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, OWNER_ID));
});

/** Names for one case. */
interface Case {
  streamKey: string;
  keyPrefix: string;
  docName: string;
}

/**
 * A fresh stream, key prefix and canvas document holding the given nodes.
 * @param nodes - Node id to node type.
 * @returns The case's names.
 */
async function newCase(nodes: Record<string, string>): Promise<Case> {
  const id = randomUUID();
  const docName = `project-${PID}/canvas-${randomUUID()}`;
  const doc = new Y.Doc();
  const map = doc.getMap(CANVAS_NODES_KEY);
  for (const [nodeId, type] of Object.entries(nodes)) {
    const node = new Y.Map<unknown>();
    node.set("type", type);
    node.set("data", new Y.Map<unknown>());
    map.set(nodeId, node);
  }
  await yjsRepo.seedInitialState(docName, Y.encodeStateAsUpdate(doc));
  return { streamKey: `itest:stream:task:${id}`, keyPrefix: `itest-${id}`, docName };
}

/**
 * A fresh stream, key prefix and empty Space document of a type that takes a change version.
 * @param docNameOf - Builds the Space's document name; a Timeline by default.
 * @returns The case's names.
 */
async function newSpaceTasksCase(docNameOf: (projectId: string, spaceId: string) => string = timelineSpaceDocName): Promise<Case> {
  const c = bareCase(docNameOf(PID, randomUUID()));
  await yjsRepo.seedInitialState(c.docName, Y.encodeStateAsUpdate(new Y.Doc()));
  return c;
}

/**
 * A fresh stream and key prefix for a document this function leaves unwritten.
 * @param docName - The document.
 * @returns The case's names.
 */
function bareCase(docName: string): Case {
  const id = randomUUID();
  return { streamKey: `itest:stream:task:${id}`, keyPrefix: `itest-${id}`, docName };
}

/**
 * Seed a Space document holding one note, so a later read tells its content apart from an empty document.
 * @param docName - The document.
 * @param note - The note.
 * @returns Nothing.
 */
async function seedNote(docName: string, note: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getMap("probe").set("note", note);
  await yjsRepo.seedInitialState(docName, Y.encodeStateAsUpdate(doc));
}

/**
 * Wait until a document has left the instance's memory, so whatever its unload stores has been stored.
 * @param docName - The document.
 * @returns Nothing.
 */
async function untilUnloaded(docName: string): Promise<void> {
  await until(() => !instanceA.documents.has(docName));
}

/**
 * Publish that a Space's background work changed.
 * @param c - The case.
 * @param count - How many changes, in order.
 * @param extra - Extra stream fields on every entry.
 * @returns Their stream ids.
 */
async function publishSpaceTasksVersion(c: Case, count = 1, extra: string[] = []): Promise<string[]> {
  const ids: string[] = [];
  const payload = JSON.stringify({ type: "space-tasks-version", docName: c.docName });
  for (let i = 0; i < count; i++) {
    ids.push((await stream.xadd(c.streamKey, "*", "payload", payload, ...extra))!);
  }
  return ids;
}

/**
 * The change version a Space document holds, as stored and synced.
 * @param docName - The document.
 * @returns The version, or undefined when none was written.
 */
async function readSpaceTasksVersion(docName: string): Promise<unknown> {
  const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
  try {
    return conn.document!.getMap(SPACE_TASKS_KEY).get(SPACE_TASKS_VERSION);
  } finally {
    await conn.disconnect();
  }
}

/**
 * A document's note and change version, read after restoring its soft-deleted row.
 * @param docName - The document.
 * @returns What the restored document holds.
 */
async function readRestored(docName: string): Promise<{ note: unknown; version: unknown }> {
  expect(await yjsRepo.restoreByName(docName)).toBe(true);
  const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
  try {
    return { note: conn.document!.getMap("probe").get("note"), version: conn.document!.getMap(SPACE_TASKS_KEY).get(SPACE_TASKS_VERSION) };
  } finally {
    await conn.disconnect();
  }
}

/** How the listeners settled every part picture, in order. */
const settlements: Omit<SceneLookSettledControlEvent, "type" | "ts">[] = [];

/**
 * Start a listener on one instance.
 * @param c - The case.
 * @param hocuspocus - The instance.
 * @param instanceId - Consumer name.
 * @param settings - Overrides.
 * @returns The listener.
 */
function listen(
  c: Case,
  hocuspocus: Hocuspocus,
  instanceId: string,
  settings: Partial<TaskListenerSettings> = {},
): GroupConsumer {
  const l = startTaskListener({
    hocuspocus,
    streamUrl: process.env.REDIS_STREAM_URL!,
    streamKey: c.streamKey,
    legacyCursorKey: `${c.keyPrefix}:cursor`,
    keyPrefix: c.keyPrefix,
    instanceId,
    coordination,
    settings: { ...SETTINGS, ...settings },
    settleSceneLook: async (settlement) => { settlements.push(settlement); },
  });
  listeners.push(l);
  return l;
}

/**
 * Publish task events.
 * @param c - The case.
 * @param events - Events to append, in order.
 * @param extra - Extra stream fields on every entry.
 * @returns Their stream ids.
 */
async function publish(c: Case, events: Array<Partial<NodeTaskCountsEvent>>, extra: string[] = []): Promise<string[]> {
  const ids: string[] = [];
  for (const e of events) {
    const event = { type: "node-task-counts", docName: c.docName, ...e };
    ids.push((await stream.xadd(c.streamKey, "*", "payload", JSON.stringify(event), ...extra))!);
  }
  return ids;
}

/**
 * Read nodes' data out of the document as stored and synced, through one
 * direct connection.
 * @param c - The case.
 * @param nodeIds - The nodes.
 * @returns A plain copy of the fields the tests look at, per node.
 */
async function readNodes(c: Case, nodeIds: string[]): Promise<Array<Record<string, unknown>>> {
  const conn = await instanceA.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
  try {
    const nodes = conn.document!.getMap(CANVAS_NODES_KEY);
    return nodeIds.map((nodeId) => {
      const data = (nodes.get(nodeId) as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const body = data.get("body");
      return {
        taskCounts: data.get("taskCounts"),
        content: data.get("content"),
        taskResultEventId: data.get("taskResultEventId"),
        text: body instanceof Y.XmlFragment ? bodyToPlainText(body) : undefined,
      };
    });
  } finally {
    await conn.disconnect();
  }
}

/**
 * Read one node's data.
 * @param c - The case.
 * @param nodeId - The node.
 * @returns A plain copy of the fields the tests look at.
 */
async function readNode(c: Case, nodeId: string): Promise<Record<string, unknown>> {
  return (await readNodes(c, [nodeId]))[0]!;
}

/**
 * Wait until a condition holds; a check that throws counts as not yet.
 * @param check - The condition.
 * @param timeoutMs - How long to keep trying.
 */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met in time${last ? `: ${String(last)}` : ""}`);
}

/**
 * Entries the group still has unacknowledged.
 * @param c - The case.
 * @returns The count.
 */
async function pending(c: Case): Promise<number> {
  const summary = (await stream.xpending(c.streamKey, "collab-task-events")) as [number];
  return Number(summary[0]);
}

/**
 * The entries among `ids` the group has handled: delivered to a consumer and
 * acknowledged. An empty pending list alone proves nothing, because it is also
 * empty before the listener has read a single entry.
 * @param streamKey - The stream.
 * @param ids - Entry ids.
 * @returns The handled ones.
 */
async function handledOf(streamKey: string, ids: readonly string[]): Promise<Set<string>> {
  const groups = (await stream.xinfo("GROUPS", streamKey)) as unknown[][];
  const row = groups.find((g) => g[1] === "collab-task-events");
  if (!row) return new Set();
  const delivered = String(row[row.indexOf("last-delivered-id") + 1]);
  const rows = (await stream.xpending(streamKey, "collab-task-events", "-", "+", 1000)) as Array<
    [string, string, number, number]
  >;
  const pendingIds = new Set(rows.map((r) => r[0]));
  return new Set(ids.filter((id) => !pendingIds.has(id) && !isNewerStreamId(id, delivered)));
}

/**
 * Whether the group has handled every one of `ids` (see {@link handledOf}).
 * @param streamKey - The stream.
 * @param ids - Entry ids.
 * @returns True once all of them are.
 */
async function handled(streamKey: string, ids: readonly string[]): Promise<boolean> {
  return (await handledOf(streamKey, ids)).size === ids.length;
}

const RUNNING = { running: 1, done: 0, failed: 0, expired: 0 };
const DONE = { running: 0, done: 1, failed: 0, expired: 0 };
const MEDIA = { coverUrl: null, width: null, height: null, duration: null, mimeType: null, size: null };

describe("task events across two collab instances", () => {
  it("writes every result of a 64-tile grid once, with one direct connection per document batch", async () => {
    const nodeIds = Array.from({ length: 64 }, () => randomUUID());
    const c = await newCase(Object.fromEntries(nodeIds.map((n) => [n, "text"])));
    const opensA = vi.spyOn(instanceA, "openDirectConnection");
    const opensB = vi.spyOn(instanceB, "openDirectConnection");
    const ids = [
      ...(await publish(c, nodeIds.map((nodeId) => ({ nodeId, counts: RUNNING })))),
      ...(await publish(
        c,
        nodeIds.map((nodeId, i) => ({ nodeId, counts: DONE, result: { ...MEDIA, content: `tile ${i}` } })),
      )),
    ];
    // Fewer entries held than the grid has, so both instances take part in the
    // same document; the other event_* values are config/collab.yaml's.
    const settings = { maxHeld: 64, keyConcurrency: 16, blockMs: 5000, leaseRetryMs: 1000, handoffPollMs: 50, handoffWaitMs: 5000 };
    const startedAt = Date.now();
    listen(c, instanceA, "a", settings);
    listen(c, instanceB, "b", settings);
    await until(() => handled(c.streamKey, ids), 15_000);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const listenerOpens = opensA.mock.calls.length + opensB.mock.calls.length;
    expect(opensA.mock.calls.length).toBeGreaterThan(0);
    expect(opensB.mock.calls.length).toBeGreaterThan(0);
    const nodes = await readNodes(c, nodeIds);
    for (const [i, node] of nodes.entries()) {
      expect(node.taskCounts).toEqual(DONE);
      expect(node.text).toBe(`tile ${i}`);
    }
    expect(listenerOpens).toBeLessThanOrEqual(8);
  });

  it("keeps the newer content when an older result is replayed from the dead-letter stream", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const [olderId] = await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: "old.png" } }]);
    const [newerId] = await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: "new.png" } }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [olderId!, newerId!]));
    const replayed = await publish(c, [{ nodeId, counts: RUNNING, result: { ...MEDIA, content: "old.png" } }], ["originId", olderId!]);
    await until(() => handled(c.streamKey, replayed));
    const node = await readNode(c, nodeId);
    expect(node.content).toBe("new.png");
    expect(node.taskCounts).toEqual(DONE);
  });

  it("keeps the counts version in the coordination database, not in the node", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const [id] = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [id!]));
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-counts-version:${c.docName}`, nodeId)).toBe(id);
    expect(await coordination.ttl(`${c.keyPrefix}:collab:task-counts-version:${c.docName}`)).toBeGreaterThan(0);
  });

  it("leaves a hand-over record after writing", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const ids = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const record = await coordination.get(`${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`);
    expect(record).toBeTypeOf("string");
    expect(await coordination.pttl(`${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`)).toBeGreaterThan(0);
  });

  it("does not write until its copy of the document holds what the previous holder wrote", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const unseen = new Map<number, number>([[987_654_321, 5]]);
    const handoffKey = `${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`;
    const vector = encodeVector(unseen);
    await coordination.set(handoffKey, Buffer.from(vector).toString("base64"), "PX", 60_000);
    const [id] = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    await new Promise((r) => setTimeout(r, 4000));
    expect((await readNode(c, nodeId)).taskCounts).toBeUndefined();
    expect(await pending(c)).toBe(1);
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, id!)).toBeNull();
    await coordination.del(handoffKey);
    await until(() => handled(c.streamKey, [id!]));
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
  });

  it("waits without counting a failure while another instance holds the document lease", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const leaseKey = `${c.keyPrefix}:collab:task-doc-lease:${c.docName}`;
    await coordination.set(leaseKey, "someone-else", "PX", 60_000);
    const [id] = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    // Longer than one whole batch write (store plus the two one-second waits).
    await new Promise((r) => setTimeout(r, 4000));
    expect(await pending(c)).toBe(1);
    expect((await readNode(c, nodeId)).taskCounts).toBeUndefined();
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, id!)).toBeNull();
    await coordination.del(leaseKey);
    await until(() => handled(c.streamKey, [id!]));
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
  });

  it("waits without counting a failure when Redis errors while the lease is taken", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const leaseKey = `${c.keyPrefix}:collab:task-doc-lease:${c.docName}`;
    const original = Redlock.prototype.acquire;
    let refused = 0;
    // The Redis extension's store lock is a Redlock too; only this document's lease errors.
    vi.spyOn(Redlock.prototype, "acquire").mockImplementation(function (this: Redlock, resources, duration, settings) {
      if (resources.includes(leaseKey) && refused === 0) {
        refused += 1;
        const stats: ExecutionStats = {
          membershipSize: 1,
          quorumSize: 1,
          votesFor: new Set(),
          votesAgainst: new Map([[coordination, new Error("connection reset")]]),
        };
        return Promise.reject(new ExecutionError("no quorum", [Promise.resolve(stats)]));
      }
      return original.call(this, resources, duration, settings);
    });
    const [id] = await publish(c, [{ nodeId, counts: RUNNING }]);
    // One failure would send the event straight to the dead-letter stream.
    listen(c, instanceA, "a", { maxFailures: 1 });
    await until(() => handled(c.streamKey, [id!]));
    expect(refused).toBe(1);
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, id!)).toBeNull();
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("acknowledges a written batch whose lease release fails", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const leaseKey = `${c.keyPrefix}:collab:task-doc-lease:${c.docName}`;
    const original = Redlock.prototype.release;
    let refused = 0;
    // The Redis extension's store lock is a Redlock too; only this document's lease fails to release.
    vi.spyOn(Redlock.prototype, "release").mockImplementation(function (this: Redlock, lock, settings) {
      if (lock.resources.includes(leaseKey) && refused === 0) {
        refused += 1;
        return Promise.reject(new ExecutionError("no quorum", []));
      }
      return original.call(this, lock, settings);
    });
    const [id] = await publish(c, [{ nodeId, counts: RUNNING }]);
    // One failure would send the event straight to the dead-letter stream.
    listen(c, instanceA, "a", { maxFailures: 1 });
    await until(() => handled(c.streamKey, [id!]));
    expect(refused).toBe(1);
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, id!)).toBeNull();
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("writes once a peer's update named in the hand-over record has synced to its copy", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const peer = new Y.Doc();
    peer.clientID = 987_654_321;
    for (let i = 0; i < 5; i++) peer.getMap("itest-peer").set(`k${i}`, i);
    const handoffKey = `${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`;
    await coordination.set(handoffKey, Buffer.from(Y.encodeStateVector(peer)).toString("base64"), "PX", 60_000);
    const ids = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a", { handoffWaitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 1000));
    expect((await readNode(c, nodeId)).taskCounts).toBeUndefined();

    // The peer's update reaches instance A only through the Redis extension.
    const onB = await instanceB.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
    await onB.transact((doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer)));
    await until(() => handled(c.streamKey, ids));
    await onB.disconnect();
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
  });

  it("writes the hand-over record only after the document holding it is stored", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    const handoffKey = `${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`;
    await until(async () => (await coordination.get(handoffKey)) !== null);
    const recorded = Y.decodeStateVector(Buffer.from((await coordination.get(handoffKey))!, "base64"));
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await yjsRepo.fetchDocData(c.docName))!);
    const held = Y.decodeStateVector(Y.encodeStateVector(stored));
    for (const [client, clock] of recorded) expect(held.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
  });

  it("stops waiting for a hand-over and takes no further lease once it is told to stop", async () => {
    const waitingNode = randomUUID();
    const c = await newCase({ [waitingNode]: "image" });
    const other = await newCase({ [randomUUID()]: "image" });
    const unseen = new Map<number, number>([[987_654_322, 5]]);
    await coordination.set(
      `${c.keyPrefix}:collab:task-doc-handoff:${c.docName}`,
      Buffer.from(encodeVector(unseen)).toString("base64"),
      "PX",
      60_000,
    );
    await publish(c, [{ nodeId: waitingNode, counts: RUNNING }]);
    await stream.xadd(
      c.streamKey,
      "*",
      "payload",
      JSON.stringify({ type: "node-task-counts", docName: other.docName, nodeId: randomUUID(), counts: RUNNING }),
    );
    const l = listen(c, instanceA, "a", { handoffWaitMs: 20_000, keyConcurrency: 1, stopDeadlineMs: 10_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const opens = vi.spyOn(instanceA, "openDirectConnection");
    const startedAt = Date.now();
    await l.stop();
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(opens.mock.calls.map((call) => call[0])).not.toContain(other.docName);
  });

  it("fails only the event that throws while the rest of its document's events land", async () => {
    const good = randomUUID();
    const bad = randomUUID();
    const c = await newCase({ [good]: "image", [bad]: "image" });
    // A replayed entry whose origin id was damaged: its version cannot be read.
    const [badId] = await publish(c, [{ nodeId: bad, counts: RUNNING }], ["originId", "not-a-stream-id"]);
    await publish(c, [{ nodeId: good, counts: RUNNING }]);
    listen(c, instanceA, "a");
    await until(async () => (await readNode(c, good)).taskCounts !== undefined);
    expect((await readNode(c, good)).taskCounts).toEqual(RUNNING);
    await until(async () => Number(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, badId!)) >= 1);
  });

  it("acknowledges an entry missing its document name on its own and still writes the next event", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const badId = await stream.xadd(c.streamKey, "*", "payload", JSON.stringify({ type: "node-task-counts", nodeId }));
    const [goodId] = await publish(c, [{ nodeId, counts: RUNNING }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [badId!, goodId!]));
    expect((await readNode(c, nodeId)).taskCounts).toEqual(RUNNING);
    expect(await coordination.hget(`${c.keyPrefix}:collab:task-event-failures`, goodId!)).toBeNull();
  });

  it("writes 128 events of one document within seconds with a single consumer", async () => {
    const nodeIds = Array.from({ length: 64 }, () => randomUUID());
    const c = await newCase(Object.fromEntries(nodeIds.map((n) => [n, "image"])));
    const ids = [
      ...(await publish(c, nodeIds.map((nodeId) => ({ nodeId, counts: RUNNING })))),
      ...(await publish(c, nodeIds.map((nodeId) => ({ nodeId, counts: DONE })))),
    ];
    const startedAt = Date.now();
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    for (const node of await readNodes(c, nodeIds)) expect(node.taskCounts).toEqual(DONE);
  });

  it("writes several documents side by side", async () => {
    const cases = await Promise.all(Array.from({ length: 8 }, () => newCase({ n: "image" })));
    const streamKey = cases[0]!.streamKey;
    const ids: string[] = [];
    for (const c of cases) {
      for (const counts of [RUNNING, DONE]) {
        ids.push((await stream.xadd(streamKey, "*", "payload", JSON.stringify({ type: "node-task-counts", docName: c.docName, nodeId: "n", counts })))!);
      }
    }
    const startedAt = Date.now();
    listen(cases[0]!, instanceA, "a", { keyConcurrency: 4 });
    await until(() => handled(streamKey, ids), 30_000);
    // One document batch takes about two seconds (store plus the two one-second
    // waits), so eight in a row would take sixteen.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it("writes a burst across many documents faster with two instances than with one, at the production settings", async () => {
    /**
     * Time thirty-two documents' events, one per document and written before
     * anyone listens, through the given instances. One event per document
     * keeps this about documents side by side; one document split across
     * instances is the steady-flow case below.
     * @param instances - Instances to listen on.
     * @returns Milliseconds until every event is acknowledged.
     */
    async function timeBurst(instances: Hocuspocus[]): Promise<number> {
      const cases = await Promise.all(Array.from({ length: 32 }, () => newCase({ n: "image" })));
      const streamKey = cases[0]!.streamKey;
      const ids: string[] = [];
      for (const c of cases) {
        ids.push((await stream.xadd(streamKey, "*", "payload", JSON.stringify({ type: "node-task-counts", docName: c.docName, nodeId: "n", counts: DONE })))!);
      }
      const startedAt = Date.now();
      // The event_* values of config/collab.yaml.
      const production = { maxHeld: 128, keyConcurrency: 16, blockMs: 5000, leaseRetryMs: 1000, handoffWaitMs: 5000 };
      instances.forEach((h, i) => listen(cases[0]!, h, `i${i}`, production));
      await until(() => handled(streamKey, ids), 60_000);
      const elapsed = Date.now() - startedAt;
      await Promise.all(listeners.splice(0).map((l) => l.stop()));
      return elapsed;
    }
    const one = await timeBurst([instanceA]);
    const two = await timeBurst([instanceA, instanceB]);
    expect(two).toBeLessThan(one * 0.75);
  }, 150_000);

  it("lets both instances write a document whose events keep arriving, each within seconds", async () => {
    const nodeIds = Array.from({ length: 40 }, () => randomUUID());
    const c = await newCase(Object.fromEntries(nodeIds.map((n) => [n, "image"])));
    // config/collab.yaml timing.
    const timing = { blockMs: 5000, leaseRetryMs: 1000, handoffWaitMs: 5000 };
    const opensA = vi.spyOn(instanceA, "openDirectConnection");
    const opensB = vi.spyOn(instanceB, "openDirectConnection");
    listen(c, instanceA, "a", timing);
    listen(c, instanceB, "b", timing);
    await new Promise((r) => setTimeout(r, 500));
    const published = new Map<string, number>();
    const acked = new Map<string, number>();
    let publishing = true;
    const watch = (async () => {
      while (publishing || acked.size < published.size) {
        const done = await handledOf(c.streamKey, [...published.keys()]);
        const now = Date.now();
        for (const id of done) if (!acked.has(id)) acked.set(id, now);
        await new Promise((r) => setTimeout(r, 30));
      }
    })();
    for (const [i, nodeId] of nodeIds.entries()) {
      const [id] = await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: `r${i}.png` } }]);
      published.set(id!, Date.now());
      await new Promise((r) => setTimeout(r, 250));
    }
    publishing = false;
    await Promise.race([watch, new Promise((r) => setTimeout(r, 60_000))]);
    const latencies = [...published].map(([id, at]) => (acked.get(id) ?? Infinity) - at);
    expect(opensA.mock.calls.length).toBeGreaterThan(0);
    expect(opensB.mock.calls.length).toBeGreaterThan(0);
    expect(Math.max(...latencies)).toBeLessThan(8000);
  }, 120_000);

  it("writes an older result that arrives after newer counts, and leaves the counts alone", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const ids = [
      ...(await publish(c, [{ nodeId, counts: RUNNING }])),
      ...(await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: "late.png" } }], ["originId", "1-0"])),
    ];
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const node = await readNode(c, nodeId);
    expect(node.content).toBe("late.png");
    expect(node.taskCounts).toEqual(RUNNING);
  });

  it("writes a result delivered twice only once", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "text" });
    const [id] = await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: "once" } }]);
    const [again] = await publish(c, [{ nodeId, counts: DONE, result: { ...MEDIA, content: "once" } }], ["originId", id!]);
    const opensA = vi.spyOn(instanceA, "openDirectConnection");
    const opensB = vi.spyOn(instanceB, "openDirectConnection");
    listen(c, instanceA, "a", { maxHeld: 1 });
    listen(c, instanceB, "b", { maxHeld: 1 });
    await until(() => handled(c.streamKey, [id!, again!]));
    expect(opensA.mock.calls.length).toBeGreaterThan(0);
    expect(opensB.mock.calls.length).toBeGreaterThan(0);
    expect((await readNode(c, nodeId)).text).toBe("once");
  });

  it("stores a document whose unload met a peer's store lock, without a rescue file", async () => {
    const docName = `project-${PID}/canvas-${randomUUID()}`;
    const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
    await conn.transact((doc) => doc.getMap("probe").set("k", "v"));
    // The Redis extension's store lock, held by a peer past the extension's own
    // one-second wait before unload. Redlock writes it in database 0.
    const db0 = new URL(process.env.REDIS_COLLAB_URL!);
    db0.pathname = "/0";
    const lockHolder = createRedisClient(db0.toString(), { name: "itest-peer-lock" });
    await lockHolder.set(`itest:hocuspocus:${docName}:lock`, "peer", "PX", 1400);
    await conn.disconnect();
    await until(async () => (await yjsRepo.fetchDocData(docName)) !== null, 10_000);
    await lockHolder.quit();
    const stored = new Y.Doc();
    Y.applyUpdate(stored, (await yjsRepo.fetchDocData(docName))!);
    expect(stored.getMap("probe").get("k")).toBe("v");
    expect(rescues).not.toContain(docName);
  });

  it("acknowledges and skips an event for a document that is not a canvas Space", async () => {
    const c = await newCase({});
    const metaId = await stream.xadd(
      c.streamKey,
      "*",
      "payload",
      JSON.stringify({ type: "node-task-counts", docName: `project-${PID}/meta`, nodeId: randomUUID(), counts: RUNNING }),
    );
    const brokenId = await stream.xadd(c.streamKey, "*", "payload", "{not json");
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [metaId!, brokenId!]));
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("writes the stream id of a Timeline Space's latest change into its document", async () => {
    const c = await newSpaceTasksCase();
    const ids = await publishSpaceTasksVersion(c, 3);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readSpaceTasksVersion(c.docName)).toBe(ids[2]);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("keeps a Timeline Space's newer version when an older change is replayed from the dead-letter stream", async () => {
    const c = await newSpaceTasksCase();
    const [olderId, newerId] = await publishSpaceTasksVersion(c, 2);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [olderId!, newerId!]));
    const replayed = await publishSpaceTasksVersion(c, 1, ["originId", olderId!]);
    await until(() => handled(c.streamKey, replayed));
    expect(await readSpaceTasksVersion(c.docName)).toBe(newerId);
  });

  it("writes the stream id of a Motion Space's latest execution change into its document", async () => {
    const c = await newSpaceTasksCase(webAnimationSpaceDocName);
    const ids = await publishSpaceTasksVersion(c, 2);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readSpaceTasksVersion(c.docName)).toBe(ids[1]);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("acknowledges and skips a space-tasks version for a document whose type takes none (a canvas)", async () => {
    const c = await newCase({});
    const ids = await publishSpaceTasksVersion(c);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readSpaceTasksVersion(c.docName)).toBeUndefined();
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("leaves a deleted Timeline Space's stored content as it was, so restoring it brings the content back", async () => {
    const c = bareCase(timelineSpaceDocName(PID, randomUUID()));
    await seedNote(c.docName, "clips");
    expect(await yjsRepo.softDeleteByName(c.docName)).toBe(true);
    const ids = await publishSpaceTasksVersion(c);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await readRestored(c.docName)).toEqual({ note: "clips", version: undefined });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("creates no document for a Space that has none", async () => {
    const c = bareCase(timelineSpaceDocName(PID, randomUUID()));
    const ids = await publishSpaceTasksVersion(c);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await yjsRepo.fetchDocData(c.docName)).toBeNull();
    expect(await yjsRepo.restoreByName(c.docName)).toBe(false);
  });
});

describe("stored 3D part pictures (inner#1693 design 6.3)", () => {
  const OBJECT = "0b8c7f1a-3e2d-4a5b-8c9d-0e1f2a3b4c5d";
  // Part pictures are addresses (inner#2171).
  const START = "https://cdn.example/image/2026-11-26/start.png";
  const PICTURE = "https://cdn.example/image/2026-11-26/picture.png";
  const OTHER = "https://cdn.example/image/2026-11-26/other.png";

  /**
   * A 3D Space document holding one model whose part 3 shows `map`.
   * @param map - The part's picture, or undefined for none.
   * @returns The case, and the event a picture uploaded from that state makes.
   */
  async function sceneCase(map: string | undefined): Promise<{ c: Case; event: SceneLookPictureEvent; spaceId: string }> {
    const spaceId = randomUUID();
    const c = bareCase(threeDSpaceDocName(PID, spaceId));
    const doc = new Y.Doc();
    doc.getMap("scene").set("formatVersion", SCENE_FORMAT_VERSION);
    const record = new Y.Map<unknown>();
    doc.getMap("objects").set(OBJECT, record);
    record.set("model", { kind: "builtin", id: "figure" });
    if (map !== undefined) record.set("look.3.map", map);
    await yjsRepo.seedInitialState(c.docName, Y.encodeStateAsUpdate(doc));
    return { c, spaceId, event: {
      type: "scene-look-picture", docName: c.docName, objectId: OBJECT, part: "3", startMap: START,
      picture: PICTURE, userId: "uploader", uploadKey: randomUUID(),
    } };
  }

  /**
   * Publish stored picture events.
   * @param c - The case.
   * @param events - The events, in order.
   * @returns Their stream ids.
   */
  async function publishPictures(c: Case, events: SceneLookPictureEvent[]): Promise<string[]> {
    const ids: string[] = [];
    for (const event of events) ids.push((await stream.xadd(c.streamKey, "*", "payload", JSON.stringify(event)))!);
    return ids;
  }

  /**
   * Read or write part 3's picture on the stored and synced document.
   * @param docName - The document.
   * @param set - A picture to write first, as a member would.
   * @returns The part's picture.
   */
  async function partMap(docName: string, set?: string): Promise<unknown> {
    const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
    try {
      const record = conn.document!.getMap("objects").get(OBJECT) as Y.Map<unknown>;
      if (set !== undefined) await conn.transact(() => { record.set("look.3.map", set); });
      return record.get("look.3.map");
    } finally {
      await conn.disconnect();
    }
  }

  it("puts the picture on the part it was uploaded for, while nobody has the Space open, and says it was written", async () => {
    const { c, event } = await sceneCase(START);
    const ids = await publishPictures(c, [event]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await partMap(c.docName)).toBe(PICTURE);
    expect(settlements.filter((r) => r.spaceId === c.docName.split("/3d-")[1])).toEqual([
      { projectId: PID, spaceId: c.docName.split("/3d-")[1], objectId: OBJECT, part: "3", picture: PICTURE, userId: "uploader", outcome: "written" },
    ]);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("applies and settles one upload once, even when its event comes again after the part went back to its starting picture", async () => {
    const { c, event, spaceId } = await sceneCase(START);
    const first = await publishPictures(c, [event]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, first));
    expect(await partMap(c.docName, START)).toBe(START);
    const again = await publishPictures(c, [event]);
    await until(() => handled(c.streamKey, again));
    expect(await partMap(c.docName)).toBe(START);
    expect(settlements.filter((r) => r.spaceId === spaceId)).toHaveLength(1);
  });

  it("tells the uploader the picture was written when the part already holds it", async () => {
    const { c, event, spaceId } = await sceneCase(PICTURE);
    const ids = await publishPictures(c, [event]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await partMap(c.docName)).toBe(PICTURE);
    expect(settlements.filter((r) => r.spaceId === spaceId)).toEqual([
      { projectId: PID, spaceId, objectId: OBJECT, part: "3", picture: PICTURE, userId: "uploader", outcome: "written" },
    ]);
  });

  it("writes nothing on a part someone gave another picture, and tells the uploader why", async () => {
    const { c, event, spaceId } = await sceneCase(OTHER);
    const ids = await publishPictures(c, [event]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await partMap(c.docName)).toBe(OTHER);
    expect(settlements).toContainEqual({
      projectId: PID, spaceId, objectId: OBJECT, part: "3", picture: PICTURE, userId: "uploader", outcome: "partChanged",
    });
  });

  it("creates no document for a Space that has none, and tells the uploader the object is gone", async () => {
    const spaceId = randomUUID();
    const c = bareCase(threeDSpaceDocName(PID, spaceId));
    const ids = await publishPictures(c, [{
      type: "scene-look-picture", docName: c.docName, objectId: OBJECT, part: "3", startMap: null,
      picture: PICTURE, userId: "uploader", uploadKey: randomUUID(),
    }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await yjsRepo.fetchDocData(c.docName)).toBeNull();
    expect(settlements).toContainEqual(expect.objectContaining({ spaceId, outcome: "objectGone" }));
  });
});

/**
 * A fresh stream and key prefix, and a Document whose body holds one image waiting for an upload.
 * @param padding - Characters of paragraph text added after it, to make the document large.
 * @returns The case's names.
 */
async function newDocumentUploadCase(padding = 0): Promise<Case> {
  const c = bareCase(documentSpaceDocName(PID, randomUUID()));
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  documentBodyFragment(doc).insert(0, [group]);
  const media = new Y.XmlElement("image");
  media.setAttribute("uploadId", "u1");
  media.setAttribute("uploadHome", c.docName);
  media.setAttribute("url", "");
  // The editor writes every declared prop, so a fresh block holds these empty.
  media.setAttribute("uploadState", "");
  media.setAttribute("uploadFailure", "");
  const container = new Y.XmlElement("blockContainer");
  container.insert(0, [media]);
  group.insert(0, [container]);
  if (padding > 0) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("x".repeat(padding))]);
    const textContainer = new Y.XmlElement("blockContainer");
    textContainer.insert(0, [paragraph]);
    group.insert(1, [textContainer]);
  }
  doc.getMap("probe").set("note", "body");
  await yjsRepo.seedInitialState(c.docName, Y.encodeStateAsUpdate(doc));
  return c;
}

/**
 * Publish Document upload events.
 * @param c - The case.
 * @param events - The events, completed with the case's document name.
 * @returns Their stream ids.
 */
async function publishDocumentUpload(c: Case, events: Array<Omit<DocumentUploadEvent, "type" | "docName">>): Promise<string[]> {
  const ids: string[] = [];
  for (const event of events) {
    const payload = JSON.stringify({ type: "document-upload", docName: c.docName, ...event });
    ids.push((await stream.xadd(c.streamKey, "*", "payload", payload))!);
  }
  return ids;
}

/**
 * The image's attributes as the stored document holds them.
 * @param docName - The document.
 * @returns The attributes.
 */
async function readImage(docName: string): Promise<Record<string, unknown>> {
  const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
  try {
    const group = documentBodyFragment(conn.document!).get(0) as Y.XmlElement;
    const media = (group.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    return { ...media.getAttributes() };
  } finally {
    await conn.disconnect();
  }
}

describe("Document upload events (breatic#1574)", () => {
  const COMPLETED = { uploadId: "u1", state: "completed" as const, result: { url: "https://cdn.example/a.png", mediaWidth: 8, mediaHeight: 6 } };

  it("writes the processing state and then the result into the block waiting for the upload", async () => {
    const c = await newDocumentUploadCase();
    const ids = await publishDocumentUpload(c, [{ uploadId: "u1", state: "processing" }, COMPLETED]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readImage(c.docName)).toMatchObject({ url: "https://cdn.example/a.png", mediaWidth: 8, mediaHeight: 6, uploadId: "" });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("writes into a Document over the size limit the editor enforces", async () => {
    const c = await newDocumentUploadCase(12_000_000);
    const ids = await publishDocumentUpload(c, [COMPLETED]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids), 60_000);
    expect(await readImage(c.docName)).toMatchObject({ url: "https://cdn.example/a.png" });
  }, 90_000);

  it("writes nothing for an upload no block in the Document waits for", async () => {
    const c = await newDocumentUploadCase();
    const ids = await publishDocumentUpload(c, [{ ...COMPLETED, uploadId: "someone-else" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readImage(c.docName)).toMatchObject({ url: "", uploadId: "u1", uploadState: "" });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("lands the same block for an ending delivered twice and a processing that arrives after it", async () => {
    const c = await newDocumentUploadCase();
    const ids = await publishDocumentUpload(c, [COMPLETED, COMPLETED, { uploadId: "u1", state: "processing" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const image = await readImage(c.docName);
    expect(image).toMatchObject({ url: "https://cdn.example/a.png", mediaWidth: 8, mediaHeight: 6, uploadId: "" });
    expect(image).not.toHaveProperty("uploadState");
  });

  it("leaves a deleted Document's stored content as it was", async () => {
    const c = await newDocumentUploadCase();
    expect(await yjsRepo.softDeleteByName(c.docName)).toBe(true);
    const ids = await publishDocumentUpload(c, [COMPLETED]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await yjsRepo.restoreByName(c.docName)).toBe(true);
    expect(await readImage(c.docName)).toMatchObject({ url: "", uploadId: "u1" });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });
});

/** The Timeline upload clip each Timeline case seeds, and the upload it waits for. */
const TIMELINE_CLIP = "5f0c1c55-2c55-4a55-8a55-0c55c55c55c5";
const TIMELINE_UPLOAD = "6a1d2d66-3d66-4b66-9b66-1d66d66d66d6";
const TIMELINE_ASSET = "7b2e3e77-4e77-4c77-8c77-2e77e77e77e7";

/**
 * A fresh stream and key prefix, and a Timeline whose main track holds one upload clip waiting for a video.
 * @returns The case's names.
 */
async function newTimelineUploadCase(): Promise<Case> {
  const c = bareCase(timelineSpaceDocName(PID, randomUUID()));
  const doc = new Y.Doc();
  initializeTimelineDocument(doc, { width: 1920, height: 1080, fps: { num: 24, den: 1 } });
  attachTimelineRecord(doc.getMap("clips"), TIMELINE_CLIP, {
    id: TIMELINE_CLIP, trackId: "visual-1", kind: "upload", startFrame: 0, sourceInFrame: 0, durationFrames: 48,
    rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    upload: { uploadId: TIMELINE_UPLOAD, name: "shot.mp4", kind: "video", durationSeconds: 2 },
  });
  await yjsRepo.seedInitialState(c.docName, Y.encodeStateAsUpdate(doc));
  return c;
}

/**
 * Publish Timeline upload events.
 * @param c - The case.
 * @param events - The events, completed with a document name: the case's unless the event names one.
 * @returns Their stream ids.
 */
async function publishTimelineUpload(
  c: Case,
  events: Array<Omit<TimelineUploadEvent, "type" | "docName"> & { docName?: string }>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const event of events) {
    const payload = JSON.stringify({ type: "timeline-upload", docName: c.docName, ...event });
    ids.push((await stream.xadd(c.streamKey, "*", "payload", payload))!);
  }
  return ids;
}

/**
 * The Timeline's clips and sources as the stored document holds them.
 * @param docName - The document.
 * @returns Plain copies by id.
 */
async function readTimeline(docName: string): Promise<{ clips: Record<string, Record<string, unknown>>; sources: Record<string, Record<string, unknown>> }> {
  const conn = await instanceA.openDirectConnection(docName, { context: { user: { id: "test" } } });
  try {
    const plain = (name: string): Record<string, Record<string, unknown>> => Object.fromEntries(
      [...conn.document!.getMap(name).entries()].map(([id, value]) => [id, timelineRecordJson(value) as Record<string, unknown>]),
    );
    return { clips: plain("clips"), sources: plain("sources") };
  } finally {
    await conn.disconnect();
  }
}

describe("Timeline upload events (inner#1709 design §4.3)", () => {
  const COMPLETED = {
    uploadId: TIMELINE_UPLOAD, state: "completed" as const,
    result: { assetId: TIMELINE_ASSET, kind: "video" as const, durationSeconds: 2, width: 1280, height: 720 },
  };

  it("writes processing into the clip waiting for the upload", async () => {
    const c = await newTimelineUploadCase();
    const ids = await publishTimelineUpload(c, [{ uploadId: TIMELINE_UPLOAD, state: "processing" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const { clips } = await readTimeline(c.docName);
    expect(clips[TIMELINE_CLIP]).toMatchObject({ kind: "upload", upload: { uploadId: TIMELINE_UPLOAD, kind: "video", state: "processing" } });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("turns the clip into a video clip of the registered asset once the upload ends, while nobody has the Timeline open", async () => {
    const c = await newTimelineUploadCase();
    const ids = await publishTimelineUpload(c, [{ uploadId: TIMELINE_UPLOAD, state: "processing" }, COMPLETED]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const { clips, sources } = await readTimeline(c.docName);
    const clip = clips[TIMELINE_CLIP]!;
    expect(clip).toMatchObject({ id: TIMELINE_CLIP, kind: "video", trackId: "visual-1", startFrame: 0 });
    expect(clip).not.toHaveProperty("upload");
    expect(Object.values(sources)).toEqual([expect.objectContaining({
      id: clip.sourceId, kind: "video", assetId: TIMELINE_ASSET, durationOrigin: "registered",
    })]);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("writes the failure and its cause into the clip", async () => {
    const c = await newTimelineUploadCase();
    const ids = await publishTimelineUpload(c, [{ uploadId: TIMELINE_UPLOAD, state: "failed", reason: "unsupported_type" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    const { clips } = await readTimeline(c.docName);
    expect(clips[TIMELINE_CLIP]).toMatchObject({ kind: "upload", upload: { state: "failed", failure: "unsupportedType", retryable: false } });
  });

  it("writes nothing for an upload no clip in the Timeline waits for", async () => {
    const c = await newTimelineUploadCase();
    const before = await readTimeline(c.docName);
    const ids = await publishTimelineUpload(c, [{ ...COMPLETED, uploadId: randomUUID() }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readTimeline(c.docName)).toEqual(before);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("acknowledges and skips a Timeline upload addressed to a Document, leaving its block as it was", async () => {
    const c = await newDocumentUploadCase();
    const ids = await publishTimelineUpload(c, [{ ...COMPLETED, uploadId: "u1" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readImage(c.docName)).toMatchObject({ url: "", uploadId: "u1", uploadState: "" });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("acknowledges and skips a Document upload addressed to a Timeline, leaving its clip as it was", async () => {
    const c = await newTimelineUploadCase();
    const before = await readTimeline(c.docName);
    const ids = await publishDocumentUpload(c, [{ uploadId: TIMELINE_UPLOAD, state: "completed", result: { url: "https://cdn.example/a.mp4" } }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readTimeline(c.docName)).toEqual(before);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("leaves a deleted Timeline's stored content as it was", async () => {
    const c = await newTimelineUploadCase();
    expect(await yjsRepo.softDeleteByName(c.docName)).toBe(true);
    const ids = await publishTimelineUpload(c, [COMPLETED]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await yjsRepo.restoreByName(c.docName)).toBe(true);
    expect((await readTimeline(c.docName)).clips[TIMELINE_CLIP]).toMatchObject({ kind: "upload", upload: { uploadId: TIMELINE_UPLOAD } });
  });
});

/**
 * Encode a state vector the way `Y.encodeStateVector` does: a count, then
 * client id and clock pairs, all as variable-length unsigned integers.
 * @param vector - Client id to clock.
 * @returns The encoded vector.
 */
function encodeVector(vector: Map<number, number>): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, vector.size);
  for (const [client, clock] of vector) {
    encoding.writeVarUint(encoder, client);
    encoding.writeVarUint(encoder, clock);
  }
  return encoding.toUint8Array(encoder);
}


// #1580 test spec D-20 to D-30: collab adds an uploaded focus crop to its
// node's pool; a node the document no longer holds is left alone, as a canvas
// upload's node is (node-task-counts.ts).
describe("focus crop events", () => {
  /** One focus image as the event carries it. */
  function image(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: randomUUID(), url: `https://cdn.test.invalid/${randomUUID()}.png`, name: "Source", width: 640, height: 480, ...over };
  }

  /** Append focus-image events for `c`'s document. */
  async function publishFocus(
    c: Case,
    events: Array<{ nodeId: string; image?: Record<string, unknown>; docName?: string; state?: "uploading" | "completed" | "failed"; id?: string }>,
    extra: string[] = [],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const e of events) {
      const state = e.state ?? "completed";
      const step = state === "failed" ? { state, id: e.id } : state === "uploading" ? { state, openedAt: Date.now(), image: e.image } : { state, image: e.image };
      const payload = JSON.stringify({ type: FOCUS_IMAGE_UPLOAD_EVENT_TYPE, docName: e.docName ?? c.docName, nodeId: e.nodeId, ...step });
      ids.push((await stream.xadd(c.streamKey, "*", ...extra, "payload", payload))!);
    }
    return ids;
  }

  /** The crop `img` as its uploading step carries it, two hours from now. */
  function uploadOf(img: Record<string, unknown>): Record<string, unknown> {
    const { url: _url, ...crop } = img;
    return { ...crop, deadlineAt: Date.now() + 7_200_000 };
  }

  /** The node's focus pool as stored, or undefined when the node or pool is absent. */
  async function poolOf(c: Case, nodeId: string): Promise<{ isArray: boolean; items: unknown[] } | undefined> {
    const conn = await instanceA.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
    try {
      const node = conn.document!.getMap(CANVAS_NODES_KEY).get(nodeId);
      if (!(node instanceof Y.Map)) return undefined;
      const data = node.get("data");
      if (!(data instanceof Y.Map)) return undefined;
      const raw = data.get("focusImages");
      if (raw instanceof Y.Array) return { isArray: true, items: raw.toArray() };
      if (Array.isArray(raw)) return { isArray: false, items: raw };
      return undefined;
    } finally {
      await conn.disconnect();
    }
  }

  /** The node's uploading crops as stored, or undefined when the node or list is absent. */
  async function uploadsOf(c: Case, nodeId: string): Promise<unknown[] | undefined> {
    const conn = await instanceA.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
    try {
      const node = conn.document!.getMap(CANVAS_NODES_KEY).get(nodeId);
      const data = node instanceof Y.Map ? node.get("data") : undefined;
      const raw = data instanceof Y.Map ? data.get("focusUploads") : undefined;
      return raw instanceof Y.Array ? raw.toArray() : undefined;
    } finally {
      await conn.disconnect();
    }
  }

  it("shows a crop as uploading in its node until it ends well, then moves it into the pool", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const img = image();
    const upload = uploadOf(img);
    const first = await publishFocus(c, [{ nodeId, image: upload, state: "uploading" }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, first));
    expect(await uploadsOf(c, nodeId)).toEqual([upload]);
    expect(await poolOf(c, nodeId)).toBeUndefined();
    const second = await publishFocus(c, [{ nodeId, image: img }]);
    await until(() => handled(c.streamKey, second));
    expect(await uploadsOf(c, nodeId)).toEqual([]);
    expect(await poolOf(c, nodeId)).toEqual({ isArray: true, items: [img] });
  });

  it("takes away a crop whose upload failed and leaves the pool as it was", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const kept = image();
    await seedPool(c, nodeId, [kept]);
    const img = image();
    const upload = uploadOf(img);
    const ids = await publishFocus(c, [{ nodeId, image: upload, state: "uploading" }, { nodeId, state: "failed", id: img.id as string }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await uploadsOf(c, nodeId)).toEqual([]);
    expect(await poolOf(c, nodeId)).toEqual({ isArray: true, items: [kept] });
  });

  it("never shows again a crop whose uploading step is replayed after its upload ended", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const img = image();
    const upload = uploadOf(img);
    const [openedId, endedId] = await publishFocus(c, [{ nodeId, image: upload, state: "uploading" }, { nodeId, state: "failed", id: img.id as string }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [openedId!, endedId!]));
    const replayed = await publishFocus(c, [{ nodeId, image: upload, state: "uploading" }], ["originId", openedId!]);
    await until(() => handled(c.streamKey, replayed));
    expect(await uploadsOf(c, nodeId)).toEqual([]);
  });

  /** Set the node's pool before the listener starts. */
  async function seedPool(c: Case, nodeId: string, items: unknown[], plain = false): Promise<void> {
    const conn = await instanceA.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
    try {
      await conn.transact((doc) => {
        const data = (doc.getMap(CANVAS_NODES_KEY).get(nodeId) as Y.Map<unknown>).get("data") as Y.Map<unknown>;
        if (plain) data.set("focusImages", items);
        else {
          const arr = new Y.Array<unknown>();
          arr.push(items);
          data.set("focusImages", arr);
        }
      });
    } finally {
      await conn.disconnect();
    }
  }

  it("D-20 and D-27 add the crop to a node with no pool yet", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const img = image();
    const ids = await publishFocus(c, [{ nodeId, image: img }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await poolOf(c, nodeId)).toEqual({ isArray: true, items: [img] });
  });

  it("D-21 leaves a document whose node is gone alone, and acknowledges the event", async () => {
    const c = await newCase({ [randomUUID()]: "image" });
    const ids = await publishFocus(c, [{ nodeId: randomUUID(), image: image() }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await pending(c)).toBe(0);
  });

  it("D-19 adds a replayed crop once", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const img = image();
    const ids = await publishFocus(c, [{ nodeId, image: img }, { nodeId, image: img }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect((await poolOf(c, nodeId))?.items).toEqual([img]);
  });

  it("D-22 leaves a node whose data is not a map alone", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const conn = await instanceA.openDirectConnection(c.docName, { context: { user: { id: "test" } } });
    try {
      await conn.transact((doc) => (doc.getMap(CANVAS_NODES_KEY).get(nodeId) as Y.Map<unknown>).set("data", "not a map"));
    } finally {
      await conn.disconnect();
    }
    const ids = await publishFocus(c, [{ nodeId, image: image() }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await poolOf(c, nodeId)).toBeUndefined();
    expect(await pending(c)).toBe(0);
  });

  it("D-23 adds nothing for an id already in the pool", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const img = image();
    await seedPool(c, nodeId, [img]);
    const ids = await publishFocus(c, [{ nodeId, image: img }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect((await poolOf(c, nodeId))?.items).toEqual([img]);
  });

  it("D-24 adds nothing to a full pool", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const full = Array.from({ length: MAX_FOCUS_ENTRIES }, () => image());
    await seedPool(c, nodeId, full);
    const ids = await publishFocus(c, [{ nodeId, image: image() }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect((await poolOf(c, nodeId))?.items).toHaveLength(MAX_FOCUS_ENTRIES);
  });

  it.each([
    ["a zero width", { width: 0 }],
    ["an over-long address", { url: `https://cdn.test.invalid/${"x".repeat(2100)}` }],
  ])("D-25 adds nothing for an image with %s", async (_label, over) => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const ids = await publishFocus(c, [{ nodeId, image: image(over) }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await poolOf(c, nodeId)).toBeUndefined();
  });

  it("D-26 turns an old plain-array pool into a Y.Array holding the old entries and the new one", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const old = image();
    await seedPool(c, nodeId, [old], true);
    const img = image();
    const ids = await publishFocus(c, [{ nodeId, image: img }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await poolOf(c, nodeId)).toEqual({ isArray: true, items: [old, img] });
  });

  it("D-28 adds nothing to a canvas whose document was deleted, and acknowledges the event", async () => {
    // The ticket does not check the Space exists; a live document is what the crop may land in.
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    await untilUnloaded(c.docName);
    expect(await yjsRepo.softDeleteByName(c.docName)).toBe(true);
    const ids = await publishFocus(c, [{ nodeId, image: image() }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await yjsRepo.restoreByName(c.docName)).toBe(true);
    expect(await poolOf(c, nodeId)).toBeUndefined();
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("D-29 skips a focus event addressed to a document that is not a canvas", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const ids = await publishFocus(c, [{ nodeId, image: image(), docName: `project-${PID}/document-${randomUUID()}` }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await poolOf(c, nodeId)).toBeUndefined();
  });

  it("D-30 adds two crops for one node in stream order", async () => {
    const nodeId = randomUUID();
    const c = await newCase({ [nodeId]: "image" });
    const [first, second] = [image(), image()];
    const ids = await publishFocus(c, [{ nodeId, image: first }, { nodeId, image: second }]);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect((await poolOf(c, nodeId))?.items).toEqual([first, second]);
  });
});

describe("3D Space task versions (#1580)", () => {
  /**
   * A fresh stream, key prefix and empty 3D document.
   * @returns The case's names.
   */
  async function newThreeDCase(): Promise<Case> {
    const c = bareCase(threeDSpaceDocName(PID, randomUUID()));
    await yjsRepo.seedInitialState(c.docName, Y.encodeStateAsUpdate(new Y.Doc()));
    return c;
  }

  it("F-02 writes the stream id of a 3D Space's latest change into its document", async () => {
    const c = await newThreeDCase();
    const ids = await publishSpaceTasksVersion(c, 3);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    expect(await readSpaceTasksVersion(c.docName)).toBe(ids[2]);
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });

  it("F-03 keeps a 3D Space's newer version when an older change is replayed from the dead-letter stream", async () => {
    const c = await newThreeDCase();
    const [olderId, newerId] = await publishSpaceTasksVersion(c, 2);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, [olderId!, newerId!]));
    const replayed = await publishSpaceTasksVersion(c, 1, ["originId", olderId!]);
    await until(() => handled(c.streamKey, replayed));
    expect(await readSpaceTasksVersion(c.docName)).toBe(newerId);
  });

  it("F-04 leaves a deleted 3D Space's stored content as it was", async () => {
    const c = bareCase(threeDSpaceDocName(PID, randomUUID()));
    await seedNote(c.docName, "lamp");
    expect(await yjsRepo.softDeleteByName(c.docName)).toBe(true);
    const ids = await publishSpaceTasksVersion(c);
    listen(c, instanceA, "a");
    await until(() => handled(c.streamKey, ids));
    await untilUnloaded(c.docName);
    expect(await readRestored(c.docName)).toEqual({ note: "lamp", version: undefined });
    expect(await stream.xlen(`${c.streamKey}:dead`)).toBe(0);
  });
});
