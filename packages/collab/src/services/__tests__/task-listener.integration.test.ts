// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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

import { createRedisClient, initCore, type Redis } from "@breatic/core";
import { CANVAS_NODES_KEY, type NodeTaskCountsEvent } from "@breatic/shared";
import { bodyToPlainText } from "@breatic/shared/canvas/text-body";
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
