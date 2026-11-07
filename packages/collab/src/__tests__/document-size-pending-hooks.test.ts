// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap, second version (inner#1790): the pending-content
 * refusal (v2 collab test spec section 6, design 4.2 step 2a and 4.3
 * `beforeTransaction` / `afterTransaction`), the lifecycle hooks (section 7)
 * and F-11.
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
  beyondDs,
  capture,
  chunk,
  cost,
  enc,
  fillLegacy,
  legacyDoc,
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
  // throw (Hocuspocus then never applies the message).
  activity: { fail: false },
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
    if (activity.fail) throw new Error("activity write failed");
  }),
}));

const { CV, DOC, TD, TL, META, ODD } = NAMES;

type SizeModule = typeof SizeModuleShape;
type FilterModule = typeof FilterModuleShape;

/** The production hooks a case drives. */
interface Hooks {
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
  webSocket: EventEmitter & { send: ReturnType<typeof vi.fn> };
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

/**
 * A fake connection attached to the document's connection set.
 * @param doc - The document.
 * @param opts - Socket, user and read-only flag.
 * @param opts.socketId - Socket id.
 * @param opts.userId - User id.
 * @param opts.readOnly - Read-only flag.
 * @returns The connection.
 */
function conn(doc: Document, opts: { socketId?: string; userId?: string; readOnly?: boolean } = {}): FakeConnection {
  const connection: FakeConnection = {
    socketId: opts.socketId ?? "s1",
    readOnly: opts.readOnly ?? false,
    context: { user: { id: opts.userId ?? "u1", role: "editor" }, seatCap: null, arrivedAtMs: 0 },
    sendStateless: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    messageAddress: doc.name,
    document: doc,
    webSocket: Object.assign(new EventEmitter(), { send: vi.fn() }),
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

/**
 * Expect the step 2a refusal of spec section 6 on connection `c`: closed with
 * the size reason, its `(socket, document)` marked refused, one refusal log
 * line with the 4.2 fields (Q15) and its held cost released.
 * @param doc - The document.
 * @param c - The refused connection.
 * @param expected - `current` at the refusal and the held sum once released.
 * @param expected.current - The record's current size when 2a refused.
 * @param expected.heldSum - The held sum after the release.
 */
function expectPendingRefusal(doc: Document, c: FakeConnection, expected: { current: number; heldSum: number }): void {
  expect(c.close).toHaveBeenCalledTimes(1);
  expect(c.close).toHaveBeenCalledWith(expect.objectContaining({ reason: COLLAB_DOCUMENT_TOO_LARGE_REASON }));
  expect(refusalLogs()).toEqual([
    { documentName: doc.name, userId: c.context.user.id, current: expected.current, limit: D.L, ceiling: D.CEIL, step: "pending" },
  ]);
  expect(rec(doc.name).heldSum).toBe(expected.heldSum);
  expect(w.inbound.isRefused(c.socketId, doc.name)).toBe(true);
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
    expectPendingRefusal(doc, a, { current: before.current + c, heldSum: before.heldSum });
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
    const cases: Array<[number, Uint8Array, string, string]> = [
      [D.L, pendingStructs(777, 2000), "full", "s1"],
      [D.CEIL, pendingStructs(777, 2000), "over_ceiling", "s2"],
      [D.CEIL, beyondDs(4242, 100, 1), "over_ceiling", "s3"],
    ];
    for (const [current, u, step, socketId] of cases) {
      w.size.recordExact(CV, current);
      const a = conn(doc, { socketId });
      await expectGateRefusal(doc, a, SYNC.update, u, step);
      expect(rec(CV)).toMatchObject({ current, heldSum: 0 });
      // Refused in beforeSync, so Hocuspocus never applies it.
      expect(doc.store.pendingStructs).toBeNull();
      expect(doc.store.pendingDs).toBeNull();
      expect(Buffer.from(Y.encodeStateAsUpdate(doc)).equals(Buffer.from(state))).toBe(true);
    }
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
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum });
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
    expect(pendingStructBytes(doc)).toBeLessThanOrEqual(2024);
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
      expect(pendingStructBytes(doc)).toBeLessThanOrEqual(2024);
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
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum });
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

  it("P-12 compares the two pending lengths apart: shorter structs but a longer delete set is refused (Q13)", async () => {
    await boot();
    const doc = await load(CV, legacyDoc());
    const before = pendingOf(doc);
    const a = conn(doc);
    const u = Y.mergeUpdates([fillLegacy(), beyondDs(9999, 50, 1)]);
    const c = cost(u, doc);
    const record = rec(CV);
    await send(doc, a, u);
    expect(pendingOf(doc)).toEqual(before);
    expectPendingRefusal(doc, a, { current: record.current + c, heldSum: record.heldSum });
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

  it("P-15 spends under 1 ms per keystroke in the two listeners with 3 MB of pending structs, decoding nothing", async () => {
    await boot();
    const doc = stored(CV);
    Y.applyUpdate(doc, bigPending());
    expect(pendingStructBytes(doc)).toBeGreaterThan(3_000_000);
    // Time every beforeTransaction / afterTransaction listener production installs.
    const spent = { ms: 0, decodes: 0, wrapped: new Set<string>() };
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
    await runLoadHook(doc);
    expect([...spent.wrapped].sort()).toEqual(["afterTransaction", "beforeTransaction"]);
    const a = conn(doc);
    const client = new Y.Doc();
    client.clientID = 31;
    for (let i = 0; i < 20; i++) {
      const u = capture(client, () => client.getText("t").insert(0, "k"));
      await expect(beforeSync(doc, a, SYNC.update, u)).resolves.toBeUndefined();
      spent.ms = 0;
      spent.decodes = 0;
      applyFrom(doc, a, u);
      expect(spent.ms).toBeLessThan(1);
      expect(spent.decodes).toBe(0);
    }
    expect(a.close).not.toHaveBeenCalled();
  }, 60_000);

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
    expect(rec(CV)).toEqual({ exact: enc(second), current: enc(second), phase: "normal", heldSum: 0 });
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

  it("L-08 afterHandleMessage releases the held cost of a message whose activity write threw", async () => {
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
  });

  it("L-10 a second release after an applied message leaves another connection's held cost alone", async () => {
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
    await afterHandleMessage(doc, a);
    expect(rec(CV).heldSum).toBe(40);
  });

  it("L-11 connected pushes the current doc:size to the arriving connection", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, 9_500_000);
    const arriving = conn(doc);
    await connected(doc, arriving);
    const expected = { type: "doc:size", bytes: 9_500_000, limit: D.L, ceiling: D.CEIL, phase: "warning" };
    expect(pushes(arriving)).toEqual([expected]);
    expect(DocSizeStatusSchema.parse(pushes(arriving)[0])).toEqual(expected);
    expect(Object.keys(pushes(arriving)[0] ?? {}).sort()).toEqual(["bytes", "ceiling", "limit", "phase", "type"]);
  });

  it("L-12 connected pushes the current doc:size to a read-only connection too", async () => {
    await boot();
    const doc = await load(CV);
    w.size.recordExact(CV, 9_500_000);
    const viewer = conn(doc, { readOnly: true });
    await connected(doc, viewer);
    expect(pushes(viewer)).toEqual([{ type: "doc:size", bytes: 9_500_000, limit: D.L, ceiling: D.CEIL, phase: "warning" }]);
  });

  it("L-13 connected pushes limit 0 to every Space type when max_document_bytes is 0 (Q9)", async () => {
    await boot({ max_document_bytes: 0 });
    for (const name of [CV, DOC, TD, TL]) {
      const doc = await load(name);
      const arriving = conn(doc);
      await connected(doc, arriving);
      expect(pushes(arriving)).toEqual([{ type: "doc:size", bytes: 0, limit: 0, ceiling: 0, phase: "normal" }]);
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
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
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

/**
 * Spec P-15: client 777's `Y.Array`, clock 0 withheld, then 300 000
 * single-item inserts at the front in one transaction; string items, so the
 * stored pending structs pass 3 MB.
 * @returns The update that pends on any document lacking clock 0.
 */
function bigPending(): Uint8Array {
  const src = new Y.Doc();
  src.clientID = 777;
  const arr = src.getArray<string>("a");
  arr.insert(0, ["0"]);
  const sv = Y.encodeStateVector(src);
  src.transact(() => {
    for (let i = 0; i < 300_000; i++) arr.insert(0, [`item${i}`]);
  });
  const u = Y.encodeStateAsUpdate(src, sv);
  src.destroy();
  return u;
}
