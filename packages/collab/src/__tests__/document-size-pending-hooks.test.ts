// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap, second version (inner#1790): the pending-content
 * refusal (v2 collab test spec section 6, design 4.2 step 2a and 4.3
 * `beforeTransaction` / `afterTransaction`), the lifecycle hooks (section 7),
 * F-11, and the round 6 cases of spec section 14a that need lifecycle or
 * transaction hooks (R6-05, R6-07 to R6-09, R6-14 to R6-18, R6-20).
 *
 * Every hook is the one `createCollabServer` hands to the Hocuspocus `Server`
 * (spec 0.4): its constructor is replaced by one that records the
 * configuration. A document is loaded through the production
 * `afterLoadDocument`, which installs the production transaction listeners;
 * a connection's update first passes the production `beforeSync` and is then
 * applied with the origin Hocuspocus gives it,
 * `{ source: "connection", connection }`. Each case boots a fresh module
 * graph, so size records and inbound-filter marks start empty.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Document } from "@hocuspocus/server";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import type * as SizeModuleShape from "@collab/services/document-size.js";
import type * as FilterModuleShape from "@collab/infra/inbound-filter.js";
import type * as YjsModuleShape from "yjs";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, DocSizeStatusSchema, documentBodyFragment } from "@breatic/shared";

import {
  D,
  NAMES,
  S,
  S_CONFIG,
  beyondDs,
  bigNodeUpdate,
  capture,
  chunk,
  cost,
  enc,
  fill,
  fillLegacy,
  legacyDoc,
  pendingCoverage,
  pendingSource,
  pendingStructs,
  syncedClient,
} from "./helpers/document-size-fixtures.js";
import { authFrame, SYNC, syncFrame, WIRE } from "./helpers/live-hocuspocus.js";

const { serverSpy, logger, collabRedis, overrides, activity, yjsCalls, D_HOISTED } = vi.hoisted(() => ({
  // Spec 0.2 configuration D; the fixtures' copy cannot be read inside a hoisted mock.
  D_HOISTED: {
    max_document_bytes: 10_485_760,
    document_size_warn_ratio: 0.9,
    document_size_delete_headroom_bytes: 262_144,
    document_size_max_delete_splits: 1024,
    document_size_measure_interval_ms: 2000,
  },
  serverSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  collabRedis: { on: vi.fn(), publish: vi.fn(async () => 1), set: vi.fn(async (): Promise<string | null> => null) },
  overrides: { current: {} },
  // What the account activity half of `beforeSync` does: `fail` makes it
  // throw (Hocuspocus then never applies the message); `onCall` runs first.
  activity: { fail: false, onCall: undefined as undefined | (() => void) },
  // Calls into yjs made through the module this file mocks (spec L-07, P-15).
  yjsCalls: { encodeStateAsUpdate: 0, decode: 0 },
}));

vi.mock("yjs", async (importOriginal) => {
  const real = await importOriginal<typeof YjsModuleShape>();
  return {
    ...real,
    encodeStateAsUpdate: (...args: Parameters<typeof real.encodeStateAsUpdate>): Uint8Array => {
      yjsCalls.encodeStateAsUpdate++;
      return real.encodeStateAsUpdate(...args);
    },
    decodeUpdate: (...args: Parameters<typeof real.decodeUpdate>): ReturnType<typeof real.decodeUpdate> => {
      yjsCalls.decode++;
      return real.decodeUpdate(...args);
    },
    decodeUpdateV2: (...args: Parameters<typeof real.decodeUpdateV2>): ReturnType<typeof real.decodeUpdateV2> => {
      yjsCalls.decode++;
      return real.decodeUpdateV2(...args);
    },
  };
});

vi.mock("@hocuspocus/server", async (importOriginal) => ({
  ...(await importOriginal<typeof HocuspocusServerModule>()),
  Server: class {
    hocuspocus = { documents: new Map() };
    /**
     * Record the configuration production builds.
     * @param config - The Hocuspocus server configuration.
     */
    constructor(config: unknown) {
      serverSpy(config);
    }
  },
}));

vi.mock("@hocuspocus/extension-redis", () => ({ Redis: class {} }));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModuleShape>()),
  createLogger: () => logger,
  createRedisClient: vi.fn(() => ({ on: vi.fn(), subscribe: vi.fn(async () => 1), unsubscribe: vi.fn(async () => 1) })),
  getRedis: vi.fn(() => ({ on: vi.fn() })),
  getCollabRedis: vi.fn(() => collabRedis),
  getSession: vi.fn(async (_redis: unknown, token: string) => token),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  MONOREPO_ROOT: "/tmp",
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  projectAuthService: { loadProjectRole: vi.fn(async () => "editor") },
  runWithConsent: <T>(_consent: unknown, fn: () => T): T => fn(),
  // The legacy table conversion names its lock key after the environment.
  env: { ENV: "test" },
}));

vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  return {
    ...real,
    getCollabConfig: () => ({ ...real.getCollabConfig(), ...D_HOISTED, ...overrides.current }),
  };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
  staysLoaded: vi.fn(() => false),
  storeDocumentNow: vi.fn(async () => undefined),
}));

// The legacy table conversion reads the stored copy again under its lock.
vi.mock("@collab/services/yjs-documents.repo.js", () => ({
  fetchDocData: vi.fn(async () => null),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    unregister: vi.fn(async () => undefined),
    count: vi.fn(async () => 0),
    takeSeat: vi.fn(async () => ({ outcome: "seated" })),
    hasOwnSeat: vi.fn(async () => "no"),
    refreshSocket: vi.fn(async () => []),
    forgetSeat: vi.fn(async () => undefined),
  })),
}));

vi.mock("@collab/hooks/account-activity.js", () => ({
  createActivityHook: () => vi.fn(async () => {
    activity.onCall?.();
    if (activity.fail) throw new Error("activity write failed");
  }),
}));

const { CV, DOC, TD, TL, META, ODD } = NAMES;

type SizeModule = typeof SizeModuleShape;
type FilterModule = typeof FilterModuleShape;

/** The production hooks a case drives. */
interface Hooks {
  onConnect: (payload: unknown) => Promise<void>;
  onDisconnect: (payload: unknown) => Promise<void>;
  beforeSync: (payload: unknown) => Promise<void>;
  afterHandleMessage: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
  connected: (payload: unknown) => Promise<void>;
  onChange: (payload: unknown) => Promise<void>;
  onStateless: (payload: unknown) => Promise<void>;
  afterUnloadDocument: (payload: unknown) => Promise<void>;
  receiveFrame: (peer: unknown, message: unknown) => Uint8Array | undefined;
}

/** A fake Hocuspocus connection (spec 0.4). */
interface FakeConnection {
  socketId: string;
  readOnly: boolean;
  context: { user: { id: string; role: string }; seatCap: null; arrivedAtMs: number };
  sendStateless: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  messageAddress: string;
  document: Document;
  webSocket: EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  request: Request;
}

/** One booted module graph. */
interface World {
  hooks: Hooks;
  size: SizeModule;
  inbound: FilterModule;
}

let w: World;
const peers = new Map<string, { _hocuspocus: { socketId: string } }>();

/**
 * Boot a fresh `createCollabServer` and take the hooks it registered.
 * @param config - Configuration over configuration D.
 * @returns The hooks and the size and inbound-filter modules of the same graph.
 */
async function boot(config: Record<string, unknown> = {}): Promise<World> {
  overrides.current = config;
  vi.resetModules();
  const size = await import("@collab/services/document-size.js");
  const inbound = await import("@collab/infra/inbound-filter.js");
  const { createCollabServer } = await import("@collab/hocuspocus.js");
  serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 0,
    redisKeyPrefix: "document-size-pending-hooks",
    shutdownDeadline: () => undefined,
  });
  const hooks = serverSpy.mock.calls.at(-1)?.[0] as Hooks;
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  w = { hooks, size, inbound };
  return w;
}

/**
 * A Hocuspocus document holding the stored state, not yet through the load hook.
 * @param name - Document name.
 * @param src - Stored content, if any (pending content included).
 * @returns The document.
 */
function stored(name: string, src?: Y.Doc): Document {
  const doc = new Document(name, undefined, { flushDelay: false });
  if (src) Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
  return doc;
}

/**
 * Run the production `afterLoadDocument` on a document.
 * @param doc - The document.
 * @returns The same document.
 */
async function runLoadHook(doc: Document): Promise<Document> {
  await w.hooks.afterLoadDocument({
    documentName: doc.name,
    document: doc,
    instance: { documents: new Map([[doc.name, doc]]) },
    context: {},
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: "",
  });
  return doc;
}

/**
 * Load a document the way Hocuspocus does: stored state, then the production `afterLoadDocument`.
 * @param name - Document name.
 * @param src - Stored content, if any.
 * @returns The loaded document.
 */
function load(name: string, src?: Y.Doc): Promise<Document> {
  return runLoadHook(stored(name, src));
}

/** Spec 14b.0: the connection parameters every fake connection carries unless a case says otherwise. */
const ACK_PARAMS = "size_ack=1";

/**
 * A fake connection attached to the document's connection set.
 * @param doc - The document.
 * @param opts - Socket, user, read-only flag and connection parameters.
 * @param opts.socketId - Socket id.
 * @param opts.userId - User id.
 * @param opts.readOnly - Read-only flag.
 * @param opts.params - The query string the WebSocket was opened with (default `size_ack=1`).
 * @returns The connection.
 */
function conn(doc: Document, opts: { socketId?: string; userId?: string; readOnly?: boolean; params?: string } = {}): FakeConnection {
  const connection: FakeConnection = {
    socketId: opts.socketId ?? "s1",
    readOnly: opts.readOnly ?? false,
    context: { user: { id: opts.userId ?? "u1", role: "editor" }, seatCap: null, arrivedAtMs: 0 },
    sendStateless: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    messageAddress: doc.name,
    document: doc,
    webSocket: Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() }),
    request: new Request(`http://collab.test/?${opts.params ?? ACK_PARAMS}`),
  };
  doc.addConnection(connection as unknown as Parameters<Document["addConnection"]>[0]);
  return connection;
}

/**
 * Call the production `beforeSync` with Hocuspocus's payload shape.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type (0 SyncStep1, 1 SyncStep2, 2 Update).
 * @param payload - The payload Hocuspocus peeks.
 * @returns The hook's promise.
 */
function beforeSync(doc: Document, c: FakeConnection, type: number, payload: Uint8Array): Promise<void> {
  return w.hooks.beforeSync({
    clientsCount: doc.getConnectionsCount(),
    context: c.context,
    document: doc,
    documentName: doc.name,
    connection: c,
    type,
    payload,
  });
}

/**
 * Apply an update with the origin Hocuspocus gives a connection's message.
 * @param doc - The document.
 * @param c - The connection.
 * @param update - The update.
 */
function applyFrom(doc: Document, c: FakeConnection, update: Uint8Array): void {
  Y.applyUpdate(doc, update, { source: "connection", connection: c });
}

/**
 * Spec 0.4: an Update the production `beforeSync` lets through, then applied as Hocuspocus does.
 * @param doc - The document.
 * @param c - The connection.
 * @param update - The update.
 */
async function send(doc: Document, c: FakeConnection, update: Uint8Array): Promise<void> {
  await expect(beforeSync(doc, c, SYNC.update, update)).resolves.toBeUndefined();
  applyFrom(doc, c, update);
}

/**
 * Call the production `afterHandleMessage` for a connection.
 * @param doc - The document.
 * @param c - The connection.
 * @returns The hook's promise.
 */
function afterHandleMessage(doc: Document, c: FakeConnection): Promise<void> {
  return w.hooks.afterHandleMessage({ documentName: doc.name, document: doc, connection: c, context: c.context });
}

/**
 * The record of a document, failing when there is none.
 * @param name - Document name.
 * @returns Exact size, current size, phase and the sum of held costs.
 */
function rec(name: string): { exact: number; current: number; phase: string; heldSum: number } {
  const record = w.size.readDocSizeRecord(name);
  if (!record) throw new Error(`no size record for ${name}`);
  return record;
}

/**
 * The refusal log lines so far.
 * @returns The first argument of each `document_size_limit_refused` warning.
 */
function refusalLogs(): Array<Record<string, unknown>> {
  return logger.warn.mock.calls
    .filter((call) => call[1] === "document_size_limit_refused")
    .map((call) => call[0] as Record<string, unknown>);
}

/**
 * The `doc:size` pushes a connection received, parsed.
 * @param c - The connection.
 * @returns The pushes, oldest first.
 */
function pushes(c: FakeConnection): Array<Record<string, unknown>> {
  return c.sendStateless.mock.calls
    .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === "doc:size");
}

/**
 * Pass one binary frame through the production `receiveFrame`.
 * @param socketId - Socket id.
 * @param bytes - The frame.
 * @returns What production hands on to Hocuspocus.
 */
function frame(socketId: string, bytes: Uint8Array): Uint8Array | undefined {
  let peer = peers.get(socketId);
  if (!peer) {
    peer = { _hocuspocus: { socketId } };
    peers.set(socketId, peer);
  }
  return w.hooks.receiveFrame(peer, {
    rawData: Buffer.from(bytes),
    uint8Array: () => bytes,
    text: () => Buffer.from(bytes).toString(),
  });
}

/**
 * Bring `(socketId, name)` to the handshaken state through production frames.
 * @param socketId - Socket id.
 * @param name - Document name.
 */
function handshake(socketId: string, name: string): void {
  frame(socketId, authFrame(name, "token"));
  frame(socketId, syncFrame(name, WIRE.sync, SYNC.step2, new Uint8Array([0, 0])));
}

/** The stored pending content of a document, by value. */
interface PendingSnapshot {
  structs: { update: Uint8Array; missing: Array<[number, number]> } | null;
  ds: Uint8Array | null;
}

/**
 * Copy the pending content a document holds.
 * @param doc - The document.
 * @returns Copies of the pending structs (update and missing clocks) and pending delete set.
 */
function pendingOf(doc: Y.Doc): PendingSnapshot {
  const p = doc.store.pendingStructs;
  return {
    structs: p ? { update: p.update.slice(), missing: [...p.missing.entries()] } : null,
    ds: doc.store.pendingDs ? doc.store.pendingDs.slice() : null,
  };
}

/**
 * Bytes of the pending structs a document holds.
 * @param doc - The document.
 * @returns Length of `pendingStructs.update`, 0 with none.
 */
function pendingStructBytes(doc: Y.Doc): number {
  return doc.store.pendingStructs?.update.byteLength ?? 0;
}

/** The pending coverage of design 4.3 (round 6), structs and delete set apart. */
interface Coverage {
  structs: number;
  ds: number;
}

/**
 * Expect the step 2a refusal of spec section 6 on connection `c`: closed with
 * the size reason, its `(socket, document)` marked refused, one refusal log
 * line with the 4.2 fields plus `pendingBefore` / `pendingAfter` (Q15, LG-02)
 * and its held cost released.
 * @param doc - The document.
 * @param c - The refused connection.
 * @param expected - `current` at the refusal and the held sum once released.
 * @param expected.current - The record's current size when 2a refused.
 * @param expected.heldSum - The held sum after the release.
 * @param expected.before - The logged coverage before the transaction, when the case states it.
 * @param expected.after - The logged coverage after the transaction, when the case states it.
 */
function expectPendingRefusal(
  doc: Document,
  c: FakeConnection,
  expected: { current: number; heldSum: number; before?: Coverage; after?: Coverage },
): void {
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.close).toHaveBeenCalledWith(expect.objectContaining({ reason: COLLAB_DOCUMENT_TOO_LARGE_REASON }));
  expect(refusalLogs()).toEqual([
    {
      documentName: doc.name, userId: c.context.user.id, current: expected.current, limit: D.L, ceiling: D.CEIL, step: "pending",
      pendingBefore: expect.anything(), pendingAfter: expect.anything(),
    },
  ]);
  const log = refusalLogs()[0] ?? {};
  if (expected.before) expect(pendingCoverage(log.pendingBefore)).toEqual(expected.before);
  if (expected.after) expect(pendingCoverage(log.pendingAfter)).toEqual(expected.after);
  expect(rec(doc.name).heldSum).toBe(expected.heldSum);
  expect(w.inbound.isRefused(c.socketId, doc.name)).toBe(true);
}

/**
 * Test-side pending structs coverage (design 4.3, round 6): the lengths of
 * the structs `pendingStructs` holds, `Skip` excluded (Q21).
 * @param doc - The document.
 * @returns Clocks covered.
 */
function structsCoverage(doc: Y.Doc): number {
  const p = doc.store.pendingStructs;
  if (!p) return 0;
  return Y.decodeUpdateV2(p.update).structs.reduce((sum, st) => sum + (st instanceof Y.Skip ? 0 : st.length), 0);
}

/**
 * Test-side pending delete set coverage (design 4.3, round 6): the sum of its ranges' lengths.
 * @param doc - The document.
 * @returns Clocks covered.
 */
function dsCoverage(doc: Y.Doc): number {
  const p = doc.store.pendingDs;
  if (!p) return 0;
  let n = 0;
  Y.decodeUpdateV2(p).ds.clients.forEach((ranges) => {
    for (const r of ranges) n += r.len;
  });
  return n;
}

/**
 * Expect the production `beforeSync` to refuse with the size reason and one log line.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param update - The payload.
 * @param step - The `step` the log line carries.
 */
async function expectGateRefusal(doc: Document, c: FakeConnection, type: number, update: Uint8Array, step: string): Promise<void> {
  logger.warn.mockClear();
  const err = await beforeSync(doc, c, type, update).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as { reason?: unknown }).reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  expect(refusalLogs()).toHaveLength(1);
  expect(refusalLogs()[0]).toMatchObject({ documentName: doc.name, userId: c.context.user.id, step });
}

/**
 * Spec P-01: a normal `CV` without pending content, A sends
 * `pendingStructs(777, 2000)`, admitted at step 3 and refused at 2a.
 * @returns The document, A, the update's cost and the record before it.
 */
async function p01(): Promise<{ doc: Document; a: FakeConnection; c: number; before: { current: number; heldSum: number }; state: Uint8Array }> {
  await boot();
  const doc = await load(CV);
  const a = conn(doc);
  handshake(a.socketId, CV);
  const u = pendingStructs(777, 2000);
  const state = Y.encodeStateAsUpdate(doc);
  const c = cost(u, doc);
  const before = rec(CV);
  await send(doc, a, u);
  return { doc, a, c, before, state };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"],
    now: 0,
  });
  peers.clear();
  activity.fail = false;
  activity.onCall = undefined;
  collabRedis.set.mockReset().mockImplementation(async () => null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("section 6: pending content refused by value (design 4.2 step 2a)", () => {
  it("P-01 admits pendingStructs on a normal document at step 3, then 2a refuses it and leaves the document unchanged", async () => {
    const { doc, a, c, before, state } = await p01();
    expect(doc.store.pendingStructs).toBeNull();
    expect(doc.store.pendingDs).toBeNull();
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state))).toBe(true);
    // LG-02: structs coverage 0 -> 2000, pending delete set 0 -> 0.
    expectPendingRefusal(doc, a, { current: before.current + c, heldSum: before.heldSum, before: { structs: 0, ds: 0 }, after: { structs: 2000, ds: 0 } });
  });

  it("P-02 keeps the part of a mixed update that integrates and refuses the part that pends", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const writer = new Y.Doc();
    writer.clientID = 900;
    writer.getText("body").insert(0, "INTEGRATED");
    const u = Y.mergeUpdates([Y.encodeStateAsUpdate(writer), pendingStructs(777, 2000)]);
    const emitted: Uint8Array[] = [];
    doc.on("update", (x: Uint8Array) => emitted.push(x));
    const c = cost(u, doc);
    const before = rec(CV);
    await send(doc, a, u);
    expect(doc.getText("body").toString()).toBe("INTEGRATED");
    expect(doc.store.pendingStructs).toBeNull();
    expect(doc.store.pendingDs).toBeNull();
    expect(emitted.some((x) => Buffer.from(x).includes("INTEGRATED"))).toBe(true);
    expectPendingRefusal(doc, a, { current: before.current + c, heldSum: before.heldSum });
  });

  it("P-03 admits a beyond-clock delete on a normal document, then 2a refuses it", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const u = beyondDs(4242, 100, 1);
    const c = cost(u, doc);
    const before = rec(CV);
    await send(doc, a, u);
    expect(doc.store.pendingDs).toBeNull();
    expectPendingRefusal(doc, a, { current: before.current + c, heldSum: before.heldSum });
  });

  it("P-04 admits a beyond-clock pure delete at full (step 4), then 2a refuses it with step pending", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, D.L);
    const a = conn(doc);
    const u = beyondDs(4242, 100, 1);
    const c = cost(u, doc);
    await send(doc, a, u);
    expect(doc.store.pendingDs).toBeNull();
    expectPendingRefusal(doc, a, { current: D.L + c, heldSum: 0 });
  });

  it("P-05 refuses pending content in beforeSync at full and over the ceiling, by the 4.2 step order (Q2)", async () => {
    await boot();
    const doc = await load(CV);
    const state = Y.encodeStateAsUpdate(doc);
    const knowing = conn(doc, { socketId: "s1" });
    w.size.recordExact(CV, D.L);
    await ack(doc, knowing, lastSeq(knowing));
    const cases: Array<[number, Uint8Array, string, FakeConnection]> = [
      [D.L, pendingStructs(777, 2000), "full", knowing],
      [D.CEIL, pendingStructs(777, 2000), "over_ceiling", conn(doc, { socketId: "s2" })],
      [D.CEIL, beyondDs(4242, 100, 1), "over_ceiling", conn(doc, { socketId: "s3" })],
    ];
    for (const [current, u, step, a] of cases) {
      w.size.recordExact(CV, current);
      await expectGateRefusal(doc, a, SYNC.update, u, step);
      expect(rec(CV)).toMatchObject({ current, heldSum: 0 });
      // Refused in beforeSync, so Hocuspocus never applies it.
      expect(doc.store.pendingStructs).toBeNull();
      expect(doc.store.pendingDs).toBeNull();
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state))).toBe(true);
    }
    w.size.recordExact(CV, D.L);
    const unaware = conn(doc, { socketId: "s4" });
    logger.warn.mockClear();
    await send(doc, unaware, pendingStructs(777, 2000));
    expect(doc.store.pendingStructs).toBeNull();
    expect(doc.store.pendingDs).toBeNull();
    expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state))).toBe(true);
    expect(refusalLogs().map((l) => l.step)).toEqual(["pending"]);
  });

  it("P-06 restores the stored pending content of a legacy document byte for byte", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const before = pendingOf(doc);
    expect(before.structs?.update.byteLength).toBe(2024);
    expect(before.structs?.missing).toEqual([[500, 4]]);
    expect(before.ds?.byteLength).toBe(22);
    const a = conn(doc);
    const u = pendingStructs(778, 5000);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    // Round 6: structs coverage 2000 -> 7000 is what refuses it.
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum, before: { structs: 2000, ds: 3 }, after: { structs: 7000, ds: 3 } });
  });

  it("P-07 restores pending structs yjs grew in place, so the refused characters never reach the document", async () => {
    await boot();
    const chain = pendingChain();
    const src = new Y.Doc();
    Y.applyUpdate(src, chain.mid);
    const doc = await load(CV, src);
    expect(pendingStructBytes(doc)).toBe(1023);
    const a = conn(doc);
    await send(doc, a, chain.tail);
    expect(pendingStructBytes(doc)).toBe(1023);
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(refusalLogs()).toEqual([expect.objectContaining({ step: "pending" })]);
    Y.applyUpdate(doc, chain.head, { source: "redis" });
    expect(doc.getText("t").length).toBe(1010);
  });

  it("P-08 admits an update that integrates the stored pending content and pends no more than it held", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const a = conn(doc);
    await send(doc, a, Y.mergeUpdates([fillLegacy(), chunk(1000, 1900).tail]));
    expect(doc.getText("junk").length).toBe(2005);
    expect(pendingStructBytes(doc)).toBe(1924);
    // Round 6: coverage, not bytes: structs 2000 -> 1900, the delete set's 3 unchanged.
    expect(structsCoverage(doc)).toBe(1900);
    expect(dsCoverage(doc)).toBe(3);
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  });

  it("P-09 keeps trading one pending chunk for another over five more rounds, growing the document by what integrates", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const a = conn(doc);
    await send(doc, a, Y.mergeUpdates([fillLegacy(), chunk(1000, 1900).tail]));
    let size = enc(doc);
    for (let r = 1; r <= 5; r++) {
      const u = Y.mergeUpdates([chunk(1000 + r - 1, 1900).full, chunk(1000 + r, 1900).tail]);
      const c = cost(u, doc);
      const current = rec(CV).current;
      await send(doc, a, u);
      expect(structsCoverage(doc)).toBe(1900);
      expect(pendingStructBytes(doc)).toBe(1924);
      expect(enc(doc)).toBeGreaterThan(size);
      size = enc(doc);
      // No measure has run (the fake clock stands still), so the record moved by the admitted cost.
      expect(rec(CV).current).toBe(current + c);
    }
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  });

  it("P-10 refuses trading in a longer pending chunk, restoring the old pending content while what integrated stays", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const before = pendingOf(doc);
    const a = conn(doc);
    const u = Y.mergeUpdates([fillLegacy(), pendingStructs(778, 5000)]);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    expect(doc.getText("junk").length).toBe(2005);
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum, before: { structs: 2000, ds: 3 }, after: { structs: 5000, ds: 3 } });
  });

  it("P-11 does not refuse an honest member's edit after P-10, and yjs clears the restored pending content without duplicating it", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const a = conn(doc);
    await send(doc, a, Y.mergeUpdates([fillLegacy(), pendingStructs(778, 5000)]));
    expect(a.close).toHaveBeenCalledTimes(1);
    const b = conn(doc, { socketId: "s2", userId: "u2" });
    const client = syncedClient(doc, 901);
    const u = capture(client, () => client.getText("body").insert(0, "!"));
    logger.warn.mockClear();
    await send(doc, b, u);
    expect(b.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
    expect(pendingStructBytes(doc)).toBeLessThanOrEqual(2024);
    expect(doc.getText("junk").length).toBe(2005);
    expect(doc.getText("body").toString()).toBe("!hello world");
  });

  it("P-12 compares the two pending coverages apart: fewer struct clocks but more delete-set clocks is refused (Q13)", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const before = pendingOf(doc);
    const a = conn(doc);
    const u = Y.mergeUpdates([fillLegacy(), beyondDs(9999, 50, 1)]);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum, before: { structs: 2000, ds: 3 }, after: { structs: 0, ds: 4 } });
  });

  it("P-13 does not refuse an update that leaves the pending content as long or shorter", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const a = conn(doc);
    const client = syncedClient(doc, 902);
    await send(doc, a, capture(client, () => client.getText("body").insert(0, "?")));
    expect(pendingStructBytes(doc)).toBe(2024);
    // Applied, so afterTransaction released what beforeSync held for it.
    expect(rec(CV).heldSum).toBe(0);
    await send(doc, a, fillLegacy());
    expect(pendingStructBytes(doc)).toBe(0);
    expect(rec(CV).heldSum).toBe(0);
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  });

  it("P-14 leaves pending content from non-connection origins alone and measures it", async () => {
    for (const origin of [{ source: "redis" }, null]) {
      await boot();
      const doc = await load(CV);
      const watcher = conn(doc);
      Y.applyUpdate(doc, pendingStructs(777, 2000), origin);
      expect(pendingStructBytes(doc)).toBe(2024);
      expect(watcher.close).not.toHaveBeenCalled();
      expect(refusalLogs()).toEqual([]);
      vi.advanceTimersByTime(D_HOISTED.document_size_measure_interval_ms);
      expect(w.size.measure(doc)).toBe(enc(doc));
      expect(rec(CV).exact).toBe(enc(doc));
    }
  });

  it("P-15 spends under 1 ms per keystroke in the two listeners with 3 MB of pending structs, decoding nothing while the pending object is unchanged", async () => {
    await boot();
    const doc = stored(CV);
    Y.applyUpdate(doc, bigPending());
    expect(pendingStructBytes(doc)).toBe(3_191_776);
    const spent = instrumentListeners(doc);
    await runLoadHook(doc);
    expect([...spent.wrapped].sort()).toEqual(["afterTransaction", "beforeTransaction"]);
    const a = conn(doc);
    const client = new Y.Doc();
    client.clientID = 31;
    for (let i = 0; i < 20; i++) {
      const u = capture(client, () => client.getText("t").insert(0, "k"));
      await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
      const pendingBefore = doc.store.pendingStructs?.update;
      spent.ms = 0;
      spent.decodes = 0;
      applyFrom(doc, a, u);
      expect(doc.store.pendingStructs?.update).toBe(pendingBefore);
      expect(spent.ms).toBeLessThan(1);
      expect(spent.decodes).toBe(0);
    }
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  }, 120_000);

  it("P-16 refuses the next queued Update of a 2a-refused connection at step 0", async () => {
    const { doc, a } = await p01();
    const client = new Y.Doc();
    client.clientID = 41;
    const next = capture(client, () => client.getText("t").insert(0, "after"));
    await expectGateRefusal(doc, a, SYNC.update, next, "after_refusal");
  });

  it("P-17 releases the refused update's held cost; current keeps it until the next measure", async () => {
    const { doc, c, before } = await p01();
    expect(rec(CV).heldSum).toBe(before.heldSum);
    expect(rec(CV).current).toBe(before.current + c);
    vi.advanceTimersByTime(D_HOISTED.document_size_measure_interval_ms);
    expect(rec(CV)).toMatchObject({ exact: enc(doc), current: enc(doc), heldSum: 0 });
    expect(w.size.measure(doc)).toBe(enc(doc));
  });
});

describe("F-11: the inbound filter after a 2a refusal", () => {
  it("F-11 drops the connection's next Update frame once afterTransaction refused it", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    handshake(a.socketId, CV);
    const probe = syncFrame(CV, WIRE.sync, SYNC.update, new Uint8Array([0, 0]));
    expect(frame(a.socketId, probe)).not.toBeUndefined();
    await send(doc, a, pendingStructs(777, 2000));
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(frame(a.socketId, probe)).toBeUndefined();
  });
});

describe("section 7: lifecycle hooks (design 4.3)", () => {
  it("L-01 afterLoadDocument records the exact size after the legacy table conversion", async () => {
    await boot();
    collabRedis.set.mockImplementation(async () => "OK");
    const src = storedTableDoc();
    const doc = stored(DOC, src);
    const beforeConversion = enc(doc);
    await runLoadHook(doc);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ reason: "doc_table_migrated" }), "doc_table_migrated");
    expect(enc(doc)).not.toBe(beforeConversion);
    expect(rec(DOC)).toMatchObject({ exact: enc(doc), current: enc(doc), heldSum: 0 });
  });

  it("L-02 afterLoadDocument installs both transaction listeners; after afterUnloadDocument a transaction measures nothing and does not throw", async () => {
    await boot();
    const doc = stored(CV);
    const baseline = { before: listenerCount(doc, "beforeTransaction"), after: listenerCount(doc, "afterTransaction") };
    await runLoadHook(doc);
    expect(listenerCount(doc, "beforeTransaction")).toBeGreaterThan(baseline.before);
    expect(listenerCount(doc, "afterTransaction")).toBeGreaterThan(baseline.after);
    const a = conn(doc);
    await w.hooks.afterUnloadDocument({ instance: { documents: new Map() }, documentName: CV });
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
    a.sendStateless.mockClear();
    const client = new Y.Doc();
    client.clientID = 51;
    expect(() => applyFrom(doc, a, capture(client, () => client.getText("t").insert(0, "late")))).not.toThrow();
    vi.advanceTimersByTime(10_000);
    expect(pushes(a)).toEqual([]);
    expect(a.close).not.toHaveBeenCalled();
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
  });

  it("L-03 a reload after unload starts a new record, unrelated to the old one", async () => {
    await boot();
    const first = await load(CV);
    const a = conn(first);
    const client = new Y.Doc();
    client.clientID = 61;
    // Admitted but never applied: the old record holds it.
    await expect(beforeSync(first, a, SYNC.update, capture(client, () => client.getText("t").insert(0, "held")))).resolves.toBeUndefined();
    expect(rec(CV).heldSum).toBeGreaterThan(0);
    await w.hooks.afterUnloadDocument({ instance: { documents: new Map() }, documentName: CV });
    const src = new Y.Doc();
    src.clientID = 62;
    src.getText("t").insert(0, "y".repeat(1980));
    const second = await load(CV, src);
    expect(rec(CV)).toEqual({ exact: enc(second), current: enc(second), phase: "normal", heldSum: 0, seen: new Map() });
  });

  it("L-04 onChange adds update.byteLength for every non-connection origin", async () => {
    await boot();
    const doc = await load(CV);
    for (const [i, origin] of ([{ source: "redis" }, null, { source: "local" }] as const).entries()) {
      const u = updateOfLength(500, 70 + i);
      expect(u.byteLength).toBe(500);
      Y.applyUpdate(doc, u, origin);
      const before = rec(CV).current;
      await change(doc, u, origin);
      expect(rec(CV).current).toBe(before + 500);
    }
  });

  it("L-05 onChange leaves current alone for a connection's update", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const u = updateOfLength(500, 80);
    const origin = { source: "connection", connection: a };
    const loaded = enc(doc);
    Y.applyUpdate(doc, u, origin);
    await change(doc, u, origin);
    // Nothing admitted it and no measure ran, so current is still the size at load.
    expect(rec(CV).current).toBe(loaded);
  });

  it("L-06 onChange builds no record for meta, an unparseable name or a deployment without a limit", async () => {
    await boot();
    for (const name of [META, ODD]) {
      const doc = await load(name);
      await expect(change(doc, updateOfLength(500, 81), { source: "redis" })).resolves.toBeUndefined();
      expect(w.size.readDocSizeRecord(name)).toBeUndefined();
    }
    await boot({ max_document_bytes: 0 });
    const doc = await load(CV);
    await expect(change(doc, updateOfLength(500, 82), { source: "redis" })).resolves.toBeUndefined();
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
  });

  it("L-07 onChange encodes no full state and logs no full-encode warning", async () => {
    await boot();
    const doc = await load(CV);
    const u = updateOfLength(500, 83);
    Y.applyUpdate(doc, u, { source: "redis" });
    yjsCalls.encodeStateAsUpdate = 0;
    await change(doc, u, { source: "redis" });
    expect(yjsCalls.encodeStateAsUpdate).toBe(0);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "Document exceeds max size limit");
  });

  it("L-08 afterHandleMessage releases the held cost of a message whose activity write threw and schedules the measure that takes it out of current", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const before = rec(CV).heldSum;
    activity.fail = true;
    const client = new Y.Doc();
    client.clientID = 84;
    await expect(beforeSync(doc, a, SYNC.update, capture(client, () => client.getText("t").insert(0, "x")))).rejects.toThrow("activity write failed");
    expect(rec(CV).heldSum).toBeGreaterThan(before);
    await afterHandleMessage(doc, a);
    expect(rec(CV).heldSum).toBe(before);
    a.sendStateless.mockClear();
    vi.advanceTimersByTime(D_HOISTED.document_size_measure_interval_ms);
    expect(rec(CV).current).toBe(enc(doc));
    expect(pushes(a).at(-1)).toMatchObject({ bytes: enc(doc) });
  });

  it("L-09 afterHandleMessage releases the held cost of a message skipped because the connection turned read-only", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const before = rec(CV);
    const client = new Y.Doc();
    client.clientID = 85;
    const u = capture(client, () => client.getText("t").insert(0, "x"));
    const c = cost(u, doc);
    await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
    a.readOnly = true;
    await afterHandleMessage(doc, a);
    expect(rec(CV).heldSum).toBe(before.heldSum);
    expect(rec(CV).current).toBe(before.current + c);
    // Round 6: the measure afterHandleMessage scheduled takes the unapplied cost out.
    vi.advanceTimersByTime(D_HOISTED.document_size_measure_interval_ms);
    expect(rec(CV).current).toBe(enc(doc));
  });

  it("L-10 a second release after an applied message returns false and leaves another connection's held cost alone", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    const b = conn(doc, { socketId: "s2", userId: "u2" });
    const client = new Y.Doc();
    client.clientID = 86;
    const u = capture(client, () => client.getText("t").insert(0, "x"));
    await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
    w.size.admit(CV, b, 40);
    applyFrom(doc, a, u);
    expect(rec(CV).heldSum).toBe(40);
    // afterTransaction already removed A's entry: a second release removes nothing and says so.
    expect(w.size.release(CV, a)).toBe(false);
    await afterHandleMessage(doc, a);
    expect(rec(CV).heldSum).toBe(40);
  });

  it("L-11 connected pushes the current doc:size to the arriving connection", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, 9_500_000);
    const arriving = conn(doc);
    await connected(doc, arriving);
    const expected = { type: "doc:size", seq: expect.any(Number), bytes: 9_500_000, limit: D.L, ceiling: D.CEIL, phase: "warning" };
    expect(pushes(arriving)).toEqual([expected]);
    expect(DocSizeStatusSchema.parse(pushes(arriving)[0])).toEqual(expected);
    expect(Object.keys(pushes(arriving)[0] ?? {}).sort()).toEqual(["bytes", "ceiling", "limit", "phase", "seq", "type"]);
  });

  it("L-12 connected pushes the current doc:size to a read-only connection too", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, 9_500_000);
    const viewer = conn(doc, { readOnly: true });
    await connected(doc, viewer);
    expect(pushes(viewer)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: 9_500_000, limit: D.L, ceiling: D.CEIL, phase: "warning" }]);
  });

  it("L-13 connected pushes limit 0 to every Space type when max_document_bytes is 0 (Q9)", async () => {
    await boot({ max_document_bytes: 0 });
    for (const name of [CV, DOC, TD, TL]) {
      const doc = await load(name);
      const arriving = conn(doc);
      await connected(doc, arriving);
      expect(pushes(arriving)).toEqual([{ type: "doc:size", seq: 0, bytes: 0, limit: 0, ceiling: 0, phase: "normal" }]);
    }
  });

  it("L-14 connected pushes nothing on meta or an unparseable name", async () => {
    await boot();
    for (const name of [META, ODD]) {
      const doc = await load(name);
      const arriving = conn(doc);
      await connected(doc, arriving);
      expect(pushes(arriving)).toEqual([]);
    }
  });

  it("L-15 onStateless answers sync:confirm on canvas and document with sync:confirmed only, no doc:size after it", async () => {
    await boot();
    for (const name of [CV, DOC]) {
      const doc = await load(name);
      for (const readOnly of [false, true]) {
        const c = conn(doc, { socketId: `s-${String(readOnly)}`, readOnly });
        const id = randomUUID();
        await w.hooks.onStateless({ connection: c, documentName: name, document: doc, payload: JSON.stringify({ type: "sync:confirm", id }) });
        const sent = c.sendStateless.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
        expect(sent).toEqual([{ type: "sync:confirmed", id, ok: !readOnly }]);
      }
    }
  });

  it("L-16 onStateless does not answer sync:confirm on a timeline", async () => {
    await boot();
    const doc = await load(TL);
    const c = conn(doc);
    await w.hooks.onStateless({ connection: c, documentName: TL, document: doc, payload: JSON.stringify({ type: "sync:confirm", id: randomUUID() }) });
    expect(c.sendStateless).not.toHaveBeenCalled();
  });
});

describe("round 6: an admit, onChange or measure that crosses the hard ceiling pushes (spec 14a.2)", () => {
  it("R6-05 onChange crossing the hard ceiling while already full pushes once; the next change does not", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, 10_747_000);
    const a = conn(doc);
    const b = conn(doc, { socketId: "s2", userId: "u2" });
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    const first = updateOfLength(1500, 87);
    Y.applyUpdate(doc, first, { source: "local" });
    await change(doc, first, { source: "local" });
    expect(rec(CV).current).toBe(10_748_500);
    const crossed = { type: "doc:size", seq: expect.any(Number), bytes: 10_748_500, limit: D.L, ceiling: D.CEIL, phase: "full" };
    expect(pushes(a)).toEqual([crossed]);
    expect(pushes(b)).toEqual([crossed]);
    // The shortest insert update is 11 bytes (one character).
    const second = updateOfLength(11, 88);
    Y.applyUpdate(doc, second, { source: "local" });
    await change(doc, second, { source: "local" });
    expect(rec(CV).current).toBe(10_748_511);
    expect(pushes(a)).toEqual([crossed]);
    expect(pushes(b)).toEqual([crossed]);
  });
});

/** How an admitted message ends up not applied (spec 14a.3). */
type Unapplied = "activity_threw" | "turned_read_only" | "unknown_sync_type";

/**
 * Spec 14a.3: configuration S, `CV` filled to 229 989 bytes and loaded at
 * t=0 with connections A and B; at t=5000 A's 40 032-byte new node `big` is
 * admitted (current 270 021, full) and never applied. After the production
 * `afterHandleMessage(A)` the next measure takes it out again ("corrected").
 * @param how - Why Hocuspocus does not apply it.
 */
async function unappliedIsCorrected(how: Unapplied): Promise<void> {
  await boot(S_CONFIG);
  const src = new Y.Doc();
  expect(fill(src, 230_000)).toBe(229_989);
  const doc = await load(CV, src);
  expect(rec(CV)).toMatchObject({ current: 229_989, phase: "normal" });
  const a = conn(doc);
  const b = conn(doc, { socketId: "s2", userId: "u2" });
  vi.advanceTimersByTime(5000);
  const big = bigNodeUpdate(doc);
  expect(big.byteLength).toBe(40_032);
  a.sendStateless.mockClear();
  b.sendStateless.mockClear();

  if (how === "activity_threw") {
    activity.fail = true;
    await expect(beforeSync(doc, a, SYNC.update, big)).rejects.toThrow("activity write failed");
  } else if (how === "turned_read_only") {
    activity.onCall = () => {
      a.readOnly = true;
    };
    await expect(beforeSync(doc, a, SYNC.update, big)).resolves.toBeUndefined();
  } else {
    // Design 4.2 step 1 skips only SyncStep1, so an unknown sub-type is judged and admitted.
    await expect(beforeSync(doc, a, 3, big)).resolves.toBeUndefined();
  }
  const admitted = rec(CV).current;
  expect(rec(CV).phase).toBe("full");
  const full = { type: "doc:size", seq: expect.any(Number), bytes: admitted, limit: S.L, ceiling: S.CEIL, phase: "full" };
  expect(pushes(a)).toEqual([full]);
  expect(pushes(b)).toEqual([full]);

  await afterHandleMessage(doc, a);
  expect(rec(CV).heldSum).toBe(0);
  vi.advanceTimersByTime(S_CONFIG.document_size_measure_interval_ms);
  expect(rec(CV)).toMatchObject({ exact: 229_989, current: 229_989, phase: "normal", heldSum: 0 });
  for (const c of [a, b]) {
    expect(pushes(c).at(-1)).toEqual({ type: "doc:size", seq: expect.any(Number), bytes: 229_989, limit: S.L, ceiling: S.CEIL, phase: "normal" });
  }
  expect(doc.getMap("nodes").has("big")).toBe(false);
  // Round 6 cost: the message length.
  expect(admitted).toBe(270_021);
}

describe("round 6: an admitted message that is never applied is measured out of current (spec 14a.3)", () => {
  it("R6-07 its activity write threw", async () => {
    await unappliedIsCorrected("activity_threw");
  });

  it("R6-08 the connection turned read-only while its activity write ran", async () => {
    await unappliedIsCorrected("turned_read_only");
  });

  it("R6-09 it came with an unknown sync sub-type (3)", async () => {
    await unappliedIsCorrected("unknown_sync_type");
  });
});

/**
 * Spec R6-14: client 1000 types 200 characters one transaction each; client
 * 2000 deletes clocks 100-199; the server holds the first 100 and the delete
 * (pending delete set 18 bytes, coverage 100).
 * @returns The server document and the writer's state at 130 characters.
 */
function partlyResolvableDs(): { legacy: Y.Doc; upTo130: Y.Doc } {
  const x = new Y.Doc();
  x.clientID = 1000;
  const snaps: Uint8Array[] = [];
  for (let i = 0; i < 200; i++) {
    x.getText("t").insert(i, "a");
    snaps.push(Y.encodeStateAsUpdate(x));
  }
  const deleter = new Y.Doc();
  deleter.clientID = 2000;
  Y.applyUpdate(deleter, snaps[199] as Uint8Array);
  const cut = capture(deleter, () => deleter.getText("t").delete(100, 100));
  expect(cut.byteLength).toBe(7);
  const legacy = new Y.Doc();
  Y.applyUpdate(legacy, snaps[99] as Uint8Array);
  Y.applyUpdate(legacy, cut);
  const upTo130 = new Y.Doc();
  Y.applyUpdate(upTo130, snaps[129] as Uint8Array);
  return { legacy, upTo130 };
}

/**
 * Spec R6-16 `d602`: client 602 inserts 5 characters into `getText("gone")`,
 * then 10 000 more and deletes those 10 000; the update after the first five
 * with its delete set replaced by an empty one (one 10 000-long
 * `ContentDeleted` item, 12 bytes).
 * @returns The update.
 * @throws {Error} When the delete set is not the expected tail.
 */
function deletedRunWithoutDs(): Uint8Array {
  const g = new Y.Doc();
  g.clientID = 602;
  const t = g.getText("gone");
  t.insert(0, "aaaaa");
  const sv = Y.encodeStateVector(g);
  t.insert(0, "z".repeat(10_000));
  t.delete(0, 10_000);
  const full = Y.encodeStateAsUpdate(g, sv);
  // varuints 1 client, 602, 1 range, clock 5, len 10 000.
  const dsTail = [1, 0xda, 0x04, 1, 5, 0x90, 0x4e];
  if (!Buffer.from(full.slice(full.length - 7)).equals(Buffer.from(dsTail))) throw new Error("unexpected delete set tail");
  return Uint8Array.from([...full.slice(0, full.length - 7), 0]);
}

/**
 * Spec R6-17: client 500's source of `legacyDoc` (`pendingStructs(500, 2000)`),
 * then 500 `"g"` (clocks 2005-2504, withheld) and 100 `"h"` (clocks
 * 2505-2604); the update of the last 100 only.
 * @returns The update.
 */
function client500After500(): Uint8Array {
  const e = new Y.Doc();
  e.clientID = 500;
  const t = e.getText("junk");
  for (let i = 0; i < 5; i++) t.insert(0, "a");
  t.insert(0, "z".repeat(2000));
  t.insert(0, "g".repeat(500));
  const sv = Y.encodeStateVector(e);
  t.insert(0, "h".repeat(100));
  return Y.encodeStateAsUpdate(e, sv);
}

describe("round 6: pending content compared by the clocks it covers (spec 14a.5)", () => {
  it("R6-14 a partly resolved legacy pending delete set grows in bytes but shrinks in coverage, so nothing is refused", async () => {
    await boot();
    const { legacy, upTo130 } = partlyResolvableDs();
    const doc = await load(CV, legacy);
    expect(doc.store.pendingDs?.byteLength).toBe(18);
    expect(dsCoverage(doc)).toBe(100);
    const a = conn(doc);
    const u = Y.encodeStateAsUpdate(upTo130, Y.encodeStateVector(doc));
    expect(u.byteLength).toBe(41);
    await send(doc, a, u);
    expect(doc.store.pendingDs?.byteLength).toBe(19);
    expect(dsCoverage(doc)).toBe(70);
    expect(a.close).not.toHaveBeenCalled();
    expect(w.inbound.isRefused(a.socketId, CV)).toBe(false);
    for (let i = 0; i < 3; i++) {
      const writer = conn(doc, { socketId: `w${i}`, userId: `uw${i}` });
      const client = syncedClient(doc, 3000 + i);
      await send(doc, writer, capture(client, () => client.getMap("m").set(`k${i}`, 1)));
      expect(writer.close).not.toHaveBeenCalled();
      expect(doc.store.pendingDs?.byteLength).toBe(19);
    }
    expect(refusalLogs()).toEqual([]);
  });

  it("R6-15 a beyond-clock delete raising the pending delete set's coverage from 3 to 8 is refused and logged with both coverages", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const before = pendingOf(doc);
    const a = conn(doc);
    const u = beyondDs(4242, 200, 5);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    expect(doc.store.pendingDs?.byteLength).toBe(22);
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum, before: { structs: 2000, ds: 3 }, after: { structs: 2000, ds: 8 } });
  });

  it("R6-16 pending structs that shrink in bytes but grow in coverage (2000 to 10 000) are refused", async () => {
    await boot();
    const src = new Y.Doc();
    src.getText("body").insert(0, "hello");
    Y.applyUpdate(src, pendingStructs(500, 2000));
    const doc = await load(CV, src);
    const before = pendingOf(doc);
    expect(before.structs?.update.byteLength).toBe(2024);
    expect(before.structs?.missing).toEqual([[500, 4]]);
    expect(before.ds).toBeNull();
    const d602 = deletedRunWithoutDs();
    expect(d602.byteLength).toBe(12);
    const u = Y.mergeUpdates([pendingSource(500, 2000).full, d602]);
    expect(u.byteLength).toBe(2055);
    const a = conn(doc);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    expect(doc.getText("junk").length).toBe(2005);
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum, before: { structs: 2000, ds: 0 }, after: { structs: 10_000, ds: 0 } });
  });

  it("R6-17 a Skip inside the pending structs is not coverage, so trading 500 clocks for 100 behind a gap is not refused", async () => {
    await boot();
    const src = legacyDoc();
    Y.applyUpdate(src, pendingStructs(501, 500));
    const doc = await load(CV, src);
    expect(pendingStructBytes(doc)).toBe(2532);
    expect(doc.store.pendingStructs?.missing).toEqual(new Map([[500, 4], [501, 4]]));
    expect(structsCoverage(doc)).toBe(2500);
    const u = Y.mergeUpdates([pendingSource(501, 500).full, client500After500()]);
    expect(u.byteLength).toBe(656);
    const a = conn(doc);
    await send(doc, a, u);
    expect(pendingStructBytes(doc)).toBe(2134);
    expect(structsCoverage(doc)).toBe(2100);
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  });

  it("R6-18 keystrokes on a document holding both kinds of pending content decode neither while they are unchanged", async () => {
    await boot();
    const doc = stored(CV, legacyDoc());
    const spent = instrumentListeners(doc);
    await runLoadHook(doc);
    const a = conn(doc);
    const client = syncedClient(doc, 33);
    for (let i = 0; i < 20; i++) {
      const u = capture(client, () => client.getText("body").insert(0, "k"));
      await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
      const structsBefore = doc.store.pendingStructs?.update;
      spent.decodes = 0;
      applyFrom(doc, a, u);
      expect(doc.store.pendingStructs?.update).toBe(structsBefore);
      expect(doc.store.pendingDs?.byteLength).toBe(22);
      expect(spent.decodes).toBe(0);
    }
    expect(a.close).not.toHaveBeenCalled();
    expect(refusalLogs()).toEqual([]);
  });
});

describe("round 6: no refusal mark for a connection no longer in the document (spec 14a.6)", () => {
  it("R6-20 a 2a refusal after the connection left the document restores the pending content and logs, but marks nothing", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    handshake(a.socketId, CV);
    const u = pendingStructs(777, 2000);
    const before = rec(CV);
    await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
    doc.removeConnection(a as unknown as Parameters<Document["removeConnection"]>[0]);
    applyFrom(doc, a, u);
    expect(doc.store.pendingStructs).toBeNull();
    expect(refusalLogs()).toEqual([expect.objectContaining({ step: "pending" })]);
    expect(rec(CV).heldSum).toBe(before.heldSum);
    expect(w.inbound.isRefused(a.socketId, CV)).toBe(false);
  });
});

/**
 * Call the production `connected` hook for a connection.
 * @param doc - The document.
 * @param c - The arriving connection.
 * @returns The hook's promise.
 */
function connected(doc: Document, c: FakeConnection): Promise<void> {
  return w.hooks.connected({
    documentName: doc.name,
    socketId: c.socketId,
    context: c.context,
    instance: { documents: new Map([[doc.name, doc]]) },
    connection: c,
    connectionConfig: { readOnly: c.readOnly },
    request: c.request,
    requestHeaders: new Headers(),
    requestParameters: new URL(c.request.url).searchParams,
  });
}

/**
 * Call the production `onChange` the way Hocuspocus does after an update applied.
 * @param doc - The document.
 * @param update - The applied update.
 * @param origin - Its transaction origin.
 * @returns The hook's promise.
 */
function change(doc: Document, update: Uint8Array, origin: unknown): Promise<void> {
  return w.hooks.onChange({
    instance: { documents: new Map([[doc.name, doc]]) },
    clientsCount: 0,
    document: doc,
    documentName: doc.name,
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: "",
    update,
    transactionOrigin: origin,
    connection: undefined,
    context: {},
  });
}

/**
 * How many listeners a document has for an event (lib0 `ObservableV2` keeps them in `_observers`).
 * @param doc - The document.
 * @param name - The event.
 * @returns The listener count.
 */
function listenerCount(doc: Y.Doc, name: string): number {
  return (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get(name)?.size ?? 0;
}

/**
 * A real insert update of exactly `bytes` bytes, written by its own client.
 * @param bytes - The update length wanted.
 * @param clientID - The writing client (below 128, so its id takes one byte).
 * @returns The V1 update.
 * @throws {Error} When the length cannot be hit.
 */
function updateOfLength(bytes: number, clientID: number): Uint8Array {
  /**
   * The update of one insert of `n` characters.
   * @param n - Characters.
   * @returns The V1 update.
   */
  const insertOf = (n: number): Uint8Array => {
    const client = new Y.Doc();
    client.clientID = clientID;
    return capture(client, () => client.getText("t").insert(0, "x".repeat(n)));
  };
  const overhead = insertOf(bytes).byteLength - bytes;
  const u = insertOf(bytes - overhead);
  if (u.byteLength !== bytes) throw new Error(`update of ${u.byteLength} bytes, wanted ${bytes}`);
  return u;
}

/**
 * A document body holding one stored (pre inner#1619) table, which the load hook converts.
 * @returns The document.
 */
function storedTableDoc(): Y.Doc {
  const doc = new Y.Doc();
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "b1");
  const table = new Y.XmlElement("table");
  table.setAttribute("textColor", "default");
  const row = new Y.XmlElement("tableRow");
  const cell = new Y.XmlElement("tableCell");
  for (const [name, value] of Object.entries({ colspan: 1, rowspan: 1, backgroundColor: "default", textColor: "default", textAlignment: "left" })) {
    cell.setAttribute(name, value as never);
  }
  const line = new Y.XmlElement("tableParagraph");
  const text = new Y.XmlText();
  text.insert(0, "cell");
  line.insert(0, [text]);
  cell.insert(0, [line]);
  row.insert(0, [cell]);
  table.insert(0, [row]);
  container.insert(0, [table]);
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, [container]);
  documentBodyFragment(doc).insert(0, [group]);
  return doc;
}

/**
 * Spec P-07: client 7 inserts ten single characters (withheld), then 1000,
 * then 5000 more at the front of `getText("t")`.
 * @returns The withheld head, the middle that pends without it (1023 bytes stored) and the tail after the middle.
 */
function pendingChain(): { head: Uint8Array; mid: Uint8Array; tail: Uint8Array } {
  const e = new Y.Doc();
  e.clientID = 7;
  const t = e.getText("t");
  for (let i = 0; i < 10; i++) t.insert(0, "a");
  const head = Y.encodeStateAsUpdate(e);
  const sv1 = Y.encodeStateVector(e);
  t.insert(0, "m".repeat(1000));
  const mid = Y.encodeStateAsUpdate(e, sv1);
  const sv2 = Y.encodeStateVector(e);
  t.insert(0, "z".repeat(5000));
  const tail = Y.encodeStateAsUpdate(e, sv2);
  e.destroy();
  return { head, mid, tail };
}

/** What `instrumentListeners` measured. */
interface ListenerSpend {
  /** Milliseconds spent in the wrapped listeners since last reset. */
  ms: number;
  /** yjs decode calls made inside the wrapped listeners since last reset. */
  decodes: number;
  /** The events whose listeners were wrapped. */
  wrapped: Set<string>;
}

/**
 * Time every `beforeTransaction` / `afterTransaction` listener installed on
 * the document from now on, and count the yjs decodes made inside them.
 * @param doc - The document, before the load hook installs its listeners.
 * @returns The running totals.
 */
function instrumentListeners(doc: Document): ListenerSpend {
  const spent: ListenerSpend = { ms: 0, decodes: 0, wrapped: new Set<string>() };
  const realOn = doc.on.bind(doc) as (name: string, f: (...args: unknown[]) => void) => void;
  (doc as unknown as { on: (name: string, f: (...args: unknown[]) => void) => void }).on = (name, f): void => {
    if (name !== "beforeTransaction" && name !== "afterTransaction") return realOn(name, f);
    spent.wrapped.add(name);
    realOn(name, (...args: unknown[]): void => {
      const decodes = yjsCalls.decode;
      const t0 = performance.now();
      f(...args);
      spent.ms += performance.now() - t0;
      spent.decodes += yjsCalls.decode - decodes;
    });
  };
  return spent;
}

/**
 * Spec P-15 (round 6): client 777's `Y.Array`, clock 0 withheld, then
 * 800 000 single-item inserts of numbers at the front in one transaction, so
 * the stored pending structs are 3 191 776 bytes (`spec-r6/collab/p15.mjs`).
 * @returns The update that pends on any document lacking clock 0.
 */
function bigPending(): Uint8Array {
  const src = new Y.Doc();
  src.clientID = 777;
  const arr = src.getArray<number>("a");
  arr.insert(0, [0]);
  const sv = Y.encodeStateVector(src);
  src.transact(() => {
    for (let i = 0; i < 800_000; i++) arr.insert(0, [i]);
  });
  const u = Y.encodeStateAsUpdate(src, sv);
  src.destroy();
  return u;
}

/** What the record keeps per connection (design 4.1, round 7). */
interface Seen {
  changes: Array<{ seq: number; full: boolean }>;
  knowsFull: boolean;
}

/** The round 7 record functions of design 4.1. */
interface AckApi {
  acknowledge: (name: string, connection: unknown, seq: number) => void;
  knowsFull: (name: string, connection: unknown) => boolean;
}

/**
 * The round 7 record functions, failing clearly while they do not exist.
 * @returns `acknowledge` and `knowsFull` of the booted record module.
 */
function ackApi(): AckApi {
  const mod = w.size as unknown as Record<string, unknown>;
  expect(typeof mod.acknowledge, "services/document-size exports acknowledge").toBe("function");
  expect(typeof mod.knowsFull, "services/document-size exports knowsFull").toBe("function");
  return { acknowledge: mod.acknowledge as AckApi["acknowledge"], knowsFull: mod.knowsFull as AckApi["knowsFull"] };
}

/**
 * Whether the record says a connection acknowledged a full push last.
 * @param name - Document name.
 * @param c - The connection.
 * @returns The production `knowsFull`.
 */
function knows(name: string, c: FakeConnection): boolean {
  return ackApi().knowsFull(name, c);
}

/**
 * What the record keeps for one connection, read through `readDocSizeRecord`'s `seen`.
 * @param name - Document name.
 * @param c - The connection.
 * @returns Its entry, or undefined with none.
 * @throws {Error} When the document has no record or the record exposes no `seen`.
 */
function seenOf(name: string, c: FakeConnection): Seen | undefined {
  const record = w.size.readDocSizeRecord(name) as unknown as { seen?: { get: (k: unknown) => unknown; has: (k: unknown) => boolean } } | undefined;
  if (!record) throw new Error(`no size record for ${name}`);
  if (!record.seen) throw new Error(`size record of ${name} exposes no seen: ${JSON.stringify(record)}`);
  return record.seen.get(c) as Seen | undefined;
}

/**
 * Spec 14b.0 `ack(conn, seq)`: a `doc:size-seen` sent through the production `onStateless`.
 * @param doc - The document.
 * @param c - The connection.
 * @param seq - The acknowledged push.
 * @returns The hook's promise.
 */
function ack(doc: Document, c: FakeConnection, seq: unknown): Promise<void> {
  return stateless(doc, c, JSON.stringify({ type: "doc:size-seen", seq }));
}

/**
 * Send a raw stateless payload through the production `onStateless`.
 * @param doc - The document.
 * @param c - The connection.
 * @param payload - The payload.
 * @returns The hook's promise.
 */
function stateless(doc: Document, c: FakeConnection, payload: string): Promise<void> {
  return w.hooks.onStateless({ connection: c, documentName: doc.name, document: doc, payload });
}

/**
 * Spec 14b.0 `lastSeq(conn)`: the `seq` of the last `doc:size` the connection received.
 * @param c - The connection.
 * @returns The seq.
 * @throws {Error} When it received none.
 */
function lastSeq(c: FakeConnection): number {
  const last = pushes(c).at(-1);
  if (!last) throw new Error(`${c.socketId} received no doc:size`);
  return last.seq as number;
}

/**
 * The seqs of every `doc:size` a connection received.
 * @param c - The connection.
 * @returns The seqs, oldest first.
 */
function seqs(c: FakeConnection): unknown[] {
  return pushes(c).map((p) => p.seq);
}

/**
 * A connection arriving the way Hocuspocus brings it in: the production
 * `onConnect` and `connected` with its connection parameters (spec 14b.0).
 * @param doc - The document.
 * @param c - The connection, already in the document.
 * @returns Nothing.
 */
async function arrive(doc: Document, c: FakeConnection): Promise<void> {
  await w.hooks.onConnect({
    documentName: doc.name,
    socketId: c.socketId,
    context: c.context,
    instance: { documents: new Map([[doc.name, doc]]) },
    connectionConfig: { readOnly: c.readOnly },
    request: c.request,
    requestHeaders: new Headers(),
    requestParameters: new URL(c.request.url).searchParams,
  });
  await connected(doc, c);
}

/**
 * A connection leaving the way Hocuspocus closes it: out of the document, then the production `onDisconnect`.
 * @param doc - The document.
 * @param c - The connection.
 * @returns Nothing.
 */
async function leave(doc: Document, c: FakeConnection): Promise<void> {
  doc.removeConnection(c as unknown as Parameters<Document["removeConnection"]>[0]);
  await w.hooks.onDisconnect({
    documentName: doc.name,
    document: doc,
    socketId: c.socketId,
    context: c.context,
    clientsCount: doc.getConnectionsCount(),
    instance: { documents: new Map([[doc.name, doc]]) },
    requestHeaders: new Headers(),
    requestParameters: new URL(c.request.url).searchParams,
  });
}

/**
 * Spec SH-12 on a fresh client: a new node `n2` with `name: "abc"`.
 * @param doc - The document.
 * @param clientID - The new client's id.
 * @returns The update.
 */
function insertNode(doc: Y.Doc, clientID: number): Uint8Array {
  const client = syncedClient(doc, clientID);
  return capture(client, () => {
    const n2 = new Y.Map<unknown>();
    client.getMap<Y.Map<unknown>>("nodes").set("n2", n2);
    n2.set("name", "abc");
  });
}

describe("round 7: push seq and acknowledgement (spec 14b.3)", () => {
  it("R7-13 every push carries a seq one above the previous push of the document; one pushAll is one seq; documents count apart", async () => {
    await boot();
    const cv = await load(CV);
    const other = await load(DOC);
    const a = conn(cv, { socketId: "s1" });
    const b = conn(cv, { socketId: "s2", userId: "u2" });
    const d = conn(other, { socketId: "s3" });
    await arrive(cv, a);
    await arrive(other, d);
    w.size.recordExact(CV, 9_000_000);
    w.size.recordExact(DOC, 1000);
    w.size.admit(CV, a, 500_000);
    w.size.addApplied(DOC, 10);
    w.size.recordExact(DOC, 2000);
    w.size.addApplied(CV, 1_300_000);
    await arrive(cv, b);
    for (const c of [a, b, d]) {
      for (const p of pushes(c)) expect(DocSizeStatusSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
    expect(pushes(a).map((p) => p.phase)).toEqual(["normal", "normal", "warning", "full"]);
    const first = lastSeq(a) - 3;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(seqs(a)).toEqual([first, first + 1, first + 2, first + 3]);
    expect(seqs(b)).toEqual([first + 1, first + 2, first + 3, first + 4]);
    const dFirst = (seqs(d)[0] as number) ?? -1;
    expect(seqs(d)).toEqual([dFirst, dFirst + 1, dFirst + 2]);
  });

  it("R7-14 acknowledge takes the last change at or below the seq and drops the ones before it; an older one then changes nothing", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    w.size.recordExact(CV, D.W);
    w.size.recordExact(CV, D.L);
    w.size.recordExact(CV, D.L + 5);
    const [warning, full, fullAgain] = seqs(a) as number[];
    expect(pushes(a).map((p) => p.phase)).toEqual(["warning", "full", "full"]);
    const api = ackApi();
    api.acknowledge(CV, a, full as number);
    expect(api.knowsFull(CV, a)).toBe(true);
    api.acknowledge(CV, a, warning as number);
    expect(api.knowsFull(CV, a)).toBe(true);
    api.acknowledge(CV, a, fullAgain as number);
    expect(api.knowsFull(CV, a)).toBe(true);
    expect(seenOf(CV, a)?.changes.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("R7-15 an out-of-order older acknowledgement does not bring back full", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    w.size.recordExact(CV, D.L);
    w.size.recordExact(CV, D.W);
    const [full, warning] = seqs(a);
    await ack(doc, a, warning);
    expect(knows(CV, a)).toBe(false);
    await ack(doc, a, full);
    expect(knows(CV, a)).toBe(false);
  });

  it("R7-16 acknowledging a seq past the connection's last push, or below its first, changes nothing", async () => {
    await boot();
    const doc = await load(CV);
    const early = conn(doc, { socketId: "s0" });
    await arrive(doc, early);
    const a = conn(doc);
    w.size.recordExact(CV, D.L);
    const mine = lastSeq(a);
    const other = conn(doc, { socketId: "s2", userId: "u2" });
    await arrive(doc, other);
    expect(lastSeq(other)).toBe(mine + 1);
    expect(seqs(a)).toEqual([mine]);
    const before = seenOf(CV, a)?.changes.length;
    for (const seq of [999, mine + 1, mine - 1]) await ack(doc, a, seq);
    expect(knows(CV, a)).toBe(false);
    expect(seenOf(CV, a)?.changes.length).toBe(before);
  });

  it("R7-43 an acknowledgement of a seq sent only to another connection takes the connection's last change below it", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    w.size.recordExact(CV, D.W);
    const other = conn(doc, { socketId: "s2", userId: "u2" });
    await arrive(doc, other);
    w.size.recordExact(CV, D.L);
    const [warning, full] = seqs(a) as number[];
    expect(seqs(other)[0]).toBe((warning as number) + 1);
    expect(full).toBe((warning as number) + 2);
    await ack(doc, a, (warning as number) + 1);
    expect(knows(CV, a)).toBe(false);
    await ack(doc, a, full);
    expect(knows(CV, a)).toBe(true);
  });

  it("R7-44 a connection that never acknowledges keeps a change list that grows with phase changes, not with pushes", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    w.size.recordExact(CV, 100);
    const afterFirst = seenOf(CV, a)?.changes.length ?? 0;
    expect(afterFirst).toBeLessThanOrEqual(1);
    for (let i = 1; i < 1000; i++) w.size.recordExact(CV, 100 + i);
    expect(pushes(a)).toHaveLength(1000);
    expect(seenOf(CV, a)?.changes.length ?? 0).toBe(afterFirst);
    for (let i = 0; i < 10; i++) w.size.recordExact(CV, i % 2 === 0 ? D.L : D.W);
    expect(seenOf(CV, a)?.changes.length ?? 0).toBeLessThanOrEqual(afterFirst + 10);
  });

  it("R7-45 with max_document_bytes 0 the connected push has seq 0 and acknowledgements are ignored", async () => {
    await boot({ max_document_bytes: 0 });
    for (const name of [CV, DOC]) {
      const doc = await load(name);
      const a = conn(doc);
      await arrive(doc, a);
      expect(pushes(a)).toEqual([{ type: "doc:size", seq: 0, bytes: 0, limit: 0, ceiling: 0, phase: "normal" }]);
      a.sendStateless.mockClear();
      await expect(ack(doc, a, 0)).resolves.toBeUndefined();
      await expect(ack(doc, a, 5)).resolves.toBeUndefined();
      expect(a.sendStateless).not.toHaveBeenCalled();
      expect(w.size.readDocSizeRecord(name)).toBeUndefined();
    }
  });

  it("R7-17 onStateless ignores malformed acknowledgements without answering and accepts one with an extra key", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    w.size.recordExact(CV, D.L);
    const s = lastSeq(a);
    a.sendStateless.mockClear();
    logger.error.mockClear();
    for (const payload of [
      JSON.stringify({ type: "doc:size-seen" }),
      JSON.stringify({ type: "doc:size-seen", seq: -1 }),
      JSON.stringify({ type: "doc:size-seen", seq: 1.5 }),
      JSON.stringify({ type: "doc:size-seen", seq: String(s) }),
    ]) {
      await expect(stateless(doc, a, payload)).resolves.toBeUndefined();
    }
    await expect(stateless(doc, a, "not json")).resolves.toBeUndefined();
    expect(knows(CV, a)).toBe(false);
    expect(a.sendStateless).not.toHaveBeenCalled();
    await stateless(doc, a, JSON.stringify({ type: "doc:size-seen", seq: s, extra: 1 }));
    expect(knows(CV, a)).toBe(true);
    expect(a.sendStateless).not.toHaveBeenCalled();
  });

  it("R7-18 document, 3d and timeline Spaces take acknowledgements too; meta and an unparseable name ignore them", async () => {
    await boot();
    for (const name of [DOC, TD, TL]) {
      const doc = await load(name);
      const a = conn(doc);
      w.size.recordExact(name, D.L);
      const s = lastSeq(a);
      a.sendStateless.mockClear();
      await ack(doc, a, s);
      expect(knows(name, a), name).toBe(true);
      expect(a.sendStateless).not.toHaveBeenCalled();
    }
    for (const name of [META, ODD]) {
      const doc = await load(name);
      const a = conn(doc);
      await expect(ack(doc, a, 0)).resolves.toBeUndefined();
      expect(a.sendStateless).not.toHaveBeenCalled();
    }
  });

  it("R7-19 a new connection on the same socket starts not knowing full, and the closed one's entry is gone", async () => {
    await boot();
    const doc = await load(CV);
    const a = conn(doc);
    await arrive(doc, a);
    w.size.recordExact(CV, D.L);
    await ack(doc, a, lastSeq(a));
    expect(knows(CV, a)).toBe(true);
    await leave(doc, a);
    const again = conn(doc);
    await arrive(doc, again);
    expect(knows(CV, again)).toBe(false);
    expect(rec(CV).current).toBeGreaterThanOrEqual(D.L);
    expect(rec(CV).current).toBeLessThan(D.CEIL);
    await expect(beforeSync(doc, again, SYNC.update, insertNode(doc, 71))).resolves.toBeUndefined();
    expect(seenOf(CV, a)).toBeUndefined();
  });

  it("R7-20 a reloaded document's record keeps no acknowledgement from before the unload", async () => {
    await boot();
    const first = await load(CV);
    const a = conn(first);
    await arrive(first, a);
    w.size.recordExact(CV, D.L);
    await ack(first, a, lastSeq(a));
    expect(knows(CV, a)).toBe(true);
    await w.hooks.afterUnloadDocument({ documentName: CV, instance: { documents: new Map() } });
    const second = await load(CV);
    const back = conn(second);
    await arrive(second, back);
    w.size.recordExact(CV, D.L);
    expect(seenOf(CV, a)).toBeUndefined();
    expect(knows(CV, a)).toBe(false);
    expect(knows(CV, back)).toBe(false);
  });
});

describe("round 7: an old page's socket is closed on a step 2a refusal (spec 14b.5 R7-46)", () => {
  /**
   * Spec P-01 for one connection: normal `CV`, A sends `pendingStructs(777, 2000)`,
   * admitted, applied, refused at step 2a.
   * @param params - A's connection parameters.
   * @param outOfDocument - Take A out of the document before the update applies (R6-20).
   * @returns A and whether the refusal marked its socket.
   */
  async function refusedAt2a(params: string, outOfDocument: boolean): Promise<{ a: FakeConnection; marked: boolean; doc: Document; state: Uint8Array }> {
    await boot();
    const doc = await load(CV);
    const a = conn(doc, { params });
    await arrive(doc, a);
    const state = Y.encodeStateAsUpdate(doc);
    const u = pendingStructs(777, 2000);
    await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
    if (outOfDocument) doc.removeConnection(a as unknown as Parameters<Document["removeConnection"]>[0]);
    logger.warn.mockClear();
    applyFrom(doc, a, u);
    return { a, marked: w.inbound.isRefused(a.socketId, CV), doc, state };
  }

  it("R7-46 closes the whole WebSocket only for a connection without size_ack=1 still in the document", async () => {
    for (const [params, out, closes] of [["", false, 1], [ACK_PARAMS, false, 0], ["", true, 0]] as const) {
      const { a, marked, doc, state } = await refusedAt2a(params, out);
      const label = `params "${params}", out of document ${String(out)}`;
      expect(doc.store.pendingStructs, label).toBeNull();
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state)), label).toBe(true);
      expect(refusalLogs().map((l) => l.step), label).toEqual(["pending"]);
      expect(a.webSocket.close, label).toHaveBeenCalledTimes(closes);
      expect(marked, label).toBe(!out);
    }
  });
});
