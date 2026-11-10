// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap as the production `beforeSync` enforces it
 * (inner#1790, second version): steps 0-5 of design 4.2 (v2 collab test spec
 * section 5), the bounds of design 4.2 (section 10), the refusal log fields
 * (section 12), the inbound filter seeing a `beforeSync` refusal (F-10), an
 * unexpected exception in the size judgement (Q8) and a record that failed
 * to be created (Q17), and the round 6 cases of spec section 14a that run
 * through `beforeSync` (R6-01, R6-02, R6-06, R6-11, R6-12, R6-19, R6-21).
 * Pending-content and lifecycle cases live in
 * `document-size-pending-hooks.test.ts`.
 *
 * Every hook is the one `createCollabServer` hands to the Hocuspocus `Server`
 * (spec 0.4): the constructor is replaced by one that records the
 * configuration, and each case calls the recorded functions with a real
 * Hocuspocus `Document` carrying fake connections. Nothing re-implements a
 * hook. Each case boots a fresh module graph, so size records and inbound
 * filter marks start empty. Timers and `Date` are faked and never advanced,
 * so no scheduled measurement corrects a `current` a case has set.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Document } from "@hocuspocus/server";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import type * as SizeModuleShape from "@collab/services/document-size.js";
import type * as FilterModuleShape from "@collab/infra/inbound-filter.js";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";
import { updateShape } from "@breatic/shared/update-shape";

import {
  C,
  D,
  NAMES,
  S_CONFIG,
  alt2000,
  beyondDs,
  capture,
  cost,
  enc,
  handshakeStep2,
  nodeDoc,
  offlineDeletes,
  pendingCoverage as coverage,
  reconnectStep2,
  pendingStructs,
  step1Payload,
  syncedClient,
  type NodeDoc,
} from "./helpers/document-size-fixtures.js";
import { authFrame, SYNC, syncFrame, WIRE } from "./helpers/live-hocuspocus.js";

const { serverSpy, logger, rateLimit, rateRedis, collabRedis, overrides, activity, refusalSteps } = vi.hoisted(() => {
  // Every refusal step logged by any case of this file (G-22).
  const steps: unknown[] = [];
  return {
    serverSpy: vi.fn(),
    refusalSteps: steps,
    logger: {
      info: vi.fn(),
      warn: vi.fn((fields: unknown, message?: unknown): void => {
        if (message === "document_size_limit_refused") steps.push((fields as { step?: unknown }).step);
      }),
      error: vi.fn(),
      debug: vi.fn(),
    },
    // Never reset: G-22 asserts no case of this file reached it.
    rateLimit: vi.fn(async (): Promise<unknown> => ({ allowed: true })),
    rateRedis: { on: vi.fn(), name: "db0-rate-limit-redis" },
    collabRedis: { on: vi.fn(), publish: vi.fn(async () => 1), set: vi.fn(async () => null) },
    overrides: { current: {} },
    // The account activity half of `beforeSync`: a spy that may hang on
    // `hold`, and `onCall` to read the size record at the moment it runs.
    activity: {
      spy: vi.fn<(data: unknown) => Promise<void>>(),
      hold: undefined as undefined | Promise<void>,
      onCall: undefined as undefined | (() => void),
    },
  };
});

vi.mock("@hocuspocus/server", async (importOriginal) => ({
  ...(await importOriginal<typeof HocuspocusServerModule>()),
  Server: class {
    hocuspocus = { documents: new Map() };
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
  getRedis: vi.fn(() => rateRedis),
  getCollabRedis: vi.fn(() => collabRedis),
  getSession: vi.fn(async (_redis: unknown, token: string) => token),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  MONOREPO_ROOT: "/tmp",
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  projectAuthService: { loadProjectRole: vi.fn(async () => "editor") },
  runWithConsent: <T>(_consent: unknown, fn: () => T): T => fn(),
  checkRateLimit: rateLimit,
}));

// Spec 0.2 configuration D, plus a case's overrides.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  const { D_CONFIG } = await import("./helpers/document-size-fixtures.js");
  return {
    ...real,
    getCollabConfig: () => ({ ...real.getCollabConfig(), ...D_CONFIG, ...overrides.current }),
  };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
  staysLoaded: vi.fn(() => false),
  storeDocumentNow: vi.fn(async () => undefined),
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
  createActivityHook: () => (data: unknown) => activity.spy(data),
}));

const { CV, DOC, META, ODD } = NAMES;
const L = D.L;
const CEIL = D.CEIL;
const REFUSED = "document_size_limit_refused";

type SizeModule = typeof SizeModuleShape;
type FilterModule = typeof FilterModuleShape;

/** A refusal step of design 4.2 and Q8. */
type Step = "after_refusal" | "splits" | "pending" | "full" | "over_ceiling" | "error";

/** The v2 size record as `readDocSizeRecord` reports it. */
interface SizeRecord {
  exact: number;
  current: number;
  phase: "normal" | "warning" | "full";
  heldSum: number;
}

/** The production hooks a case drives. */
interface Hooks {
  onConnect: (payload: unknown) => Promise<void>;
  connected: (payload: unknown) => Promise<void>;
  onStateless: (payload: unknown) => Promise<void>;
  beforeSync: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
  receiveFrame: (peer: unknown, message: unknown) => Uint8Array | undefined;
  onPeerClose: (peer: unknown, event: unknown) => void;
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
  filter: FilterModule;
}

/** A crossws peer stand-in. */
interface Peer {
  _hocuspocus: { socketId: string };
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

let w: World;
const peers = new Map<string, Peer>();

/**
 * Boot a fresh `createCollabServer` and take the hooks it registered.
 * @param config - Configuration over configuration D.
 * @returns The hooks and the size and filter modules of the same module graph.
 */
async function boot(config: Record<string, unknown> = {}): Promise<World> {
  overrides.current = config;
  vi.resetModules();
  const size = await import("@collab/services/document-size.js");
  const filter = await import("@collab/infra/inbound-filter.js");
  const { createCollabServer } = await import("@collab/hocuspocus.js");
  serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 0,
    redisKeyPrefix: "document-size-hooks",
    shutdownDeadline: () => undefined,
  });
  const hooks = serverSpy.mock.calls.at(-1)?.[0] as Hooks;
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  w = { hooks, size, filter };
  return w;
}

/**
 * Load a document the way Hocuspocus does: a `Document` with the stored
 * state, then the production `afterLoadDocument`.
 * @param name - Document name.
 * @param src - Stored content, if any.
 * @param opts - Load options.
 * @param opts.failMeasure - Make encoding the document throw while the hook runs (Q17).
 * @returns The loaded document.
 */
async function load(name: string, src?: Y.Doc, opts: { failMeasure?: boolean } = {}): Promise<Document> {
  const doc = new Document(name, undefined, { flushDelay: false });
  if (src) Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
  const store = doc.store as unknown as Record<string, unknown>;
  const saved = store.pendingStructs;
  if (opts.failMeasure) {
    // `encodeStateAsUpdate` reads the pending structs, so measuring throws.
    Object.defineProperty(store, "pendingStructs", {
      configurable: true,
      get(): never {
        throw new Error("injected measure failure");
      },
    });
  }
  try {
    await w.hooks.afterLoadDocument({
      documentName: name,
      document: doc,
      instance: { documents: new Map([[name, doc]]) },
      context: {},
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
      socketId: "",
    });
  } finally {
    if (opts.failMeasure) {
      delete store.pendingStructs;
      store.pendingStructs = saved;
    }
  }
  return doc;
}

/**
 * The peer object of a socket, the same one for the same socket.
 * @param socketId - Socket id.
 * @returns The peer.
 */
function peerOf(socketId: string): Peer {
  let peer = peers.get(socketId);
  if (!peer) {
    peer = { _hocuspocus: { socketId }, close: vi.fn(), send: vi.fn() };
    peers.set(socketId, peer);
  }
  return peer;
}

/**
 * Pass one binary frame through the production `receiveFrame`.
 * @param socketId - Socket id.
 * @param bytes - The frame.
 * @returns What production hands on to Hocuspocus.
 */
function frame(socketId: string, bytes: Uint8Array): Uint8Array | undefined {
  return w.hooks.receiveFrame(peerOf(socketId), {
    rawData: Buffer.from(bytes),
    uint8Array: () => bytes,
    text: () => Buffer.from(bytes).toString(),
  });
}

/**
 * Authenticate a document on a socket and pass its handshake SyncStep2
 * through production frames: clears a refusal mark, sets the handshake mark.
 * @param socketId - Socket id.
 * @param name - Document name.
 */
function handshake(socketId: string, name: string): void {
  frame(socketId, authFrame(name, "token"));
  frame(socketId, syncFrame(name, WIRE.sync, SYNC.step2, new Uint8Array([0, 0])));
}

/**
 * Whether production `receiveFrame` hands the next Update frame of a document on.
 * @param socketId - Socket id.
 * @param name - Document name.
 * @returns True when the frame passes.
 */
function updateFramePasses(socketId: string, name: string): boolean {
  return frame(socketId, syncFrame(name, WIRE.sync, SYNC.update, new Uint8Array([0, 0]))) !== undefined;
}

/** Spec 14b.0: the connection parameters every fake connection carries unless a case says otherwise. */
const ACK_PARAMS = "size_ack=1";

/**
 * A fake connection attached to the document, handshaken through the filter.
 * @param doc - The document.
 * @param opts - Connection options.
 * @param opts.socketId - Socket id (default `"s1"`).
 * @param opts.userId - User id (default `"u1"`).
 * @param opts.readOnly - Read-only flag.
 * @param opts.handshake - Whether to handshake the document on the socket first (default true).
 * @param opts.params - The query string the WebSocket was opened with (default `size_ack=1`).
 * @returns The connection.
 */
function conn(
  doc: Document,
  opts: { socketId?: string; userId?: string; readOnly?: boolean; handshake?: boolean; params?: string } = {},
): FakeConnection {
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
  if (opts.handshake !== false) handshake(connection.socketId, doc.name);
  return connection;
}

/**
 * Call the production `beforeSync` with the payload shape of spec 0.4.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type (0 SyncStep1, 1 SyncStep2, 2 Update).
 * @param payload - The update or state vector.
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
 * Apply an update the way Hocuspocus does for a connection.
 * @param doc - The document.
 * @param c - The connection.
 * @param update - The update.
 */
function apply(doc: Document, c: FakeConnection, update: Uint8Array): void {
  Y.applyUpdate(doc, update, { source: "connection", connection: c });
}

/**
 * A fake connection where production expects a Hocuspocus `Connection`.
 * @param c - The fake connection.
 * @returns The same object, typed for the production signature.
 */
function asConnection(c: FakeConnection): never {
  return c as never;
}

/**
 * The v2 size record of a document, failing when there is none or it lacks a v2 field.
 * @param name - Document name.
 * @returns The record.
 * @throws {Error} When the document has no record or the record has no `current` / `heldSum`.
 */
function rec(name: string): SizeRecord {
  const record = w.size.readDocSizeRecord(name) as unknown as Partial<SizeRecord> | undefined;
  if (!record) throw new Error(`no size record for ${name}`);
  if (typeof record.current !== "number" || typeof record.heldSum !== "number") {
    throw new Error(`size record of ${name} has no v2 current / heldSum: ${JSON.stringify(record)}`);
  }
  return record as SizeRecord;
}

/**
 * Set a document's `current` through the record's exact size (held is 0 at setup).
 * @param name - Document name.
 * @param bytes - The value.
 */
function setCur(name: string, bytes: number): void {
  w.size.recordExact(name, bytes);
}

/**
 * The refusal log lines so far.
 * @returns `[fields, message]` pairs.
 */
function refusalLogs(): unknown[][] {
  return logger.warn.mock.calls.filter((call) => call[1] === REFUSED);
}

/**
 * Expect production `beforeSync` to admit the message (spec section 5
 * "accepted"): no throw, `current` and `heldSum` grow by the design 4.1 cost,
 * the activity spy runs once, nothing is refused.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param payload - The update.
 * @returns The cost that was added.
 */
async function accepts(doc: Document, c: FakeConnection, type: number, payload: Uint8Array): Promise<number> {
  const k = cost(payload, doc);
  const before = rec(doc.name);
  activity.spy.mockClear();
  logger.warn.mockClear();
  await expect(beforeSync(doc, c, type, payload)).resolves.toBeUndefined();
  const after = rec(doc.name);
  expect(after.current).toBe(before.current + k);
  expect(after.heldSum).toBe(before.heldSum + k);
  expect(activity.spy).toHaveBeenCalledTimes(1);
  expect(refusalLogs()).toEqual([]);
  expect(w.filter.isRefused(c.socketId, doc.name)).toBe(false);
  return k;
}

/**
 * Expect production `beforeSync` to refuse the message (spec section 5
 * "refused"): the error carries the size reason, the socket and document are
 * marked (the next Update frame is dropped), one refusal log with the
 * design 4.2 fields, no activity, the record unchanged.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param payload - The update.
 * @param step - The expected refusal step.
 * @returns The thrown error.
 */
async function refuses(doc: Document, c: FakeConnection, type: number, payload: Uint8Array, step: Step): Promise<unknown> {
  const before = rec(doc.name);
  activity.spy.mockClear();
  logger.warn.mockClear();
  const err = await beforeSync(doc, c, type, payload).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as { reason?: unknown }).reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  expect(refusalLogs()).toEqual([
    [{ documentName: doc.name, userId: c.context.user.id, current: before.current, limit: L, ceiling: CEIL, step }, REFUSED],
  ]);
  expect(activity.spy).not.toHaveBeenCalled();
  expect(rec(doc.name)).toEqual(before);
  expect(w.filter.isRefused(c.socketId, doc.name)).toBe(true);
  expect(updateFramePasses(c.socketId, doc.name)).toBe(false);
  return err;
}

/**
 * Expect production `beforeSync` not to check the message (design 4.2 step 1):
 * no throw, no refusal log, the record (if any) unchanged.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param payload - The payload.
 */
async function notChecked(doc: Document, c: FakeConnection, type: number, payload: Uint8Array): Promise<void> {
  const before = w.size.readDocSizeRecord(doc.name);
  logger.warn.mockClear();
  await expect(beforeSync(doc, c, type, payload)).resolves.toBeUndefined();
  expect(refusalLogs()).toEqual([]);
  expect(w.size.readDocSizeRecord(doc.name)).toEqual(before);
}

/**
 * Re-authenticate a refused connection's document (clears the refusal mark).
 * @param c - The connection.
 * @param name - Document name.
 */
function reauth(c: FakeConnection, name: string): void {
  handshake(c.socketId, name);
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

/** The fixture documents most cases share. */
interface Combo {
  /** The `nodeDoc()` handles (client 7). */
  nd: NodeDoc;
  /** The `alt2000()` client (client 11) and its text. */
  alt: { client: Y.Doc; t: Y.Text };
  /** The stored content: both fixtures' server copies merged. */
  src: Y.Doc;
}

/**
 * `nodeDoc()` and `alt2000()` in one stored document, so updates captured on
 * either client are judged against the structs they were made on.
 * @returns The handles.
 */
function combo(): Combo {
  const nd = nodeDoc();
  const alt = alt2000();
  const src = new Y.Doc();
  Y.applyUpdate(src, Y.encodeStateAsUpdate(nd.server));
  Y.applyUpdate(src, Y.encodeStateAsUpdate(alt.server));
  return { nd, alt, src };
}

/**
 * An insert-only update from a fresh client synced with the document.
 * @param doc - The document.
 * @param clientID - The new client's id.
 * @param chars - How many characters to insert.
 * @returns The update.
 */
function insertOnly(doc: Y.Doc, clientID: number, chars = 3): Uint8Array {
  const client = syncedClient(doc, clientID);
  return capture(client, () => client.getText(`ins${clientID}`).insert(0, "i".repeat(chars)));
}

/**
 * Spec SH-12 on a fresh client: a new node `n2` with `name: "abc"`.
 * @param doc - The document.
 * @param clientID - The new client's id.
 * @returns The update.
 */
function sh12(doc: Y.Doc, clientID: number): Uint8Array {
  const client = syncedClient(doc, clientID);
  return capture(client, () => {
    const n2 = new Y.Map<unknown>();
    client.getMap<Y.Map<unknown>>("nodes").set("n2", n2);
    n2.set("name", "abc");
  });
}

/**
 * Spec SH-11 on a fresh client: delete `data.color` and rename `n1` in one transaction.
 * @param doc - The document.
 * @param clientID - The new client's id.
 * @returns The update.
 */
function sh11(doc: Y.Doc, clientID: number): Uint8Array {
  const client = syncedClient(doc, clientID);
  return capture(client, () => {
    const n1 = client.getMap<Y.Map<unknown>>("nodes").get("n1") as Y.Map<unknown>;
    (n1.get("data") as Y.Map<unknown>).delete("color");
    n1.set("name", "x3");
  });
}

/**
 * Spec SH-05 / SH-06: delete the characters at the given original indices of
 * the `alt2000` text in one transaction.
 * @param t - The client's text.
 * @param indices - Original indices, any order.
 * @returns The update.
 */
function deleteAt(t: Y.Text, indices: number[]): Uint8Array {
  const doc = t.doc as Y.Doc;
  return capture(doc, () => {
    for (const i of [...indices].sort((a, b) => b - a)) t.delete(i, 1);
  });
}

/**
 * Odd indices 1, 3, ..., 1999 (SH-05, 1999 split endpoints).
 * @returns The indices.
 */
function oddIndices(): number[] {
  return Array.from({ length: 1000 }, (_, k) => 2 * k + 1);
}

/**
 * Even indices 2, 4, ..., 1024 (SH-06, 1024 split endpoints).
 * @returns The indices.
 */
function evenIndices(): number[] {
  return Array.from({ length: 512 }, (_, k) => 2 * k + 2);
}

/**
 * A promise with its resolver.
 * @returns The promise and `resolve`.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Let pending microtasks run.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"],
    now: 0,
  });
  peers.clear();
  activity.hold = undefined;
  activity.onCall = undefined;
  activity.spy.mockReset().mockImplementation(async () => {
    activity.onCall?.();
    await activity.hold;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("beforeSync step 1: not checked", () => {
  it("G-01 checks nothing on a meta document, an unparseable name, or a canvas when max_document_bytes is 0", async () => {
    const { alt } = combo();
    const splits = deleteAt(alt.t, oddIndices());
    const garbage = new Uint8Array([1]);

    await boot();
    for (const name of [ODD, META]) {
      const doc = await load(name);
      const c = conn(doc);
      // Either would be refused (step 2) or fail to decode if it were checked.
      await notChecked(doc, c, SYNC.update, splits);
      await notChecked(doc, c, SYNC.update, garbage);
      expect(w.size.readDocSizeRecord(name)).toBeUndefined();
    }

    await boot({ max_document_bytes: 0 });
    const doc = await load(CV, alt2000().server);
    const c = conn(doc);
    await notChecked(doc, c, SYNC.update, splits);
    await notChecked(doc, c, SYNC.update, garbage);
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("G-02 checks nothing from a read-only connection over the hard ceiling", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const viewer = conn(doc, { readOnly: true });
    const before = rec(CV);
    await notChecked(doc, viewer, SYNC.update, sh12(doc, 51));
    await notChecked(doc, viewer, SYNC.step2, handshakeStep2(doc, nd.client));
    expect(rec(CV)).toEqual(before);
    expect(w.filter.isRefused("s1", CV)).toBe(false);
  });

  it("G-03 checks no SyncStep1 over the hard ceiling", async () => {
    await boot();
    const { src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const c = conn(doc);
    const before = rec(CV);
    await notChecked(doc, c, SYNC.step1, step1Payload(doc));
    expect(rec(CV)).toEqual(before);
    expect(w.filter.isRefused("s1", CV)).toBe(false);
  });
});

describe("beforeSync step 3: below the limit", () => {
  it("G-04 admits a large insert at warning, adds its cost, turns full and pushes it to every connection", async () => {
    await boot();
    const { src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L - 1);
    expect(rec(CV).phase).toBe("warning");
    const a = conn(doc);
    const b = conn(doc, { socketId: "s2", userId: "u2" });
    const big = insertOnly(doc, 41, 50_000);
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();

    const k = await accepts(doc, a, SYNC.update, big);

    // Round 6: an insert costs its message length.
    expect(k).toBe(big.byteLength);
    expect(rec(CV).current).toBe(L - 1 + big.byteLength);
    expect(rec(CV).phase).toBe("full");
    const expected = { type: "doc:size", seq: expect.any(Number), bytes: L - 1 + big.byteLength, limit: L, ceiling: CEIL, phase: "full" };
    expect(pushes(a)).toEqual([expected]);
    expect(pushes(b)).toEqual([expected]);
  });
});

describe("beforeSync step 4: between the limit and the hard ceiling", () => {
  it("G-05 admits pure deletes at the limit, adding 6, 70 and 70 (message length plus 32 per split endpoint)", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc);

    const sh02 = capture(nd.client, () => nd.data.delete("locked"));
    expect(sh02.byteLength).toBe(6);
    expect(await accepts(doc, c, SYNC.update, sh02)).toBe(6);
    apply(doc, c, sh02);

    for (const u of [
      capture(nd.client, () => nd.text.delete(2, 3)), // SH-03
      capture(nd.client, () => nd.focus.delete(1, 1)), // SH-04
    ]) {
      expect(u.byteLength).toBe(6);
      expect(await accepts(doc, c, SYNC.update, u)).toBe(6 + 2 * C);
      apply(doc, c, u);
    }
  });

  it("G-06 refuses a move, a delete carrying structs and an insert at the limit with step full", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc);
    await confirmFull(doc, c);
    const move = capture(nd.client, () => nd.n1.set("position", { x: 1, y: 2 }));
    await refuses(doc, c, SYNC.update, move, "full");
    reauth(c, CV);
    await refuses(doc, c, SYNC.update, sh11(doc, 52), "full");
    reauth(c, CV);
    await refuses(doc, c, SYNC.update, sh12(doc, 53), "full");
    const unaware = conn(doc, { socketId: "s2", userId: "u2" });
    await accepts(doc, unaware, SYNC.update, move);
    await accepts(doc, unaware, SYNC.update, sh11(doc, 56));
    await accepts(doc, unaware, SYNC.update, sh12(doc, 57));
  });

  it("G-07 admits a split delete one byte under the hard ceiling (still step 4)", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL - 1);
    const c = conn(doc);
    await accepts(doc, c, SYNC.update, capture(nd.client, () => nd.text.delete(2, 3)));
  });
});

describe("beforeSync step 5: at or over the hard ceiling", () => {
  it("G-08 admits deleting a whole node, a Map entry and a handshake delete set", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const c = conn(doc);

    const sh02 = capture(nd.client, () => nd.data.delete("locked"));
    await accepts(doc, c, SYNC.update, sh02);
    apply(doc, c, sh02);
    const sh01 = capture(nd.client, () => nd.nodes.delete("n1"));
    await accepts(doc, c, SYNC.update, sh01);
    apply(doc, c, sh01);
    // SH-10: server and client agree; the client's SyncStep2 holds only the delete set.
    await accepts(doc, c, SYNC.step2, handshakeStep2(doc, nd.client));
    expect(rec(CV).current).toBeGreaterThanOrEqual(CEIL);
  });

  it("G-09 refuses six kinds of update at the hard ceiling with step over_ceiling", async () => {
    await boot();
    const { nd, alt, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const c = conn(doc);
    const updates = [
      capture(nd.client, () => nd.text.delete(2, 3)), // SH-03
      capture(nd.client, () => nd.focus.delete(1, 1)), // SH-04
      capture(alt.client, () => alt.t.delete(0, 2000)), // SH-07
      beyondDs(4242, 100, 1), // SH-08
      sh11(doc, 54), // SH-11
      sh12(doc, 55), // insert only
    ];
    for (const u of updates) {
      await refuses(doc, c, SYNC.update, u, "over_ceiling");
      reauth(c, CV);
    }
  });
});

describe("beforeSync step 2: split endpoints", () => {
  it("G-10 checks split endpoints only from the limit on: 1999 are admitted while normal or warning, refused at full", async () => {
    const { alt, src } = combo();
    const splits = deleteAt(alt.t, oddIndices());
    expect(splits.byteLength).toBe(2941);
    for (const at of [1000, L - 1]) {
      await boot();
      const doc = await load(CV, src);
      setCur(CV, at);
      const c = conn(doc);
      expect(await accepts(doc, c, SYNC.update, splits), `current ${at}`).toBe(2941 + 1999 * C);
      expect(rec(CV).current).toBe(at + 66_909);
    }
    await boot();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, splits, "splits");
    const unaware = conn(doc, { socketId: "s2", userId: "u2" });
    expect(await accepts(doc, unaware, SYNC.update, splits)).toBe(2941 + 1999 * C);
  });

  it("G-11 at the limit admits 1024 split endpoints and refuses 1025; one byte under the limit admits 1025", async () => {
    const { alt, src } = combo();
    const at1024 = deleteAt(alt.t, evenIndices());
    // A second alt2000 client with the same structs, so both updates are judged on the same store.
    const at1025 = deleteAt(alt2000().t, [0, ...evenIndices()]);

    await boot();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc);
    await confirmFull(doc, c);
    expect(updateShape(at1024, doc.store).splitEndpoints).toBe(1024);
    expect(updateShape(at1025, doc.store).splitEndpoints).toBe(1025);
    await accepts(doc, c, SYNC.update, at1024);
    await refuses(doc, c, SYNC.update, at1025, "splits");

    await boot();
    const under = await load(CV, src);
    setCur(CV, L - 1);
    await accepts(under, conn(under), SYNC.update, at1025);
  });

  it("G-12 refuses too many split endpoints with step splits before steps 4 and 5", async () => {
    await boot();
    const { alt, src } = combo();
    const doc = await load(CV, src);
    const c = conn(doc);
    const unaware = conn(doc, { socketId: "s2", userId: "u2" });
    const splits = deleteAt(alt.t, oddIndices());
    setCur(CV, L);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, splits, "splits");
    reauth(c, CV);
    setCur(CV, CEIL);
    await refuses(doc, c, SYNC.update, splits, "splits");
    setCur(CV, L);
    await accepts(doc, unaware, SYNC.update, splits);
    setCur(CV, CEIL);
    await refuses(doc, unaware, SYNC.update, splits, "splits");
  });
});

describe("beforeSync: handshakes and concurrent writers", () => {
  it("G-13 admits a handshake SyncStep2 holding only a delete set at the limit and at the hard ceiling, adding nothing", async () => {
    await boot();
    const nd = nodeDoc();
    Y.applyUpdate(nd.server, capture(nd.client, () => nd.nodes.delete("n1")));
    const doc = await load(CV, nd.server);
    const c = conn(doc);
    const step2 = handshakeStep2(doc, nd.client);
    expect(step2.byteLength).toBe(6);
    for (const at of [L, CEIL]) {
      setCur(CV, at);
      const before = rec(CV).current;
      expect(await accepts(doc, c, SYNC.step2, step2)).toBe(0);
      expect(rec(CV).current).toBe(before);
    }
  });

  it("G-14 B-02 judges a second connection on the sum after the first, while the first's activity write hangs", async () => {
    for (const knowing of [true, false]) {
      await boot();
      const { src } = combo();
      const doc = await load(CV, src);
      setCur(CV, 10_485_000);
      const a = conn(doc);
      const b = conn(doc, { socketId: "s2", userId: "u2" });
      const uA = insertOnly(doc, 61, 2000);
      const uB = insertOnly(doc, 62, 10);
      const kA = cost(uA, doc);
      expect(kA).toBeGreaterThan(760);
      const hold = deferred();
      activity.hold = hold.promise;

      const pA = beforeSync(doc, a, SYNC.update, uA);
      await flush();
      expect(activity.spy).toHaveBeenCalledTimes(1);
      expect(rec(CV).current).toBe(10_485_000 + kA);
      expect(rec(CV).current).toBeGreaterThanOrEqual(L);
      // B-02: past the limit by at most one message.
      expect(rec(CV).current - L).toBeLessThanOrEqual(uA.byteLength);

      if (knowing) {
        await ack(doc, b, lastSeq(b));
        await refuses(doc, b, SYNC.update, uB, "full");
      } else {
        activity.hold = undefined;
        await accepts(doc, b, SYNC.update, uB);
      }
      expect(w.filter.isRefused("s1", CV)).toBe(false);

      hold.resolve();
      await expect(pA).resolves.toBeUndefined();
    }
  });

  it("G-15 runs the size judgement before the activity write: none on a refusal, once after an admit", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, capture(nd.client, () => nd.n1.set("position", { x: 1, y: 2 })), "full");
    reauth(c, CV);

    const sh03 = capture(nd.client, () => nd.text.delete(2, 3));
    const k = cost(sh03, doc);
    const heldBefore = rec(CV).heldSum;
    let heldAtActivity: number | undefined;
    activity.onCall = () => {
      heldAtActivity = rec(CV).heldSum;
    };
    await accepts(doc, c, SYNC.update, sh03);
    expect(heldAtActivity).toBe(heldBefore + k);
  });

  it("G-16 LG-04 Q8 treats an unexpected exception in the size judgement as a refusal with step error", async () => {
    await boot();
    const { src } = combo();
    const doc = await load(CV, src);
    setCur(CV, 1000);
    const c = conn(doc);
    await refuses(doc, c, SYNC.update, new Uint8Array([1]), "error");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), ctx: { documentName: CV, userId: "u1" } },
      "document_size_gate_failed",
    );
    expect(rec(CV).current).toBe(1000);
  });
});

describe("beforeSync step 0: after a refusal", () => {
  it("G-17 refuses SyncStep1, SyncStep2 and Update on a refused socket and document with step after_refusal", async () => {
    await boot();
    const nd = nodeDoc();
    Y.applyUpdate(nd.server, capture(nd.client, () => nd.nodes.delete("n1")));
    const doc = await load(CV, nd.server);
    setCur(CV, 1000);
    const c = conn(doc);
    w.filter.markRefused("s1", CV);
    const before = rec(CV);
    await refuses(doc, c, SYNC.step1, step1Payload(doc), "after_refusal");
    await refuses(doc, c, SYNC.step2, handshakeStep2(doc, nd.client), "after_refusal");
    await refuses(doc, c, SYNC.update, sh12(doc, 71), "after_refusal");
    expect(rec(CV)).toEqual(before);
  });

  it("G-18 step 0 reads only the (socket, document) pair", async () => {
    await boot();
    const cvDoc = await load(CV, combo().src);
    const docDoc = await load(DOC);
    setCur(CV, 1000);
    setCur(DOC, 1000);
    const sameSocketOtherDoc = conn(docDoc);
    const otherSocketSameDoc = conn(cvDoc, { socketId: "s2", userId: "u2" });
    w.filter.markRefused("s1", CV);
    await accepts(docDoc, sameSocketOtherDoc, SYNC.update, insertOnly(docDoc, 72));
    await accepts(cvDoc, otherSocketSameDoc, SYNC.update, insertOnly(cvDoc, 73));
  });

  it("G-19 does not refuse at step 0 once an Auth frame cleared the mark", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, 1000);
    const c = conn(doc);
    w.filter.markRefused("s1", CV);
    expect(frame("s1", authFrame(CV, "token"))).toBeDefined();
    await accepts(doc, c, SYNC.update, insertOnly(doc, 74));
  });
});

describe("beforeSync: admit and the record", () => {
  it("G-20 records the admitted cost on the connection, so release returns heldSum to its value before", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, 1000);
    const c = conn(doc);
    const heldBefore = rec(CV).heldSum;
    const k = await accepts(doc, c, SYNC.update, capture(nd.client, () => nd.text.delete(2, 3)));
    // Round 6: SH-03 costs its 6 bytes plus 32 per split endpoint.
    expect(k).toBe(6 + 2 * C);
    w.size.release(CV, asConnection(c));
    expect(rec(CV).heldSum).toBe(heldBefore);
  });

  it("G-21 has no malformed step: one client in two struct groups is judged by steps 2-3, and the pending it leaves is refused at 2a", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, 1000);
    const c = conn(doc);
    // Client 31: "abc" (clocks 0-2) and "def" (clocks 3-5) written as two
    // groups of the same client. yjs keeps the second group only, which then
    // waits for clocks 0-2 (measured: 23 bytes of pending structs).
    const writer = new Y.Doc();
    writer.clientID = 31;
    const t = writer.getText("t31");
    t.insert(0, "abc");
    const head = Y.encodeStateAsUpdate(writer);
    const sv = Y.encodeStateVector(writer);
    t.insert(3, "def");
    const tail = Y.encodeStateAsUpdate(writer, sv);
    const twoGroups = new Uint8Array([2, ...head.slice(1, -1), ...tail.slice(1, -1), 0]);
    expect(Y.decodeUpdate(twoGroups).structs.length).toBe(2);

    const k = await accepts(doc, c, SYNC.update, twoGroups);
    const current = rec(CV).current;
    logger.warn.mockClear();
    apply(doc, c, twoGroups);

    // Round 6 adds pendingBefore / pendingAfter to a step 2a log line (LG-02).
    expect(refusalLogs()).toEqual([
      [expect.objectContaining({ documentName: CV, userId: "u1", current, limit: L, ceiling: CEIL, step: "pending" }), REFUSED],
    ]);
    expect(c.close).toHaveBeenCalledWith(expect.objectContaining({ reason: COLLAB_DOCUMENT_TOO_LARGE_REASON }));
    expect(doc.store.pendingStructs).toBeNull();
    expect(rec(CV).current).toBe(1000 + k);
  });
});

describe("design 4.2 bounds", () => {
  it("B-01 a write below the limit adds exactly its message length plus 32 per split endpoint", async () => {
    await boot();
    const { alt, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L - 1);
    const c = conn(doc);
    const t = alt.t;
    const u = capture(alt.client, () => {
      for (const i of evenIndices().sort((a, b) => b - a)) t.delete(i, 1);
      t.insert(t.length, "y".repeat(300_000));
    });
    const s = updateShape(u, doc.store);
    expect(s.splitEndpoints).toBe(1024);
    expect(s.beyondClockRanges).toBe(0);
    const k = await accepts(doc, c, SYNC.update, u);
    expect(k).toBe(u.byteLength + C * 1024);
  });

  it("B-03 R6-06 between the limit and the hard ceiling each one-character delete adds 70; the one crossing the ceiling pushes at once, the next is over_ceiling", async () => {
    await boot();
    const { alt, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL - 1000);
    const a = conn(doc);
    const b = conn(doc, { socketId: "s2", userId: "u2" });
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    // The i-th delete removes original index 1 + 2i: one character, two split endpoints, 6 bytes.
    const deletes = Array.from({ length: 16 }, (_, i) => capture(alt.client, () => alt.t.delete(1 + i, 1)));
    for (const [i, u] of deletes.slice(0, 14).entries()) {
      expect(u.byteLength, `delete ${i + 1}`).toBe(6);
      expect(await accepts(doc, a, SYNC.update, u)).toBe(6 + 2 * C);
    }
    expect(rec(CV).current).toBe(CEIL - 1000 + 14 * 70);
    expect(pushes(a)).toEqual([]);
    expect(pushes(b)).toEqual([]);

    expect(rec(CV).current).toBe(10_747_884);
    await accepts(doc, a, SYNC.update, deletes[14] as Uint8Array);
    expect(rec(CV).current).toBe(10_747_954);
    const crossed = { type: "doc:size", seq: expect.any(Number), bytes: 10_747_954, limit: L, ceiling: CEIL, phase: "full" };
    expect(pushes(a)).toEqual([crossed]);
    expect(pushes(b)).toEqual([crossed]);

    await refuses(doc, a, SYNC.update, deletes[15] as Uint8Array, "over_ceiling");
  });

  it("B-04 over the hard ceiling the same whole-node delete is admitted 1000 times and the size stops changing after the first", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const c = conn(doc);
    const sh01 = capture(nd.client, () => nd.nodes.delete("n1"));
    let afterSecond = 0;
    for (let i = 1; i <= 1000; i++) {
      await accepts(doc, c, SYNC.update, sh01);
      apply(doc, c, sh01);
      if (i === 2) afterSecond = enc(doc);
    }
    expect(enc(doc)).toBe(afterSecond);
    expect(rec(CV).current).toBeGreaterThanOrEqual(CEIL);
  });
});

describe("refusal log fields", () => {
  it("LG-01 LG-03 logs one line per refusal with exactly the design 4.2 fields (plus the pending coverage at 2a) and each step's value", async () => {
    await boot();
    const { nd, alt, src } = combo();
    const doc = await load(CV, src);
    const c = conn(doc);
    const fields = ["ceiling", "current", "documentName", "limit", "step", "userId"];
    const lastLog = (): Record<string, unknown> => {
      const logs = refusalLogs();
      expect(logs).toHaveLength(1);
      return logs[0]?.[0] as Record<string, unknown>;
    };

    setCur(CV, 1000);
    w.filter.markRefused("s1", CV);
    await refuses(doc, c, SYNC.update, sh12(doc, 81), "after_refusal");
    expect(Object.keys(lastLog()).sort()).toEqual(fields);
    reauth(c, CV);

    // Round 6: split endpoints are checked from the limit on (G-10 at the limit).
    setCur(CV, L);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, deleteAt(alt.t, oddIndices()), "splits");
    expect(Object.keys(lastLog()).sort()).toEqual(fields);
    reauth(c, CV);

    setCur(CV, 1000);
    const pend = pendingStructs(777, 2000);
    await accepts(doc, c, SYNC.update, pend);
    logger.warn.mockClear();
    apply(doc, c, pend);
    expect(lastLog()).toMatchObject({ step: "pending" });
    expect(Object.keys(lastLog()).sort()).toEqual([...fields, "pendingAfter", "pendingBefore"].sort());
    reauth(c, CV);

    setCur(CV, 1000);
    await refuses(doc, c, SYNC.update, new Uint8Array([1]), "error");
    expect(Object.keys(lastLog()).sort()).toEqual(fields);
    reauth(c, CV);

    setCur(CV, L);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, capture(nd.client, () => nd.n1.set("position", { x: 1, y: 2 })), "full");
    expect(Object.keys(lastLog()).sort()).toEqual(fields);
    reauth(c, CV);

    setCur(CV, CEIL);
    await refuses(doc, c, SYNC.update, capture(nd.client, () => nd.text.delete(2, 3)), "over_ceiling");
    expect(Object.keys(lastLog()).sort()).toEqual(fields);
  });

  it("LG-02 logs a step 2a refusal with the fields of design 4.2 and the user of the transaction's connection", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, 1000);
    const c = conn(doc, { userId: "u7" });
    const pend = pendingStructs(777, 2000);
    const k = await accepts(doc, c, SYNC.update, pend);
    logger.warn.mockClear();
    apply(doc, c, pend);
    expect(refusalLogs()).toHaveLength(1);
    const [fields, message] = refusalLogs()[0] as [Record<string, unknown>, string];
    expect(message).toBe(REFUSED);
    expect(Object.keys(fields).sort()).toEqual(["ceiling", "current", "documentName", "limit", "pendingAfter", "pendingBefore", "step", "userId"]);
    expect(fields).toMatchObject({ documentName: CV, userId: "u7", current: 1000 + k, limit: L, ceiling: CEIL, step: "pending" });
    // P-01: structs coverage 0 -> 2000, pending delete set 0 -> 0 (answer Q22: the two apart, key names the implementation's).
    expect(coverage(fields.pendingBefore)).toEqual({ structs: 0, ds: 0 });
    expect(coverage(fields.pendingAfter)).toEqual({ structs: 2000, ds: 0 });
  });
});

describe("the inbound filter after a beforeSync refusal", () => {
  it("F-10 (gate side) drops the socket's next Update and SyncStep2 frames of the document once beforeSync refused", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, L);
    const c = conn(doc, { handshake: false });
    await confirmFull(doc, c);
    const move = capture(nd.client, () => nd.n1.set("position", { x: 1, y: 2 }));
    expect(frame("s1", authFrame(CV, "token"))).toBeDefined();
    expect(frame("s1", syncFrame(CV, WIRE.sync, SYNC.step2, new Uint8Array([0, 0])))).toBeDefined();
    expect(frame("s1", syncFrame(CV, WIRE.sync, SYNC.update, move))).toBeDefined();

    const err = await beforeSync(doc, c, SYNC.update, move).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { reason?: unknown } | undefined)?.reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);

    expect(frame("s1", syncFrame(CV, WIRE.sync, SYNC.update, move))).toBeUndefined();
    expect(frame("s1", syncFrame(CV, WIRE.sync, SYNC.step2, new Uint8Array([0, 0])))).toBeUndefined();
  });
});

describe("a size record that failed to be created", () => {
  it("Q17 logs an error, leaves the document without a record and checks none of its writes", async () => {
    await boot();
    const { alt, src } = combo();
    const doc = await load(CV, src, { failMeasure: true });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({ err: expect.any(Error) });
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
    const c = conn(doc);
    activity.spy.mockClear();
    // Refused at step 2 if it were checked.
    await notChecked(doc, c, SYNC.update, deleteAt(alt.t, oddIndices()));
    expect(activity.spy).toHaveBeenCalledTimes(1);
    expect(w.size.readDocSizeRecord(CV)).toBeUndefined();
  });
});

describe("first-version steps are gone", () => {
  it("G-22 logs no malformed, budget or trial step and never asks checkRateLimit", async () => {
    // Refusal-prone inputs of its own, so the case holds when run alone.
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    const c = conn(doc);
    setCur(CV, L);
    await confirmFull(doc, c);
    await refuses(doc, c, SYNC.update, sh12(doc, 91), "full");
    reauth(c, CV);
    await refuses(doc, c, SYNC.update, capture(nd.client, () => nd.n1.set("position", { x: 1, y: 2 })), "full");

    for (const old of ["malformed", "budget_user", "budget_process", "trial"]) {
      expect(refusalSteps).not.toContain(old);
    }
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

/**
 * Expect production `beforeSync` to refuse a message of a connection no longer
 * in the document (spec 14a.6): the error carries the size reason and one
 * refusal log is written, but the inbound filter gets no mark, so the
 * socket's next Update frame of the document passes.
 * @param doc - The document.
 * @param c - The connection, already removed from the document.
 * @param payload - The update.
 * @param step - The expected refusal step.
 */
async function refusesUnmarked(doc: Document, c: FakeConnection, payload: Uint8Array, step: Step): Promise<void> {
  expect(doc.hasConnection(asConnection(c))).toBe(false);
  const before = rec(doc.name);
  logger.warn.mockClear();
  const err = await beforeSync(doc, c, SYNC.update, payload).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as { reason?: unknown }).reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  expect(refusalLogs()).toEqual([
    [{ documentName: doc.name, userId: c.context.user.id, current: before.current, limit: L, ceiling: CEIL, step }, REFUSED],
  ]);
  expect(rec(doc.name)).toEqual(before);
  expect(w.filter.isRefused(c.socketId, doc.name)).toBe(false);
}

/**
 * Spec R6-01: client 9 inserts 50 000 `"a"` one at a time at index 0 of
 * `getText("t")`, so no two items merge.
 * @returns The client and its text.
 */
function unmergedText(): { client: Y.Doc; t: Y.Text } {
  const client = new Y.Doc();
  client.clientID = 9;
  const t = client.getText("t");
  for (let i = 0; i < 50_000; i++) t.insert(0, "a");
  return { client, t };
}

describe("round 6: cost is the message length plus 32 per event (spec 14a.1)", () => {
  it("R6-01 a pure delete costs its message length; deleting every other of 50 000 items grows the document less than that, and the next measure corrects it", async () => {
    const { client, t } = unmergedText();
    const src = syncedClient(client, 90);
    expect(enc(src)).toBe(333_494);
    const cut = capture(client, () => {
      for (let i = 0; i < 25_000; i++) t.delete(i, 1);
    });
    expect(cut.byteLength).toBe(91_750);

    await boot();
    const doc = await load(CV, src);
    expect(rec(CV).current).toBe(333_494);
    const a = conn(doc);
    expect(updateShape(cut, doc.store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0 });
    expect(await accepts(doc, a, SYNC.update, cut)).toBe(91_750);
    expect(rec(CV).current).toBe(333_494 + 91_750);
    apply(doc, a, cut);
    expect(enc(doc) - 333_494).toBe(66_748);
    vi.advanceTimersByTime(2000);
    expect(rec(CV)).toMatchObject({ exact: 400_242, current: 400_242, heldSum: 0 });

    await boot();
    const full = await load(CV, src);
    setCur(CV, 10_700_000);
    const fa = conn(full);
    const fb = conn(full, { socketId: "s2", userId: "u2" });
    fa.sendStateless.mockClear();
    fb.sendStateless.mockClear();
    expect(await accepts(full, fa, SYNC.update, cut)).toBe(91_750);
    expect(rec(CV).current).toBe(10_791_750);
    const crossed = { type: "doc:size", seq: expect.any(Number), bytes: 10_791_750, limit: L, ceiling: CEIL, phase: "full" };
    expect(pushes(fa)).toEqual([crossed]);
    expect(pushes(fb)).toEqual([crossed]);
  }, 60_000);

  it("R6-02 through beforeSync an insert costs its length and deletes add 32 per split endpoint or beyond-clock range", async () => {
    await boot();
    const { nd, alt, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, 1000);
    const c = conn(doc);
    const sh12u = capture(nd.client, () => {
      const n2 = new Y.Map<unknown>();
      nd.nodes.set("n2", n2);
      n2.set("name", "abc");
    });
    const sh03 = capture(nd.client, () => nd.text.delete(2, 3));
    const sh08 = beyondDs(4242, 100, 1);
    const sh05 = deleteAt(alt.t, oddIndices());
    expect([sh12u.byteLength, sh03.byteLength, sh08.byteLength, sh05.byteLength]).toEqual([32, 6, 7, 2941]);
    const added: number[] = [];
    for (const u of [sh12u, sh03, sh08, sh05]) {
      const before = rec(CV).current;
      await expect(beforeSync(doc, c, SYNC.update, u)).resolves.toBeUndefined();
      added.push(rec(CV).current - before);
    }
    expect(added).toEqual([32, 70, 39, 66_909]);
  });
});

describe("round 6: split endpoints are checked only from the limit on (spec 14a.4)", () => {
  it("R6-11 a reconnecting member's 600 offline deletes (1200 split endpoints) are admitted below the limit and refused from it", async () => {
    const od = offlineDeletes();
    const member = od.memberAfter(600);
    for (const [at, admitted, knowing] of [[undefined, true, false], [L - 1, true, false], [L, false, true], [L, true, false], [CEIL, false, false]] as const) {
      await boot();
      const doc = await load(DOC, od.author);
      expect(enc(doc)).toBe(40_607);
      if (at !== undefined) setCur(DOC, at);
      const c = conn(doc);
      if (knowing) await confirmFull(doc, c);
      const step2 = reconnectStep2(member, doc);
      expect(step2.byteLength).toBe(2157);
      expect(updateShape(step2, doc.store)).toMatchObject({ pureDelete: true, splitEndpoints: 1200 });
      if (admitted) {
        expect(await accepts(doc, c, SYNC.step2, step2), `current ${at ?? "as loaded"}`).toBe(2157 + 1200 * C);
        expect(2157 + 1200 * C).toBe(40_557);
      } else {
        await refuses(doc, c, SYNC.step2, step2, "splits");
      }
    }
  });

  it("R6-12 at the limit 400 offline deletes (800 split endpoints) are admitted as a pure delete", async () => {
    const od = offlineDeletes();
    await boot();
    const doc = await load(DOC, od.author);
    setCur(DOC, L);
    const c = conn(doc);
    const step2 = reconnectStep2(od.memberAfter(400), doc);
    expect(step2.byteLength).toBe(1437);
    expect(updateShape(step2, doc.store).splitEndpoints).toBe(800);
    expect(await accepts(doc, c, SYNC.step2, step2)).toBe(27_037);
  });
});

describe("round 6: no refusal mark for a connection no longer in the document (spec 14a.6)", () => {
  it("R6-19 refuses a closed, removed connection's insert at full without marking the socket", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, L);
    const a = conn(doc);
    await confirmFull(doc, a);
    doc.removeConnection(asConnection(a));
    await refusesUnmarked(doc, a, sh12(doc, 92), "full");
    expect(updateFramePasses("s1", CV)).toBe(true);
  });

  it("R6-21 refuses a queued Update after its socket closed without creating a filter record for the socket", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, L);
    const a = conn(doc);
    await confirmFull(doc, a);
    w.hooks.onPeerClose(peerOf("s1"), {});
    // Hocuspocus's handleClose runs after onPeerClose and removes the connection.
    doc.removeConnection(asConnection(a));
    await refusesUnmarked(doc, a, sh12(doc, 93), "full");
  });
});

/** The round 7 record functions of design 4.1. */
interface AckApi {
  acknowledge: (name: string, connection: unknown, seq: number) => void;
  knowsFull: (name: string, connection: unknown) => boolean;
}

/**
 * The production `knowsFull`, failing clearly while it does not exist.
 * @param name - Document name.
 * @param c - The connection.
 * @returns Whether the connection acknowledged a full push last.
 */
function knows(name: string, c: FakeConnection): boolean {
  const mod = w.size as unknown as Record<string, unknown>;
  expect(typeof mod.knowsFull, "services/document-size exports knowsFull").toBe("function");
  return (mod.knowsFull as AckApi["knowsFull"])(name, c);
}

/**
 * Spec 14b.0 `ack(conn, seq)`: a `doc:size-seen` sent through the production `onStateless`.
 * @param doc - The document.
 * @param c - The connection.
 * @param seq - The acknowledged push.
 * @returns The hook's promise.
 */
function ack(doc: Document, c: FakeConnection, seq: unknown): Promise<void> {
  return w.hooks.onStateless({ connection: c, documentName: doc.name, document: doc, payload: JSON.stringify({ type: "doc:size-seen", seq }) });
}

/**
 * Spec 14b.0 `lastSeq(conn)`: the `seq` of the last `doc:size` the connection received.
 * @param c - The connection.
 * @returns The seq, as received.
 * @throws {Error} When it received none.
 */
function lastSeq(c: FakeConnection): unknown {
  const last = pushes(c).at(-1);
  if (!last) throw new Error(`${c.socketId} received no doc:size`);
  return last.seq;
}

/**
 * Spec 14b.0 "confirm full": push the record's current size to every
 * connection (a measure at the same size; nothing may be held) and let `c`
 * acknowledge that full push.
 * @param doc - The document.
 * @param c - The connection.
 * @returns Nothing.
 * @throws {Error} When costs are held, or the push is not full.
 */
async function confirmFull(doc: Document, c: FakeConnection): Promise<void> {
  const r = rec(doc.name);
  if (r.heldSum !== 0) throw new Error("confirmFull needs nothing held");
  w.size.recordExact(doc.name, r.current);
  const last = pushes(c).at(-1);
  if (last?.phase !== "full") throw new Error(`last push to ${c.socketId} is not full: ${JSON.stringify(last)}`);
  await ack(doc, c, last.seq);
}

/**
 * A connection arriving the way Hocuspocus brings it in: the production
 * `onConnect` and `connected` with its connection parameters (spec 14b.0).
 * @param doc - The document.
 * @param c - The connection, already in the document.
 * @returns Nothing.
 */
async function arrive(doc: Document, c: FakeConnection): Promise<void> {
  const payload = {
    documentName: doc.name,
    socketId: c.socketId,
    context: c.context,
    instance: { documents: new Map([[doc.name, doc]]) },
    connectionConfig: { readOnly: c.readOnly },
    request: c.request,
    requestHeaders: new Headers(),
    requestParameters: new URL(c.request.url).searchParams,
  };
  await w.hooks.onConnect(payload);
  await w.hooks.connected({ ...payload, connection: c });
}

/**
 * A connection that arrived through `onConnect` / `connected` with its parameters.
 * @param doc - The document.
 * @param opts - As for `conn`.
 * @returns The connection.
 */
async function arrived(doc: Document, opts: Parameters<typeof conn>[1] = {}): Promise<FakeConnection> {
  const c = conn(doc, opts);
  await arrive(doc, c);
  return c;
}

/** Spec 14b.1 `DEEP(d, n)` on a stored copy. */
interface Deep {
  src: Y.Doc;
  /** The "full cover delete": every value of the deepest array, none of the nested types. */
  cover: Uint8Array;
}

/**
 * Spec 14b.1 `DEEP(d, n)`: client 7 nests `d` maps under `nodes.n0`, puts
 * a `Y.Array` `items` in the deepest and inserts `n` `"x"` one by one at
 * index 0; with it the hand-written delete of all `n` values.
 * @param d - Nesting depth.
 * @param n - How many values.
 * @returns The stored document and the delete.
 */
function deep(d: number, n: number): Deep {
  const src = new Y.Doc();
  src.clientID = 7;
  let first = 0;
  src.transact(() => {
    let level = new Y.Map<unknown>();
    src.getMap<Y.Map<unknown>>("nodes").set("n0", level);
    for (let i = 1; i < d; i++) {
      const next = new Y.Map<unknown>();
      level.set("c", next);
      level = next;
    }
    const items = new Y.Array<string>();
    level.set("items", items);
    first = Y.getState(src.store, 7);
    for (let i = 0; i < n; i++) items.insert(0, ["x"]);
  });
  return { src, cover: beyondDs(7, first, Y.getState(src.store, 7) - first) };
}

/**
 * Spec R7-10: a canvas where 500 nodes were made and deleted, each between
 * two live characters so the delete set keeps 500 ranges; and a member who
 * holds the same state.
 * @returns The stored document and the member's copy.
 */
function deletedNodes(): { src: Y.Doc; member: Y.Doc } {
  const src = new Y.Doc();
  src.clientID = 21;
  const nodes = src.getMap<Y.Map<unknown>>("nodes");
  const keep = src.getText("keep");
  for (let i = 0; i < 500; i++) {
    nodes.set(`d${i}`, new Y.Map<unknown>());
    keep.insert(keep.length, "k");
  }
  for (let i = 0; i < 500; i++) nodes.delete(`d${i}`);
  return { src, member: syncedClient(src, 22) };
}

describe("round 7: deep nesting through beforeSync (spec 14b.1)", () => {
  it("R7-06 an 11-byte unknown sub-type delete of 200 000 values 3000 levels deep is judged in under 500 ms and admitted", async () => {
    const { src, cover } = deep(3000, 200_000);
    expect(cover.byteLength).toBeLessThanOrEqual(12);
    await boot({ ...S_CONFIG, max_document_bytes: 100_000_000 });
    const doc = await load(CV, src);
    const c = conn(doc);
    expect(rec(CV).phase).toBe("normal");
    logger.warn.mockClear();
    // The fastest of five runs: a collection pause or a busy machine only adds time.
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await expect(beforeSync(doc, c, 3, cover)).resolves.toBeUndefined();
      runs.push(performance.now() - t0);
    }
    expect(Math.min(...runs)).toBeLessThan(500);
    expect(refusalLogs()).toEqual([]);
  }, 120_000);
});

describe("round 7: deletes covering only deleted content cost nothing (spec 14b.2)", () => {
  it("R7-10 a member's handshake delete set on a warning document changes neither current nor phase and pushes nothing; the next insert is admitted", async () => {
    await boot();
    const { src, member } = deletedNodes();
    const doc = await load(CV, src);
    setCur(CV, L - 100);
    const a = await arrived(doc);
    const b = await arrived(doc, { socketId: "s2", userId: "u2" });
    const step2 = handshakeStep2(doc, member);
    expect(step2.byteLength).toBeGreaterThan(100);
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    await expect(beforeSync(doc, b, SYNC.step2, step2)).resolves.toBeUndefined();
    expect(rec(CV)).toMatchObject({ current: L - 100, phase: "warning" });
    expect(pushes(a)).toEqual([]);
    expect(pushes(b)).toEqual([]);
    await accepts(doc, a, SYNC.update, sh12(doc, 101));
  });

  it("R7-12 the same handshake delete set over the hard ceiling is admitted at step 5 and adds nothing", async () => {
    await boot();
    const { src, member } = deletedNodes();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const b = await arrived(doc, { socketId: "s2", userId: "u2" });
    const step2 = handshakeStep2(doc, member);
    await expect(beforeSync(doc, b, SYNC.step2, step2)).resolves.toBeUndefined();
    expect(rec(CV).current).toBe(CEIL);
    expect(refusalLogs()).toEqual([]);
  });
});

describe("round 7: judged by the phase the connection acknowledged (spec 14b.4)", () => {
  /**
   * Spec R7-21 / R7-22 set-up: `cur = L - 1`, A and B arrived; A's 50 000
   * character insert crosses the limit and pushes full to both.
   * @returns The document, A, B and the full push's seq.
   */
  async function crossed(): Promise<{ doc: Document; a: FakeConnection; b: FakeConnection; n: unknown }> {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, L - 1);
    const a = await arrived(doc);
    const b = await arrived(doc, { socketId: "s2", userId: "u2" });
    await accepts(doc, a, SYNC.update, insertOnly(doc, 111, 50_000));
    expect(pushes(a).at(-1)?.phase).toBe("full");
    expect(pushes(b).at(-1)?.phase).toBe("full");
    const n = lastSeq(a);
    expect(lastSeq(b)).toBe(n);
    return { doc, a, b, n };
  }

  it("R7-21 after crossing the limit the same connection's next insert is admitted until it acknowledges full, then refused", async () => {
    const { doc, a, n } = await crossed();
    await accepts(doc, a, SYNC.update, insertOnly(doc, 112));
    await ack(doc, a, n);
    expect(knows(CV, a)).toBe(true);
    await refuses(doc, a, SYNC.update, insertOnly(doc, 113), "full");
    expect(w.filter.isRefused("s1", CV)).toBe(true);
  });

  it("R7-22 a peer that has not acknowledged full is admitted; once it acknowledges, refused", async () => {
    const { doc, a, b, n } = await crossed();
    await ack(doc, a, n);
    await accepts(doc, b, SYNC.update, insertOnly(doc, 114));
    await ack(doc, b, n);
    expect(knows(CV, b)).toBe(true);
    await refuses(doc, b, SYNC.update, insertOnly(doc, 115), "full");
  });

  it("R7-23 over the hard ceiling acknowledgement makes no difference: inserts and splitting deletes refused, a whole-node delete admitted", async () => {
    await boot();
    const { nd, src } = combo();
    const doc = await load(CV, src);
    setCur(CV, CEIL);
    const a = await arrived(doc);
    const sh03 = capture(nd.client, () => nd.text.delete(2, 3));
    const sh01 = capture(nd.client, () => nd.nodes.delete("n1"));
    for (const round of ["unacknowledged", "acknowledged"]) {
      if (round === "acknowledged") {
        await ack(doc, a, lastSeq(a));
        expect(knows(CV, a)).toBe(true);
      }
      await refuses(doc, a, SYNC.update, sh12(doc, 121), "over_ceiling");
      reauth(a, CV);
      await refuses(doc, a, SYNC.update, sh03, "over_ceiling");
      reauth(a, CV);
      await accepts(doc, a, SYNC.update, sh01);
    }
  });

  it("R7-24 a connection that never acknowledges is admitted while current is under the hard ceiling, and refused once past it", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, CEIL - 100);
    const a = await arrived(doc);
    a.sendStateless.mockClear();
    const big = insertOnly(doc, 131, 5000);
    expect(big.byteLength).toBeGreaterThan(100);
    await accepts(doc, a, SYNC.update, big);
    expect(rec(CV).current).toBeGreaterThanOrEqual(CEIL);
    expect(pushes(a)).toEqual([expect.objectContaining({ bytes: rec(CV).current, phase: "full" })]);
    await refuses(doc, a, SYNC.update, insertOnly(doc, 132), "over_ceiling");
  });

  it("R7-25 split endpoints are checked at the limit only for a connection that acknowledged full, and over the hard ceiling for every connection", async () => {
    const { alt, src } = combo();
    const splits = deleteAt(alt.t, oddIndices());
    await boot();
    const doc = await load(CV, src);
    setCur(CV, L);
    const a = await arrived(doc);
    expect(await accepts(doc, a, SYNC.update, splits)).toBe(66_909);
    expect(rec(CV).current).toBe(L + 66_909);
    await ack(doc, a, lastSeq(a));
    expect(knows(CV, a)).toBe(true);
    await refuses(doc, a, SYNC.update, splits, "splits");

    for (const knowing of [false, true]) {
      await boot();
      const over = await load(CV, src);
      setCur(CV, CEIL);
      const c = await arrived(over);
      if (knowing) await ack(over, c, lastSeq(c));
      await refuses(over, c, SYNC.update, splits, "splits");
    }
  });

  it("R7-26 below the limit an insert is admitted whatever the connection last acknowledged, and knowsFull stays until it acknowledges the warning", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, L);
    const a = await arrived(doc);
    await ack(doc, a, lastSeq(a));
    expect(knows(CV, a)).toBe(true);
    setCur(CV, L - 1000);
    expect(pushes(a).at(-1)?.phase).toBe("warning");
    const m = lastSeq(a);
    await accepts(doc, a, SYNC.update, sh12(doc, 141));
    expect(knows(CV, a)).toBe(true);
    await ack(doc, a, m);
    expect(knows(CV, a)).toBe(false);
  });

  it("R7-27 after acknowledging the warning, a new full push binds the connection only once it acknowledges that one", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, L);
    const a = await arrived(doc);
    const b = await arrived(doc, { socketId: "s2", userId: "u2" });
    await ack(doc, a, lastSeq(a));
    setCur(CV, L - 1000);
    await ack(doc, a, lastSeq(a));
    expect(knows(CV, a)).toBe(false);
    await accepts(doc, b, SYNC.update, insertOnly(doc, 151, 2000));
    expect(pushes(a).at(-1)?.phase).toBe("full");
    const next = lastSeq(a);
    await accepts(doc, a, SYNC.update, insertOnly(doc, 152));
    await ack(doc, a, next);
    await refuses(doc, a, SYNC.update, insertOnly(doc, 153), "full");
  });

  it("R7-28 G-14 with B's last acknowledgement a warning: B is admitted; with it full: refused", async () => {
    for (const lastAcked of ["warning", "full"] as const) {
      await boot();
      const doc = await load(CV, combo().src);
      setCur(CV, L);
      const a = await arrived(doc);
      const b = await arrived(doc, { socketId: "s2", userId: "u2" });
      await ack(doc, b, lastSeq(b));
      setCur(CV, 10_485_000);
      if (lastAcked === "warning") await ack(doc, b, lastSeq(b));
      expect(knows(CV, b)).toBe(lastAcked === "full");
      const uA = insertOnly(doc, 161, 2000);
      expect(cost(uA, doc)).toBeGreaterThan(760);
      const hold = deferred();
      activity.hold = hold.promise;
      const pA = beforeSync(doc, a, SYNC.update, uA);
      await flush();
      expect(rec(CV).current).toBeGreaterThanOrEqual(L);
      activity.hold = undefined;
      const uB = insertOnly(doc, 162, 10);
      if (lastAcked === "warning") await accepts(doc, b, SYNC.update, uB);
      else await refuses(doc, b, SYNC.update, uB, "full");
      hold.resolve();
      await expect(pA).resolves.toBeUndefined();
    }
  });

  it("R7-29 a read-only connection's acknowledgement is recorded and its insert is not checked", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, CEIL);
    const viewer = await arrived(doc, { readOnly: true });
    await ack(doc, viewer, lastSeq(viewer));
    expect(knows(CV, viewer)).toBe(true);
    await notChecked(doc, viewer, SYNC.update, sh12(doc, 171));
  });
});

describe("round 7: the size_ack connection parameter (spec 14b.5)", () => {
  it("R7-35 over the hard ceiling a connection without size_ack=1 is refused and its whole WebSocket closed", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, CEIL);
    const a = await arrived(doc, { params: "" });
    await refuses(doc, a, SYNC.update, sh12(doc, 181), "over_ceiling");
    expect(a.webSocket.close).toHaveBeenCalledTimes(1);
  });

  it("R7-36 with size_ack=1 the same refusal leaves the WebSocket to Hocuspocus", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, CEIL);
    const a = await arrived(doc);
    await refuses(doc, a, SYNC.update, sh12(doc, 182), "over_ceiling");
    expect(a.webSocket.close).not.toHaveBeenCalled();
  });

  it("R7-37 a step 0 refusal and an unexpected exception close the WebSocket of a connection without size_ack=1 only", async () => {
    for (const [params, closes] of [["", 1], [ACK_PARAMS, 0]] as const) {
      await boot();
      const doc = await load(CV, combo().src);
      setCur(CV, 1000);
      const a = await arrived(doc, { params });
      w.filter.markRefused("s1", CV);
      await refuses(doc, a, SYNC.update, sh12(doc, 183), "after_refusal");
      expect(a.webSocket.close, `step 0, params "${params}"`).toHaveBeenCalledTimes(closes);
      reauth(a, CV);
      a.webSocket.close.mockClear();
      await refuses(doc, a, SYNC.update, new Uint8Array([1]), "error");
      expect(a.webSocket.close, `error, params "${params}"`).toHaveBeenCalledTimes(closes);
    }
  });

  it("R7-38 only a size_ack that URLSearchParams reads as exactly 1 keeps the WebSocket open", async () => {
    for (const params of ["size_ack=1", "size_ack=0", "size_ack=true", "", "size_ack=1&size_ack=0"]) {
      await boot();
      const doc = await load(CV, combo().src);
      setCur(CV, CEIL);
      const a = await arrived(doc, { params });
      await refuses(doc, a, SYNC.update, sh12(doc, 184), "over_ceiling");
      const keeps = new URLSearchParams(params).get("size_ack") === "1";
      expect(a.webSocket.close, `params "${params}"`).toHaveBeenCalledTimes(keeps ? 0 : 1);
    }
  });

  it("R7-39 a closed, removed connection without size_ack=1 is refused unmarked and its WebSocket left alone", async () => {
    await boot();
    const doc = await load(CV, combo().src);
    setCur(CV, CEIL);
    const a = await arrived(doc, { params: "" });
    doc.removeConnection(asConnection(a));
    const again = await arrived(doc, { params: "", handshake: false });
    expect(again.socketId).toBe(a.socketId);
    await refusesUnmarked(doc, a, sh12(doc, 185), "over_ceiling");
    expect(a.webSocket.close).not.toHaveBeenCalled();
  });
});

describe("round 8: an update that arrives before the acknowledgement (spec 14c.1)", () => {
  it("R8-01 the insert A wrote before seeing full is admitted when it arrives ahead of the acknowledgement, refused when it arrives after", async () => {
    for (const order of ["update first", "ack first"] as const) {
      await boot();
      const doc = await load(CV, combo().src);
      setCur(CV, L - 1);
      const a = await arrived(doc);
      const b = await arrived(doc, { socketId: "s2", userId: "u2" });
      await accepts(doc, b, SYNC.update, insertOnly(doc, 201, 50_000));
      expect(pushes(a).at(-1)?.phase).toBe("full");
      const n = lastSeq(a);
      const buffered = insertOnly(doc, 202);
      if (order === "update first") {
        await accepts(doc, a, SYNC.update, buffered);
        await ack(doc, a, n);
        expect(knows(CV, a)).toBe(true);
      } else {
        await ack(doc, a, n);
        await refuses(doc, a, SYNC.update, buffered, "full");
      }
    }
  });
});

