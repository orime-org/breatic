// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Property tests of the document size cap, second version (inner#1790,
 * design 4.1, 4.2 and 8; v2 collab test spec section 11: PR-01 to PR-06).
 *
 * The object under test is the production `beforeSync` that
 * `createCollabServer` hands to the Hocuspocus `Server` (its constructor is
 * replaced by one that records the configuration), driven on a real
 * Hocuspocus `Document` loaded through the production `afterLoadDocument`.
 * An admitted update is applied the way Hocuspocus applies it, with the
 * connection origin, so the production transaction listeners run as well.
 * The record is put in the phase a run needs with `recordExact` under the
 * repository defaults (configuration D); fake timers keep the measure from
 * firing until a case asks for it.
 *
 * Every judgement below is made on the test side, never by the production
 * `updateShape`: PR-01 decodes the update, PR-02 compares the live items of
 * the server document before and after the apply, PR-03 counts split
 * endpoints on the server's struct store by the design 4.1 definition, and
 * only for updates judged at or past the limit (design 4.2 step 2, round 6).
 *
 * Every property runs with a fixed seed.
 */

import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import type * as ConfigModule from "@collab/config.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";

const h = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@hocuspocus/extension-redis", () => ({ Redis: class {} }));

vi.mock("@hocuspocus/server", async (importOriginal) => ({
  ...(await importOriginal<typeof HocuspocusServerModule>()),
  Server: class {
    hocuspocus = { documents: new Map() };
    constructor(config: unknown) {
      h.serverSpy(config);
    }
  },
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  createLogger: () => h.logs,
  createRedisClient: vi.fn(() => ({ on: vi.fn(), subscribe: vi.fn(async () => 1), unsubscribe: vi.fn(async () => 1) })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  accountActivityRepo: { recordActivity: vi.fn(async () => undefined) },
}));

// Spec 0.2 configuration D reaches production through getCollabConfig.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  const { D_CONFIG } = await import("@collab/__tests__/helpers/document-size-fixtures.js");
  const cfg = Object.freeze({ ...real.getCollabConfig(), ...D_CONFIG });
  return { ...real, getCollabConfig: () => cfg };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), register: vi.fn(), unregister: vi.fn(), count: vi.fn(async () => 0) })),
}));

vi.mock("@collab/services/legacy-table-conversion.js", () => ({ convertStoredTablesOnLoad: vi.fn(async () => 0) }));

// The activity half of `beforeSync` writes to Postgres; it is not what these properties measure.
vi.mock("@collab/hooks/account-activity.js", () => ({
  createActivityHook: () => async (): Promise<void> => undefined,
}));

import { Document } from "@hocuspocus/server";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as size from "@collab/services/document-size.js";
import { D, D_CONFIG, beyondDs, capture, enc, syncedClient } from "@collab/__tests__/helpers/document-size-fixtures.js";
import { SYNC, authFrame } from "@collab/__tests__/helpers/live-hocuspocus.js";

const SEED = 1790;
const SPLITS = D_CONFIG.document_size_max_delete_splits;

/** The production hooks the properties drive. */
interface Hooks {
  beforeSync: (payload: unknown) => Promise<void>;
  afterHandleMessage: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
  afterUnloadDocument: (payload: unknown) => Promise<void>;
  receiveFrame: (peer: FakePeer, message: unknown) => Uint8Array | undefined;
  onPeerClose: (peer: FakePeer, event: unknown) => void;
}

/** A crossws peer as the production frame hooks see it. */
interface FakePeer {
  remoteAddress: string;
  _hocuspocus: { socketId: string };
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** A writable connection stand-in (spec 0.4). */
interface FakeConnection {
  socketId: string;
  readOnly: boolean;
  context: { user: { id: string } };
  close: ReturnType<typeof vi.fn>;
  sendStateless: ReturnType<typeof vi.fn>;
}

/** The v2 record as `readDocSizeRecord` returns it (spec Q14). */
interface SizeRecord {
  exact: number;
  current: number;
  phase: string;
  heldSum: number;
}

/** Where a run puts the record before its sequence. */
type Band = "normal" | "warning" | "full" | "over";

/** The shape of a generated document: `nodeDoc`-like nodes plus root text. */
interface DocShape {
  nodes: number;
  textLen: number;
}

/** One generated operation (spec section 11 generators). */
type Op =
  | { kind: "insert"; target: number; at: number; len: number }
  | { kind: "alternate"; xml: boolean; pick: number; at: number; count: number }
  | { kind: "repeatDelete"; pick: number }
  | { kind: "beyondClock"; client: number; offset: number; len: number }
  | { kind: "deleteTypeWithChildren"; what: number; pick: number }
  | { kind: "deleteMapEntry"; pick: number };

/** What one step saw: the record before it, the update, and the outcome. */
interface Step {
  current: number;
  update: Uint8Array;
  admitted: boolean;
}

/** One run's server document, client and connection. */
interface Run {
  name: string;
  doc: Document;
  client: Y.Doc;
  peer: FakePeer;
  conn: FakeConnection;
  nextClientId: number;
  deletes: Uint8Array[];
}

let hooks: Hooks;
let seq = 0;

beforeAll(async () => {
  h.serverSpy.mockClear();
  const started = await createCollabServer({ collabRedisUrl: "redis://localhost:6379/3", port: 1234, redisKeyPrefix: "test", shutdownDeadline: () => undefined });
  await started.storeLoop.stop();
  started.stopUpgradeSessions();
  started.seatHandover.stop();
  hooks = h.serverSpy.mock.calls.at(-1)?.[0] as Hooks;
});

beforeEach(() => {
  vi.useFakeTimers();
  h.logs.error.mockClear();
  h.logs.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const shapeArb: fc.Arbitrary<DocShape> = fc.record({
  nodes: fc.integer({ min: 1, max: 4 }),
  textLen: fc.oneof(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1000, max: 2600 })),
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), target: fc.integer({ min: 0, max: 4 }), at: fc.nat(5000), len: fc.integer({ min: 1, max: 60 }) }),
  fc.record({ kind: fc.constant("alternate" as const), xml: fc.boolean(), pick: fc.nat(10), at: fc.nat(5000), count: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 400, max: 1100 })) }),
  fc.record({ kind: fc.constant("repeatDelete" as const), pick: fc.nat(50) }),
  fc.record({ kind: fc.constant("beyondClock" as const), client: fc.nat(20), offset: fc.integer({ min: -2, max: 10 }), len: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant("deleteTypeWithChildren" as const), what: fc.integer({ min: 0, max: 2 }), pick: fc.nat(10) }),
  fc.record({ kind: fc.constant("deleteMapEntry" as const), pick: fc.nat(20) }),
);

const bandArb: fc.Arbitrary<Band> = fc.constantFrom("normal", "warning", "full", "over");

/**
 * Build the writing client of a run: `nodeDoc`-shaped nodes `n0..` plus root text `t`.
 * @param shape - How many nodes and how much text.
 * @returns The client document (client id 7).
 */
function buildClient(shape: DocShape): Y.Doc {
  const client = new Y.Doc();
  client.clientID = 7;
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  for (let i = 0; i < shape.nodes; i++) {
    const n = new Y.Map<unknown>();
    const data = new Y.Map<unknown>();
    const focus = new Y.Array<string>();
    const body = new Y.XmlFragment();
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    client.transact(() => {
      nodes.set(`n${i}`, n);
      n.set("data", data);
      data.set("locked", true);
      data.set("color", "red");
      n.set("body", body);
      text.insert(0, "hello world");
      paragraph.insert(0, [text]);
      body.insert(0, [paragraph]);
      data.set("focus", focus);
    });
    focus.push(["a"]);
    focus.push(["b"]);
    focus.push(["c"]);
    n.set("name", "x1");
    n.set("name", "x2");
  }
  if (shape.textLen > 0) client.getText("t").insert(0, "x".repeat(shape.textLen));
  return client;
}

/**
 * The v2 record of a document, which must exist.
 * @param name - Document name.
 * @returns The record.
 * @throws {Error} When the document has no record.
 */
function record(name: string): SizeRecord {
  const rec = size.readDocSizeRecord(name) as SizeRecord | undefined;
  if (rec === undefined) throw new Error(`no size record for ${name}`);
  return rec;
}

/**
 * A fresh writable connection of user `u1` on a socket.
 * @param socketId - The socket.
 * @returns The connection.
 */
function connection(socketId: string): FakeConnection {
  return { socketId, readOnly: false, context: { user: { id: "u1" } }, close: vi.fn(), sendStateless: vi.fn() };
}

/**
 * Load a run's document through the production `afterLoadDocument` and put
 * its record in a band.
 * @param shape - The generated document.
 * @param band - Where `current` starts.
 * @param offset - How far into the band `current` starts.
 * @returns The run.
 */
async function open(shape: DocShape, band: Band, offset: number): Promise<Run> {
  seq += 1;
  const name = `project-p1/canvas-pr${seq}`;
  const client = buildClient(shape);
  const doc = new Document(name, undefined, { flushDelay: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(client));
  await hooks.afterLoadDocument({
    documentName: name,
    document: doc,
    context: {},
    instance: { documents: new Map([[name, doc]]) },
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: "",
  });
  const start = {
    normal: enc(doc),
    warning: D.W + (offset % (D.L - D.W)),
    full: D.L + (offset % (D.CEIL - D.L)),
    over: D.CEIL + offset,
  }[band];
  size.recordExact(name, start);
  expect(record(name).current, "recordExact sets current").toBe(start);
  const socketId = `sp${seq}`;
  return {
    name,
    doc,
    client,
    peer: { remoteAddress: "10.0.0.1", _hocuspocus: { socketId }, close: vi.fn(), send: vi.fn() },
    conn: connection(socketId),
    nextClientId: 100,
    deletes: [],
  };
}

/**
 * Unload a run's document and forget its socket.
 * @param run - The run.
 */
async function close(run: Run): Promise<void> {
  await hooks.afterUnloadDocument({ documentName: run.name });
  hooks.onPeerClose(run.peer, {});
  run.doc.destroy();
  run.client.destroy();
  const failed = h.logs.error.mock.calls.filter((call) => call[1] === "document_size_gate_failed");
  expect(failed, "no unexpected exception in the size judgement").toEqual([]);
}

/**
 * The live text of a run's client, root text or a node's paragraph text.
 * @param client - The client.
 * @param xml - Whether to take a node's XmlText.
 * @param pick - Which node.
 * @returns The text, or undefined when there is none.
 */
function textOf(client: Y.Doc, xml: boolean, pick: number): Y.Text | undefined {
  if (!xml) return client.getText("t");
  const xmlTexts = nodeList(client)
    .map((n) => n.get("body"))
    .filter((b): b is Y.XmlFragment => b instanceof Y.XmlFragment && b.length > 0)
    .map((b) => (b.get(0) as Y.XmlElement).get(0))
    .filter((t): t is Y.XmlText => t instanceof Y.XmlText);
  return xmlTexts.length ? xmlTexts[pick % xmlTexts.length] : undefined;
}

/**
 * The node maps of a client, in key order.
 * @param client - The client.
 * @returns The nodes.
 */
function nodeList(client: Y.Doc): Array<Y.Map<unknown>> {
  const nodes = client.getMap<Y.Map<unknown>>("nodes");
  return [...nodes.keys()].sort().map((k) => nodes.get(k)).filter((n): n is Y.Map<unknown> => n instanceof Y.Map);
}

/**
 * The `data` maps of a client's nodes.
 * @param client - The client.
 * @returns The data maps.
 */
function dataMaps(client: Y.Doc): Array<Y.Map<unknown>> {
  return nodeList(client).map((n) => n.get("data")).filter((d): d is Y.Map<unknown> => d instanceof Y.Map);
}

/**
 * Turn an operation into an update against the run's client and server.
 * @param run - The run.
 * @param op - The operation.
 * @returns The V1 update, or undefined when the operation has no target.
 */
function produce(run: Run, op: Op): Uint8Array | undefined {
  const c = run.client;
  switch (op.kind) {
    case "insert": {
      const data = dataMaps(c);
      if (op.target === 1 && data.length) {
        return capture(c, () => data[op.at % data.length]!.set(`k${op.at}`, "v".repeat(op.len)));
      }
      const focus = data.map((d) => d.get("focus")).filter((f): f is Y.Array<string> => f instanceof Y.Array);
      if (op.target === 2 && focus.length) {
        const f = focus[op.at % focus.length]!;
        return capture(c, () => f.insert(op.at % (f.length + 1), Array.from({ length: Math.min(op.len, 8) }, () => "q")));
      }
      const xml = textOf(c, true, op.at);
      if (op.target === 3 && xml) return capture(c, () => xml.insert(op.at % (xml.length + 1), "y".repeat(op.len)));
      if (op.target === 4) {
        return capture(c, () => {
          const n = new Y.Map<unknown>();
          c.getMap<Y.Map<unknown>>("nodes").set(`m${op.at}-${run.nextClientId}`, n);
          n.set("name", "z".repeat(op.len));
        });
      }
      const t = c.getText("t");
      return capture(c, () => t.insert(op.at % (t.length + 1), "y".repeat(op.len)));
    }
    case "alternate": {
      const t = textOf(c, op.xml, op.pick);
      if (!t || t.length < 2) return undefined;
      const start = op.at % t.length;
      const at: number[] = [];
      for (let i = start; i < t.length && at.length < op.count; i += 2) at.push(i);
      const u = capture(c, () => {
        for (const i of at.reverse()) t.delete(i, 1);
      });
      run.deletes.push(u);
      return u;
    }
    case "repeatDelete":
      return run.deletes.length ? run.deletes[op.pick % run.deletes.length] : undefined;
    case "beyondClock": {
      const known = [...run.doc.store.clients.keys()];
      const client = op.client % 2 === 0 && known.length ? known[op.client % known.length]! : 4242 + op.client;
      const clock = Math.max(0, Y.getState(run.doc.store, client) + op.offset);
      const u = beyondDs(client, clock, op.len);
      run.deletes.push(u);
      return u;
    }
    case "deleteTypeWithChildren": {
      const nodes = nodeList(c);
      if (!nodes.length) return undefined;
      const n = nodes[op.pick % nodes.length]!;
      let u: Uint8Array | undefined;
      if (op.what === 0) {
        const key = [...c.getMap("nodes").keys()].sort()[op.pick % nodes.length]!;
        u = capture(c, () => c.getMap("nodes").delete(key));
      } else if (op.what === 1) {
        const body = n.get("body");
        if (!(body instanceof Y.XmlFragment) || body.length === 0) return undefined;
        u = capture(c, () => body.delete(0, 1));
      } else {
        if (!(n.get("data") instanceof Y.Map)) return undefined;
        u = capture(c, () => n.delete("data"));
      }
      run.deletes.push(u);
      return u;
    }
    case "deleteMapEntry": {
      const entries: Array<[Y.Map<unknown>, string]> = [];
      for (const d of dataMaps(c)) {
        d.forEach((value, key) => {
          if (!(value instanceof Y.AbstractType)) entries.push([d, key]);
        });
      }
      if (!entries.length) return undefined;
      const [d, key] = entries[op.pick % entries.length]!;
      const u = capture(c, () => d.delete(key));
      run.deletes.push(u);
      return u;
    }
  }
}

/**
 * Offer one update to the production `beforeSync`; apply it with the
 * connection origin when admitted, then run the production
 * `afterHandleMessage` as Hocuspocus does. After any refusal (in `beforeSync` or by
 * the production transaction listener closing the connection) the refusal
 * mark is cleared with an Auth frame through the production `receiveFrame`,
 * a new connection object stands for the reconnect, and the client reloads
 * from the server under a new client id.
 * @param run - The run.
 * @param update - The update.
 * @param apply - Whether to apply an admitted update (false leaves it held).
 * @returns What the step saw.
 * @throws {Error} When `beforeSync` throws anything but the size refusal.
 */
async function offer(run: Run, update: Uint8Array, apply = true): Promise<Step> {
  const current = record(run.name).current;
  const conn = run.conn;
  let admitted = true;
  try {
    await hooks.beforeSync({ documentName: run.name, document: run.doc, connection: conn, context: conn.context, type: SYNC.update, payload: update, clientsCount: 1 });
  } catch (err) {
    if ((err as { reason?: unknown }).reason !== COLLAB_DOCUMENT_TOO_LARGE_REASON) throw err;
    admitted = false;
  }
  if (admitted && apply) Y.applyUpdate(run.doc, update, { source: "connection", connection: conn });
  // Hocuspocus runs this after every message it handled; the held one is still in flight.
  if (apply) await hooks.afterHandleMessage({ documentName: run.name, document: run.doc, connection: conn, context: conn.context });
  if (!admitted || conn.close.mock.calls.length > 0) {
    const auth = authFrame(run.name, "__cookie_auth__");
    hooks.receiveFrame(run.peer, { rawData: Buffer.from(auth), uint8Array: () => auth, text: () => Buffer.from(auth).toString() });
    run.conn = connection(conn.socketId);
    run.client.destroy();
    run.client = syncedClient(run.doc, run.nextClientId++);
  }
  return { current, update, admitted };
}

/**
 * PR-01's independent judgement: the update carries no structs.
 * @param update - The V1 update.
 * @returns Whether it is a pure delete.
 */
function isPureDelete(update: Uint8Array): boolean {
  return decoding.readVarUint(decoding.createDecoder(update)) === 0 && Y.decodeUpdate(update).structs.length === 0;
}

/**
 * Whether a clock falls strictly inside a live item of a client's structs
 * (after its first clock), by binary search over the server's struct array.
 * @param structs - The client's structs, sorted by clock.
 * @param clock - The clock.
 * @returns Whether a live item holds the clock past its start.
 */
function insideLiveItem(structs: ReadonlyArray<Y.Item | Y.GC>, clock: number): boolean {
  let lo = 0;
  let hi = structs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = structs[mid]!;
    if (clock < s.id.clock) hi = mid - 1;
    else if (clock >= s.id.clock + s.length) lo = mid + 1;
    else return s instanceof Y.Item && !s.deleted && clock > s.id.clock;
  }
  return false;
}

/**
 * PR-03's independent count: delete-range endpoints that fall inside a live
 * item of the server store (design 4.1 `splitEndpoints`), after each client's
 * ranges are sorted and overlapping or adjacent ones merged (design 4.1,
 * round 6).
 * @param update - The V1 update.
 * @param doc - The server document before the update.
 * @returns The endpoint count.
 */
function testSideSplits(update: Uint8Array, doc: Y.Doc): number {
  let n = 0;
  Y.decodeUpdate(update).ds.clients.forEach((ranges, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs) return;
    const merged: Array<[number, number]> = [];
    for (const r of [...ranges].sort((a, b) => a.clock - b.clock)) {
      const last = merged.at(-1);
      if (last && r.clock <= last[1]) last[1] = Math.max(last[1], r.clock + r.len);
      else merged.push([r.clock, r.clock + r.len]);
    }
    for (const [start, end] of merged) {
      if (insideLiveItem(structs, start)) n++;
      if (insideLiveItem(structs, end)) n++;
    }
  });
  return n;
}

/** A live item of the server store as it was before an update. */
interface LiveItem {
  length: number;
  isType: boolean;
  mapEntry: boolean;
}

/** The server store before an update, as PR-02 compares it. */
interface StoreSnapshot {
  live: Map<Y.Item, LiveItem>;
  counts: Map<number, number>;
  pendingDs: number;
}

/**
 * Snapshot the live items, struct counts and pending delete set of a document.
 * @param doc - The server document.
 * @returns The snapshot.
 */
function snapshot(doc: Y.Doc): StoreSnapshot {
  const live = new Map<Y.Item, LiveItem>();
  const counts = new Map<number, number>();
  doc.store.clients.forEach((structs, client) => {
    counts.set(client, structs.length);
    for (const s of structs) {
      if (s instanceof Y.Item && !s.deleted) {
        live.set(s, { length: s.length, isType: s.content instanceof Y.ContentType, mapEntry: s.parentSub !== null });
      }
    }
  });
  return { live, counts, pendingDs: doc.store.pendingDs?.byteLength ?? 0 };
}

/**
 * PR-02's independent judgement after the update was applied to the
 * snapshotted document: every item it turned from live to deleted is a Y
 * type, a Map entry, or under a type item it deleted too; no item was split;
 * no client gained structs; the pending delete set did not grow.
 * @param before - The snapshot taken before the apply.
 * @param doc - The same document after the apply.
 * @returns The violations, empty when the update deleted whole types or entries only.
 */
function wholeTypesViolations(before: StoreSnapshot, doc: Y.Doc): string[] {
  const out: string[] = [];
  const deleted = new Set<Y.Item>();
  for (const [item, was] of before.live) {
    if (item.length < was.length) out.push(`split ${item.id.client}:${item.id.clock}`);
    if (item.deleted) deleted.add(item);
  }
  for (const item of deleted) {
    const was = before.live.get(item)!;
    if (was.isType || was.mapEntry) continue;
    let ancestor = (item.parent as Y.AbstractType<unknown> | null)?._item ?? null;
    let covered = false;
    while (ancestor !== null && !covered) {
      covered = deleted.has(ancestor);
      ancestor = (ancestor.parent as Y.AbstractType<unknown> | null)?._item ?? null;
    }
    if (!covered) out.push(`partial delete ${item.id.client}:${item.id.clock}`);
  }
  doc.store.clients.forEach((structs, client) => {
    if (structs.length > (before.counts.get(client) ?? 0)) out.push(`client ${client} gained structs`);
  });
  if ((doc.store.pendingDs?.byteLength ?? 0) > before.pendingDs) out.push("pendingDs grew");
  return out;
}

const runArb = fc.record({
  shape: shapeArb,
  band: bandArb,
  offset: fc.nat(200_000),
  ops: fc.array(opArb, { minLength: 1, maxLength: 14 }),
});

describe("document size cap properties (v2)", () => {
  it("PR-01 while current is in [limit, ceiling), every admitted update is a pure delete", async () => {
    let judged = 0;
    await fc.assert(
      fc.asyncProperty(runArb, async ({ shape, offset, ops }) => {
        const run = await open(shape, "full", offset);
        for (const op of ops) {
          const u = produce(run, op);
          if (!u) continue;
          const step = await offer(run, u);
          if (step.admitted && step.current >= D.L && step.current < D.CEIL) {
            judged++;
            expect(isPureDelete(u), `admitted ${op.kind} at current ${step.current}`).toBe(true);
          }
        }
        await close(run);
      }),
      { numRuns: 60, seed: SEED },
    );
    expect(judged, "admitted updates judged in the full band").toBeGreaterThan(0);
  });

  it("PR-02 while current is at or past the ceiling, every admitted update deletes whole types or Map entries only", async () => {
    let judged = 0;
    await fc.assert(
      fc.asyncProperty(runArb, async ({ shape, offset, ops }) => {
        const run = await open(shape, "over", offset);
        for (const op of ops) {
          const u = produce(run, op);
          if (!u) continue;
          const current = record(run.name).current;
          const before = current >= D.CEIL ? snapshot(run.doc) : undefined;
          const step = await offer(run, u);
          if (step.admitted && before) {
            judged++;
            expect(wholeTypesViolations(before, run.doc), `admitted ${op.kind} at current ${current}`).toEqual([]);
          }
        }
        await close(run);
      }),
      { numRuns: 60, seed: SEED + 1 },
    );
    expect(judged, "admitted updates judged past the ceiling").toBeGreaterThan(0);
  });

  it("PR-03 once current is at or past the limit, every admitted update has at most document_size_max_delete_splits split endpoints", async () => {
    let judged = 0;
    let over = 0;
    await fc.assert(
      fc.asyncProperty(runArb, async ({ shape, band, offset, ops }) => {
        const run = await open(shape, band, offset);
        for (const op of ops) {
          const u = produce(run, op);
          if (!u) continue;
          const splits = testSideSplits(u, run.doc);
          if (splits > SPLITS) over++;
          const step = await offer(run, u);
          // Design 4.2 step 2 (round 6): below the limit the split count is not checked.
          if (step.admitted && step.current >= D.L) {
            judged++;
            expect(splits, `admitted ${op.kind} in ${band} at current ${step.current}`).toBeLessThanOrEqual(SPLITS);
          }
        }
        await close(run);
      }),
      { numRuns: 60, seed: SEED + 2 },
    );
    expect(judged).toBeGreaterThan(0);
    expect(over, "generated updates past the split limit").toBeGreaterThan(0);
  });

  it("PR-04 in any phase, a document without pending content has none after the admitted updates are applied", async () => {
    await fc.assert(
      fc.asyncProperty(runArb, async ({ shape, band, offset, ops }) => {
        const run = await open(shape, band, offset);
        expect(run.doc.store.pendingStructs).toBeNull();
        expect(run.doc.store.pendingDs).toBeNull();
        for (const op of ops) {
          const u = produce(run, op);
          if (u) await offer(run, u);
        }
        expect(run.doc.store.pendingStructs, "pendingStructs after the sequence").toBeNull();
        expect(run.doc.store.pendingDs, "pendingDs after the sequence").toBeNull();
        await close(run);
      }),
      { numRuns: 60, seed: SEED + 3 },
    );
  });

  it("PR-05 the same construction sent 100 and 1000 times leaves the same size, at the limit and past the ceiling", async () => {
    const constructionArb = opArb.filter((op) => op.kind !== "repeatDelete");
    await fc.assert(
      fc.asyncProperty(shapeArb, constructionArb, fc.constantFrom<Band>("full", "over"), async (shape, op, band) => {
        const run = await open(shape, band, 0);
        const u = produce(run, op);
        fc.pre(u !== undefined);
        let at100 = -1;
        for (let i = 1; i <= 1000; i++) {
          await offer(run, u);
          if (i === 100) at100 = enc(run.doc);
        }
        expect(enc(run.doc), `${op.kind} in ${band}: size after 1000 against after 100`).toBe(at100);
        await close(run);
      }),
      { numRuns: 12, seed: SEED + 4 },
    );
  });

  it("PR-06 after any sequence and one measurement, current equals measure(document) plus the held sum", async () => {
    await fc.assert(
      fc.asyncProperty(runArb, opArb, async ({ shape, band, offset, ops }, last) => {
        const run = await open(shape, band, offset);
        for (const op of ops) {
          const u = produce(run, op);
          if (u) await offer(run, u);
        }
        // One more update admitted but not yet applied stays held across the measurement.
        const pending = produce(run, last);
        if (pending) await offer(run, pending, false);
        size.scheduleMeasure(run.name);
        vi.advanceTimersByTime(D_CONFIG.document_size_measure_interval_ms + 1);
        const rec = record(run.name);
        expect(size.measure(run.doc)).toBe(enc(run.doc));
        expect(rec.current).toBe(size.measure(run.doc) + rec.heldSum);
        expect(rec.exact).toBe(size.measure(run.doc));
        await close(run);
      }),
      { numRuns: 40, seed: SEED + 5 },
    );
  });
});
