// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap as the production hooks enforce it (inner#1790):
 * `beforeSync` steps 1-6 and the refusal (test spec section 6), the trial
 * budget (section 7) and the lifecycle hooks (section 8). A refusal's mark
 * for the inbound filter is observed the way section 6 asks, by the next
 * Update frame being dropped; the filter's own cases live with section 9.
 *
 * The hooks are the ones `createCollabServer` hands to the Hocuspocus
 * `Server` (spec 0.4): its constructor is replaced by one that records the
 * configuration, and each case calls the recorded functions with a real
 * Hocuspocus `Document` carrying fake connections. Nothing re-implements a
 * hook. `checkRateLimit` is a spy; the process token bucket reads global
 * `performance.now()`, which vitest fake timers control, fixed unless a case
 * injects a trial duration. Each case boots a fresh module graph, so size records and the
 * token bucket start empty and full.
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
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";

import {
  C,
  appendUpdate,
  capture,
  cycleUpdate,
  editUpdate,
  fill,
  fragText,
  g9Update,
  handshakeStep2,
  helloDoc,
  imageNodes,
  canvasDoc,
  onChangeBound,
  pendGrowthUpdate,
  preloadPendUpdate,
  pureDeleteUpdate,
  refMeasure,
  refMeasureAfter,
  reload,
  s1Scenario,
  sameStateVector,
  stateVectorAfter,
  storedPendingDsDoc,
  storedPendingIntegrateScenario,
  syncedClient,
  updateShape,
} from "./helpers/document-size-fixtures.js";
import { authFrame, SYNC, syncFrame, WIRE } from "./helpers/live-hocuspocus.js";
import { craft } from "../services/__tests__/helpers/doc-size-ref.js";

const { serverSpy, logger, rateLimit, rateRedis, collabRedis, overrides, trial, activity, analysis, failure, S_CONFIG } = vi.hoisted(() => ({
  // Spec 0.2 S configuration.
  S_CONFIG: {
    max_document_bytes: 1_048_576,
    document_size_warn_ratio: 0.8,
    document_size_full_margin_bytes: 26_214,
    document_size_delete_headroom_bytes: 26_214,
    document_size_overwrite_reserve_bytes: 6_554,
    document_size_measure_interval_ms: 2000,
    document_size_trials_per_user_per_minute: 6,
    document_size_trial_budget_ms_per_second: 200,
  },
  serverSpy: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  rateLimit: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  rateRedis: { on: vi.fn(), name: "db0-rate-limit-redis" },
  collabRedis: { on: vi.fn(), publish: vi.fn(async () => 1), set: vi.fn(async () => null) },
  overrides: { current: {} },
  // A trial duration to inject: armed when step 5 calls `checkRateLimit`,
  // spent on the copy's transaction that brings it to the post-update state.
  trial: { armed: false, pending: undefined as undefined | { ms: number; sv: Uint8Array } },
  // What the account activity half of `beforeSync` waits on, standing in for
  // its Postgres write; undefined lets it finish at once.
  activity: { hold: undefined as undefined | Promise<void> },
  // How long the next skeleton built inside `analyze` takes on the faked
  // clock: spent on the first transaction of a plain Y.Doc while armed.
  analysis: { ms: 0 },
  // Throw from the next transaction of a plain Y.Doc (a skeleton or a trial copy).
  failure: { armed: false },
}));

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

vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  return {
    ...real,
    getCollabConfig: () => ({ ...real.getCollabConfig(), ...S_CONFIG, ...overrides.current }),
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

// The account activity half of `beforeSync` writes to Postgres; it is not
// what these cases measure.
vi.mock("@collab/hooks/account-activity.js", () => ({
  createActivityHook: () => vi.fn(async () => {
    await activity.hold;
  }),
}));

const L = 1_048_576;
const CEIL = 1_074_790;
const FULL_AT = 1_022_362;
const RESERVE = 6_554;
const NAME = "project-p1/canvas-s1";

type SizeModule = typeof SizeModuleShape;

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
  onPeerClose: (peer: unknown, event: unknown) => void;
  onPeerError: (peer: unknown, error: unknown) => void;
}

/** A fake Hocuspocus connection (spec 0.3). */
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
}

let w: World;
const peers = new Map<string, { _hocuspocus: { socketId: string }; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }>();
let emitSpy: { mockRestore: () => void } | undefined;

/**
 * Boot a fresh `createCollabServer` and take the hooks it registered.
 * @param config - Configuration over the S configuration.
 * @returns The hooks and the size module of the same module graph.
 */
async function boot(config: Record<string, unknown> = {}): Promise<World> {
  overrides.current = config;
  vi.resetModules();
  const size = await import("@collab/services/document-size.js");
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
  w = { hooks, size };
  return w;
}

/**
 * Load a document the way Hocuspocus does: a `Document` with the stored state,
 * then the production `afterLoadDocument`.
 * @param name - Document name.
 * @param src - Stored content, if any.
 * @returns The loaded document.
 */
async function load(name: string, src?: Y.Doc): Promise<Document> {
  const doc = new Document(name, undefined, { flushDelay: false });
  if (src) Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
  await w.hooks.afterLoadDocument({
    documentName: name,
    document: doc,
    instance: { documents: new Map([[name, doc]]) },
    context: {},
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: "",
  });
  return doc;
}

/**
 * A fake connection attached to the document's connection set.
 * @param doc - The document.
 * @param opts - Socket, user and read-only flag.
 * @param opts.socketId - Socket id.
 * @param opts.userId - User id.
 * @param opts.readOnly - Read-only flag.
 * @param opts.attach - Whether to register it on the document.
 * @returns The connection.
 */
function conn(
  doc: Document,
  opts: { socketId?: string; userId?: string; readOnly?: boolean; attach?: boolean } = {},
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
    webSocket: Object.assign(new EventEmitter(), { send: vi.fn() }),
  };
  if (opts.attach !== false) doc.addConnection(connection as unknown as Parameters<Document["addConnection"]>[0]);
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
 * Expect `beforeSync` to let the message through, then apply it as Hocuspocus would.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param payload - The update.
 */
async function admit(doc: Document, c: FakeConnection, type: number, payload: Uint8Array): Promise<void> {
  await expect(beforeSync(doc, c, type, payload)).resolves.toBeUndefined();
  if (type !== SYNC.step1) Y.applyUpdate(doc, payload, { source: "connection", connection: c });
}

/**
 * The crossws peer stand-in for a socket.
 * @param socketId - Socket id.
 * @returns The same peer object for the same socket.
 */
function peerOf(socketId: string): { _hocuspocus: { socketId: string }; close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
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
 * Bring `(socketId, key)` to the handshaken state through production frames.
 * @param socketId - Socket id.
 * @param key - Message key (document name, optionally with a `\0` suffix).
 */
function handshake(socketId: string, key: string): void {
  frame(socketId, authFrame(key, "token"));
  frame(socketId, syncFrame(key, WIRE.sync, SYNC.step2, new Uint8Array([0, 0])));
}

/** What a refusal must look like (spec section 6 opening, 0.5.1). */
interface Refusal {
  step: "malformed" | "pending" | "budget_user" | "budget_process" | "trial";
  after?: number;
}

/**
 * Expect `beforeSync` to refuse, with the error, log line, unchanged upper
 * bound and refusal mark the spec requires.
 * @param doc - The document.
 * @param c - The connection.
 * @param type - Sync sub-type.
 * @param payload - The update.
 * @param expected - Step and `after` of the log line.
 * @returns The thrown error.
 */
async function refuse(doc: Document, c: FakeConnection, type: number, payload: Uint8Array, expected: Refusal): Promise<unknown> {
  handshake(c.socketId, doc.name);
  const upperBefore = w.size.readDocSizeRecord(doc.name)?.upper;
  logger.warn.mockClear();
  const err = await beforeSync(doc, c, type, payload).then(
    () => undefined,
    (e: unknown) => e,
  );
  // C-98: an Error carrying only the reason.
  expect(err).toBeInstanceOf(Error);
  expect((err as { reason?: unknown }).reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  expect((err as { code?: unknown }).code).toBeUndefined();
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.warn).toHaveBeenCalledWith(
    {
      documentName: doc.name,
      userId: c.context.user.id,
      upper: upperBefore,
      after: expected.after,
      limit: L,
      ceiling: CEIL,
      step: expected.step,
    },
    "document_size_limit_refused",
  );
  expect(w.size.readDocSizeRecord(doc.name)?.upper).toBe(upperBefore);
  // The refusal marked (socket, document): the next Update frame is dropped.
  expect(frame(c.socketId, syncFrame(doc.name, WIRE.sync, SYNC.update, new Uint8Array([0, 0])))).toBeUndefined();
  return err;
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
 * The push section 5 defines for an upper bound under the S configuration.
 * @param upper - The upper bound.
 * @param phase - The phase.
 * @returns The expected `doc:size` message.
 */
function expectedPush(upper: number, phase: "normal" | "warning" | "full"): Record<string, unknown> {
  return {
    type: "doc:size",
    bytes: upper,
    limit: L,
    ceiling: CEIL,
    room: Math.max(0, FULL_AT - upper),
    overwriteRoom: Math.max(0, CEIL - upper - RESERVE),
    phase,
  };
}

/**
 * The record's upper bound, failing when there is none.
 * @param name - Document name.
 * @returns `upper`.
 */
function upperOf(name: string): number {
  const record = w.size.readDocSizeRecord(name);
  if (!record) throw new Error(`no size record for ${name}`);
  return record.upper;
}

/**
 * Inject how long the next trial takes on the faked clock.
 * @param ms - Trial duration.
 * @param doc - The document the trial copies.
 * @param update - The update the trial applies.
 */
function injectTrialDuration(ms: number, doc: Y.Doc, update: Uint8Array): void {
  trial.pending = { ms, sv: stateVectorAfter(doc, update) };
}

/**
 * Raise the upper bound to the limit, so an append without deletes has to
 * reach step 5 (C-85 (b) shape).
 */
function needTrial(): void {
  w.size.recordExact(NAME, L);
}

/** `checkRateLimit` allowing, the spec's default. */
const allowed = async (): Promise<unknown> => {
  trial.armed = trial.pending !== undefined;
  return { allowed: true };
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    now: 0,
  });
  peers.clear();
  trial.armed = false;
  trial.pending = undefined;
  activity.hold = undefined;
  analysis.ms = 0;
  failure.armed = false;
  rateLimit.mockReset().mockImplementation(allowed);
  const proto = Y.Doc.prototype as unknown as { emit: (name: string, args: unknown[]) => void };
  const realEmit = proto.emit;
  emitSpy = vi.spyOn(proto, "emit").mockImplementation(function (this: Y.Doc, name: string, args: unknown[]): void {
    if (failure.armed && name === "afterTransaction" && !(this instanceof Document)) {
      failure.armed = false;
      throw new Error("injected gate failure");
    }
    if (analysis.ms > 0 && name === "afterTransaction" && !(this instanceof Document)) {
      const ms = analysis.ms;
      analysis.ms = 0;
      vi.advanceTimersByTime(ms);
    }
    const pending = trial.pending;
    if (
      trial.armed &&
      pending &&
      name === "afterTransaction" &&
      !(this instanceof Document) &&
      sameStateVector(Y.encodeStateVector(this), pending.sv)
    ) {
      trial.armed = false;
      trial.pending = undefined;
      vi.advanceTimersByTime(pending.ms);
    }
    realEmit.call(this, name, args);
  });
});

afterEach(() => {
  emitSpy?.mockRestore();
  vi.useRealTimers();
});

describe("beforeSync step 1: not checked", () => {
  it("C-80 (a) lets a meta document's update through without a trial", async () => {
    await boot();
    const doc = await load("project-p1/meta");
    const c = conn(doc);
    await expect(beforeSync(doc, c, SYNC.update, g9Update())).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(w.size.readDocSizeRecord("project-p1/meta")).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("C-80 (b) lets everything through when max_document_bytes is 0", async () => {
    await boot({ max_document_bytes: 0 });
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    await expect(beforeSync(doc, c, SYNC.update, g9Update())).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(w.size.readDocSizeRecord(NAME)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("C-80 (c) never refuses a read-only connection, so a viewer is not disconnected", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    w.size.recordExact(NAME, CEIL + 1);
    const viewer = conn(doc, { readOnly: true });
    await expect(beforeSync(doc, viewer, SYNC.update, g9Update())).resolves.toBeUndefined();
    await expect(beforeSync(doc, viewer, SYNC.update, appendUpdate(doc, 20 * 1024))).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(upperOf(NAME)).toBe(CEIL + 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("C-80 (d) does not check a SyncStep1", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    w.size.recordExact(NAME, CEIL + 1);
    const c = conn(doc);
    await expect(beforeSync(doc, c, SYNC.step1, Y.encodeStateVector(imageNodes(3)))).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(upperOf(NAME)).toBe(CEIL + 1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("beforeSync step 2: updates that would add pending content (C-98 for 'pending')", () => {
  it("C-81 refuses them far below the limit, handshake SyncStep2 included", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    w.size.recordExact(NAME, 1000);
    const c = conn(doc);
    await refuse(doc, c, SYNC.update, pendGrowthUpdate(), { step: "pending" });
    await refuse(doc, c, SYNC.step2, preloadPendUpdate(), { step: "pending" });
    await refuse(doc, c, SYNC.update, cycleUpdate(), { step: "pending" });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(upperOf(NAME)).toBe(1000);
  });

  it("C-82 refuses on wouldPend before integratesStored is considered", async () => {
    await boot();
    const { server, reconnect } = s1Scenario();
    const doc = await load(NAME, server);
    const update = Y.mergeUpdates([reconnect, g9Update()]);
    const analysis = w.size.analyze(update, doc);
    expect(analysis.wouldPend).toBe(true);
    expect(analysis.integratesStored).toBe(true);
    await refuse(doc, conn(doc), SYNC.update, update, { step: "pending" });
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

describe("beforeSync step 3: growthBound 0", () => {
  it("C-83 admits zero-growth messages on a document over the hard ceiling without a trial", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, CEIL + 10_000);
    // An earlier delete of [0, 5), whose bytes a later message repeats.
    const earlierDelete = capture(src, (d) => d.getText("t").delete(0, 5));
    // 200 separate deleted ranges, so a synced client's handshake carries them.
    for (let i = 0; i < 200; i++) src.getText("t").delete(i + 1, 1);
    const doc = await load(NAME, src);
    expect(upperOf(NAME)).toBeGreaterThan(CEIL);
    const c = conn(doc);
    const before = upperOf(NAME);

    await admit(doc, c, SYNC.step2, new Uint8Array([0, 0]));
    expect(upperOf(NAME)).toBe(before);
    await admit(doc, c, SYNC.update, earlierDelete);
    expect(upperOf(NAME)).toBe(before);
    await admit(doc, c, SYNC.step2, handshakeStep2(doc, syncedClient(doc)));
    expect(upperOf(NAME)).toBe(before);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("C-84 sends an update that integrates stored pending content to the trial, not to the upper bound", async () => {
    await boot();
    const { server, filler } = storedPendingIntegrateScenario(2000);
    const doc = await load(NAME, server);
    expect(doc.store.pendingStructs).not.toBeNull();
    w.size.recordExact(NAME, 20_000);
    const expected = refMeasureAfter(doc, filler);
    await admit(doc, conn(doc), SYNC.update, filler);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    const record = w.size.readDocSizeRecord(NAME);
    expect(record?.upper).toBe(expected);
    expect(record?.exact).toBe(expected);
  });
});

describe("beforeSync step 4: admitted on the upper bound", () => {
  it("C-85 (a), C-88 admits at upper + growthBound = limit and adds growthBound", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const update = appendUpdate(doc, 100);
    const g = w.size.analyze(update, doc).growthBound;
    w.size.recordExact(NAME, L - g);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(upperOf(NAME)).toBe(L);
    expect(upperOf(NAME) - (L - g)).toBe(g);
  });

  it("C-85 (b), C-100 sends upper + growthBound = limit + 1 to the trial, keyed per document and user", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const update = appendUpdate(doc, 100);
    const g = w.size.analyze(update, doc).growthBound;
    w.size.recordExact(NAME, L - g + 1);
    const expected = refMeasureAfter(doc, update);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit).toHaveBeenCalledWith(rateRedis, [
      { key: "collab-doc-size-trial:project-p1/canvas-s1:u1", max: 6, windowSeconds: 60 },
    ]);
    const record = w.size.readDocSizeRecord(NAME);
    expect(record?.upper).toBe(expected);
    expect(record?.exact).toBe(expected);
    expect(expected).toBeLessThan(L);
  });

  it("C-86 (a), C-88 admits a live delete with additions up to the ceiling and adds max(0, g - freed)", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.delete(0, 1);
      t.insert(t.length, "y".repeat(100));
    });
    const analysis = w.size.analyze(update, doc);
    expect(analysis.deletesLive).toBe(true);
    const g = analysis.growthBound;
    const f = analysis.freedBytes;
    w.size.recordExact(NAME, CEIL - g);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(upperOf(NAME)).toBe(CEIL - g + Math.max(0, g - f));
    expect(upperOf(NAME) - (CEIL - g)).toBe(Math.max(0, g - f));
  });

  it("C-86 (b) sends upper + growthBound = ceiling + 1 to the trial, which admits it", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.delete(0, 1);
      t.insert(t.length, "y".repeat(100));
    });
    const g = w.size.analyze(update, doc).growthBound;
    w.size.recordExact(NAME, CEIL - g + 1);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("C-87 admits 20 node deletes on a document over the ceiling without a trial or a larger bound", async () => {
    await boot();
    const src = imageNodes(200);
    fill(src, CEIL + 2000);
    const doc = await load(NAME, src);
    expect(refMeasure(doc)).toBeGreaterThan(CEIL + 1000);
    const c = conn(doc);
    const client = syncedClient(doc);
    for (let i = 0; i < 20; i++) {
      const update = capture(client, (d) => d.getMap("nodes").delete(`node-${i}`));
      const before = upperOf(NAME);
      await admit(doc, c, SYNC.update, update);
      expect(upperOf(NAME)).toBeLessThanOrEqual(before);
    }
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

describe("beforeSync step 5: trial budget (C-98 for 'budget_user' and 'budget_process')", () => {
  it("C-89 refuses when the per-user count is spent, without building a copy", async () => {
    await boot();
    rateLimit.mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    const doc = await load(NAME, helloDoc());
    const update = appendUpdate(doc, 100);
    const g = w.size.analyze(update, doc).growthBound;
    w.size.recordExact(NAME, L - g + 1);
    const c = conn(doc);
    c.sendStateless.mockClear();
    await refuse(doc, c, SYNC.update, update, { step: "budget_user" });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(upperOf(NAME)).toBe(L - g + 1);
    expect(pushes(c)).toEqual([]);
  });

  it("C-90 refuses on a negative token bucket without asking checkRateLimit, and admits again at exactly 0", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);

    needTrial();
    const first = appendUpdate(doc, 100);
    injectTrialDuration(1500, doc, first);
    await admit(doc, c, SYNC.update, first);
    expect(trial.pending).toBeUndefined();
    expect(Date.now()).toBe(1500);
    expect(rateLimit).toHaveBeenCalledTimes(1);

    // t = 1500: balance min(200, 200 + 300) - 1500 = -1300.
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
    expect(rateLimit).toHaveBeenCalledTimes(1);

    // t = 8000: -1300 + 6.5 * 200 = 0, not below 0.
    vi.advanceTimersByTime(6500);
    needTrial();
    await admit(doc, c, SYNC.update, appendUpdate(doc, 100));
    expect(rateLimit).toHaveBeenCalledTimes(2);
  });

  it("C-90 refuses at t = 7999, where the balance is -0.2", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    const first = appendUpdate(doc, 100);
    injectTrialDuration(1500, doc, first);
    await admit(doc, c, SYNC.update, first);
    expect(trial.pending).toBeUndefined();

    vi.advanceTimersByTime(6499);
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("C-104 treats a failing checkRateLimit as allowed and logs it, but still obeys the token bucket", async () => {
    await boot();
    const down = new Error("redis down");
    rateLimit.mockImplementation(async () => {
      trial.armed = trial.pending !== undefined;
      throw down;
    });
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    const first = appendUpdate(doc, 100);
    injectTrialDuration(1000, doc, first);
    await admit(doc, c, SYNC.update, first);
    expect(trial.pending).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: down, ctx: { documentName: "project-p1/canvas-s1", userId: "u1" } },
      "doc_size_trial_budget_unavailable",
    );

    // Balance min(200, 200 + 200) - 1000 = -800.
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("C-105 the token bucket starts full, refills R per second up to one second's worth, and may go negative", async () => {
    // The bucket reads global performance.now(), faked here, so a trial's
    // duration moves the clock and refill accrues during it, as C-90's
    // min(200, 200 + 300) - 1500 does. Spec C-105's checkpoints on that clock:
    // 200 -> 150 -> 110 -> 70 after three back-to-back 50 ms trials, then a
    // 300 ms trial ends at t = 450 with min(200, 70 + 60) - 300 = -170.
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);

    /**
     * Admit one append that has to be tried, the trial taking `ms`.
     * @param ms - Injected trial duration; 0 leaves the clock where it is.
     */
    const tried = async (ms: number): Promise<void> => {
      needTrial();
      const update = appendUpdate(doc, 100);
      if (ms > 0) injectTrialDuration(ms, doc, update);
      await admit(doc, c, SYNC.update, update);
      expect(trial.pending).toBeUndefined();
    };
    /** Refuse one append on the token bucket. */
    const refusedOnBucket = async (): Promise<void> => {
      needTrial();
      await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
    };

    for (let i = 0; i < 3; i++) await tried(50);
    expect(Date.now()).toBe(150);
    // Balance 70, not negative: a 300 ms trial still runs.
    await tried(300);
    expect(Date.now()).toBe(450);
    expect(rateLimit).toHaveBeenCalledTimes(4);

    // t = 1000: -170 + 110 = -60.
    vi.advanceTimersByTime(550);
    await refusedOnBucket();
    // t = 1299: -0.2.
    vi.advanceTimersByTime(299);
    await refusedOnBucket();
    expect(rateLimit).toHaveBeenCalledTimes(4);
    // t = 1300: exactly 0, allowed.
    vi.advanceTimersByTime(1);
    await tried(0);
    expect(rateLimit).toHaveBeenCalledTimes(5);

    // 100 s later the balance is capped at 200 (not 0 + 20 000): a 201 ms
    // trial leaves -1, so the next request at the same moment is refused.
    vi.advanceTimersByTime(100_000);
    await tried(201);
    await refusedOnBucket();
    expect(rateLimit).toHaveBeenCalledTimes(6);
  });

  it("C-106 (a) checks the bucket first: at -1 it refuses without calling checkRateLimit", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    const drain = appendUpdate(doc, 100);
    injectTrialDuration(201, doc, drain);
    await admit(doc, c, SYNC.update, drain);
    expect(trial.pending).toBeUndefined();
    rateLimit.mockClear().mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("C-106 (b) at exactly 0 it asks checkRateLimit, which refuses", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    const drain = appendUpdate(doc, 100);
    injectTrialDuration(200, doc, drain);
    await admit(doc, c, SYNC.update, drain);
    expect(trial.pending).toBeUndefined();
    rateLimit.mockClear().mockImplementation(async () => ({ allowed: false, retryAfterSeconds: 30 }));
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_user" });
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("C-106 (c) at exactly 0 with checkRateLimit allowing, it goes on to the trial", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    const drain = appendUpdate(doc, 100);
    injectTrialDuration(200, doc, drain);
    await admit(doc, c, SYNC.update, drain);
    expect(trial.pending).toBeUndefined();
    rateLimit.mockClear().mockImplementation(allowed);
    needTrial();
    const update = appendUpdate(doc, 100);
    const expected = refMeasureAfter(doc, update);
    await admit(doc, c, SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(w.size.readDocSizeRecord(NAME)?.exact).toBe(expected);
  });
});

describe("beforeSync step 6: the trial on a copy (C-98 for 'trial')", () => {
  it("C-91 admits when the copy is within the limit and records the exact size", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    w.size.recordExact(NAME, CEIL - 100);
    const update = appendUpdate(doc, 1000);
    const after = refMeasureAfter(doc, update);
    c.sendStateless.mockClear();
    await admit(doc, c, SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    const record = w.size.readDocSizeRecord(NAME);
    expect(record).toEqual({ exact: after, upper: after, phase: "normal" });
    expect(pushes(c)).toEqual([expectedPush(after, "normal")]);
  });

  it("C-92 admits an update that does not grow a document over the ceiling", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, CEIL + 1000);
    src.getMap("m").set("big", "y".repeat(5000));
    const doc = await load(NAME, src);
    const update = editUpdate(doc, (c) => c.getMap("m").set("big", "z"));
    expect(w.size.analyze(update, doc).deletesLive).toBe(false);
    const pre = refMeasure(doc);
    const after = refMeasureAfter(doc, update);
    expect(after).toBeLessThan(pre);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(upperOf(NAME)).toBe(after);
  });

  it("C-93 (a) admits additions that delete an existing character, up to the ceiling", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, L - 1000);
    const doc = await load(NAME, src);
    w.size.recordExact(NAME, CEIL - 10);
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.insert(t.length, "y".repeat(20_480));
      t.delete(0, 1);
    });
    const after = refMeasureAfter(doc, update);
    expect(after).toBeGreaterThan(L);
    expect(after).toBeLessThanOrEqual(CEIL);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(w.size.readDocSizeRecord(NAME)).toEqual({ exact: after, upper: after, phase: "full" });
  });

  it("C-93 (b) admits additions that delete the update's own last character, up to the ceiling", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, L - 1000);
    const doc = await load(NAME, src);
    w.size.recordExact(NAME, CEIL - 10);
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.insert(t.length, "y".repeat(20_480));
      t.delete(t.length - 1, 1);
    });
    const after = refMeasureAfter(doc, update);
    expect(after).toBeGreaterThan(L);
    expect(after).toBeLessThanOrEqual(CEIL);
    await admit(doc, conn(doc), SYNC.update, update);
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(w.size.readDocSizeRecord(NAME)).toEqual({ exact: after, upper: after, phase: "full" });
  });

  it("C-94 refuses growth past the limit without a delete, and past the ceiling with one", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, L - 1000);
    const doc = await load(NAME, src);
    w.size.recordExact(NAME, CEIL - 10);
    const c = conn(doc);

    const appendOnly = appendUpdate(doc, 20_480);
    const afterA = refMeasureAfter(doc, appendOnly);
    expect(afterA).toBeGreaterThan(L);
    await refuse(doc, c, SYNC.update, appendOnly, { step: "trial", after: afterA });

    const pastCeiling = editUpdate(doc, (d) => {
      const t = d.getText("t");
      t.insert(t.length, "y".repeat(30_720));
      t.delete(0, 1);
    });
    const afterB = refMeasureAfter(doc, pastCeiling);
    expect(afterB).toBeGreaterThan(CEIL);
    await refuse(doc, c, SYNC.update, pastCeiling, { step: "trial", after: afterB });

    expect(rateLimit).toHaveBeenCalledTimes(2);
    expect(upperOf(NAME)).toBe(CEIL - 10);
  });

  it("C-95 refuses deleting one character inside a long entry when over the ceiling", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, CEIL + 1000);
    const doc = await load(NAME, src);
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.delete(Math.floor(t.length / 2), 1);
    });
    const pre = refMeasure(doc);
    const after = refMeasureAfter(doc, update);
    expect(after).toBeGreaterThan(pre);
    expect(after).toBeGreaterThan(CEIL);
    await refuse(doc, conn(doc), SYNC.update, update, { step: "trial", after });
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("C-96 admits deleting half of a fragmented text marked over the ceiling", async () => {
    await boot();
    const doc = await load(NAME, reload(fragText(20_000)));
    w.size.recordExact(NAME, CEIL + 1);
    const before = refMeasure(doc);
    const update = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.delete(0, Math.floor(t.length / 2));
    });
    await admit(doc, conn(doc), SYNC.update, update);
    expect(refMeasure(doc)).toBeLessThan(before);
    expect(upperOf(NAME)).toBeGreaterThanOrEqual(refMeasure(doc));
  });
});

describe("beforeSync: three editors opening or reconnecting at once", () => {
  it("C-97 (a)(b) admits empty and no-edit handshakes over the limit and over the ceiling without a trial", async () => {
    await boot();
    const overLimit = new Y.Doc();
    fill(overLimit, L + 5000);
    const overCeiling = new Y.Doc();
    fill(overCeiling, CEIL + 5000);
    for (const [name, src] of [["project-p1/canvas-s1", overLimit], ["project-p1/canvas-s2", overCeiling]] as const) {
      const doc = await load(name, src);
      const before = upperOf(name);
      const editors = ["u1", "u2", "u3"].map((userId, i) => conn(doc, { userId, socketId: `s${i + 1}` }));
      const handshakes = editors.map(() => handshakeStep2(doc, syncedClient(doc)));
      for (const editor of editors) await admit(doc, editor, SYNC.step2, new Uint8Array([0, 0]));
      for (const [i, editor] of editors.entries()) await admit(doc, editor, SYNC.step2, handshakes[i]!);
      expect(upperOf(name)).toBe(before);
    }
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("C-97 (c) admits reconnects carrying one offline move and one character on a full canvas without a trial", async () => {
    await boot();
    const src = canvasDoc(2000, 0.5);
    fill(src, FULL_AT + 100);
    const doc = await load(NAME, src);
    expect(w.size.readDocSizeRecord(NAME)?.phase).toBe("full");
    const editors = ["u1", "u2", "u3"].map((userId, i) => conn(doc, { userId, socketId: `s${i + 1}` }));
    const handshakes = editors.map((_, i) => {
      const client = syncedClient(doc);
      const live = [...client.getMap<Y.Map<unknown>>("nodes").keys()][i];
      if (live === undefined) throw new Error("no live node");
      client.getMap<Y.Map<unknown>>("nodes").get(live)?.set("x", 999);
      client.getText("t").insert(5, "k");
      return handshakeStep2(doc, client);
    });
    for (const [i, editor] of editors.entries()) await admit(doc, editor, SYNC.step2, handshakes[i]!);
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

describe("beforeSync: phase changes push", () => {
  it("C-99 pushes warning and then full to every connection as admitted updates cross the lines", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const a = conn(doc, { socketId: "s1" });
    const b = conn(doc, { socketId: "s2", userId: "u2" });

    w.size.recordExact(NAME, 838_000);
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    const toWarning = appendUpdate(doc, 1000);
    expect(w.size.analyze(toWarning, doc).growthBound).toBeGreaterThan(861);
    await admit(doc, a, SYNC.update, toWarning);
    expect(pushes(a).map((p) => p.phase)).toEqual(["warning"]);
    expect(pushes(b).map((p) => p.phase)).toEqual(["warning"]);

    w.size.recordExact(NAME, 1_022_000);
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    const toFull = appendUpdate(doc, 1000);
    expect(w.size.analyze(toFull, doc).growthBound).toBeGreaterThan(362);
    await admit(doc, a, SYNC.update, toFull);
    expect(pushes(a).map((p) => p.phase)).toEqual(["full"]);
    expect(pushes(b).map((p) => p.phase)).toEqual(["full"]);
  });
});

describe("beforeSync: an admitted update still on its way when the size is measured", () => {
  /**
   * A document whose one node carries most of its size, loaded with its
   * measure interval already over, so the next recompute is due at once.
   * @returns The document, a client synced with it and a connection.
   */
  async function loadedNode(): Promise<{ doc: Document; client: Y.Doc; c: FakeConnection }> {
    await boot();
    const src = new Y.Doc();
    const node = new Y.Map<unknown>();
    src.getMap<Y.Map<unknown>>("nodes").set("f", node);
    node.set("blob", "x".repeat(200_000));
    const doc = await load(NAME, src);
    vi.advanceTimersByTime(3000);
    return { doc, client: syncedClient(doc), c: conn(doc) };
  }

  /**
   * Let `beforeSync` admit an update, run the due recompute while the
   * activity step still holds it back, then apply it as Hocuspocus does.
   * @param doc - The document.
   * @param c - The connection.
   * @param update - The update.
   * @returns The upper bound right after the update landed.
   */
  async function admitAcrossRecompute(doc: Document, c: FakeConnection, update: Uint8Array): Promise<number> {
    let release = (): void => undefined;
    activity.hold = new Promise<void>((resolve) => { release = resolve; });
    const sync = beforeSync(doc, c, SYNC.update, update);
    // The gate has returned and the activity write is in flight.
    await vi.advanceTimersByTimeAsync(0);
    release();
    await expect(sync).resolves.toBeUndefined();
    Y.applyUpdate(doc, update, { source: "connection", connection: c });
    return upperOf(NAME);
  }

  it("keeps the bound of an addition measured before it landed", async () => {
    const { doc, client, c } = await loadedNode();
    const update = capture(client, (d) => d.getText("t").insert(0, "y".repeat(50_000)));
    expect(await admitAcrossRecompute(doc, c, update)).toBeGreaterThanOrEqual(refMeasure(doc));
  });

  it("measures a delete again once it has landed, and pushes the smaller size", async () => {
    const { doc, client, c } = await loadedNode();
    const update = capture(client, (d) => d.getMap("nodes").delete("f"));
    await admitAcrossRecompute(doc, c, update);
    vi.advanceTimersByTime(2000);
    const exact = refMeasure(doc);
    expect(exact).toBeLessThan(1000);
    expect(upperOf(NAME)).toBe(exact);
    expect(pushes(c).at(-1)).toEqual(expectedPush(exact, "normal"));
  });

  /**
   * Call the production `afterHandleMessage`, which Hocuspocus runs after
   * every message whether or not it was applied.
   * @param doc - The document.
   * @param c - The connection the message came on.
   * @returns The hook's promise.
   */
  function afterHandleMessage(doc: Document, c: FakeConnection): Promise<void> {
    return w.hooks.afterHandleMessage({ documentName: doc.name, document: doc, connection: c, context: c.context, socketId: c.socketId });
  }

  it("forgets an admitted update that the activity step refused", async () => {
    const { doc, client, c } = await loadedNode();
    const update = capture(client, (d) => d.getText("t").insert(0, "y".repeat(50_000)));
    activity.hold = Promise.reject(new Error("activity write failed"));
    await expect(beforeSync(doc, c, SYNC.update, update)).rejects.toThrow("activity write failed");
    await afterHandleMessage(doc, c);
    w.size.recordExact(NAME, refMeasure(doc));
    expect(upperOf(NAME)).toBe(refMeasure(doc));
  });

  it("forgets an admitted update Hocuspocus skipped because the connection turned read-only", async () => {
    const { doc, client, c } = await loadedNode();
    const update = capture(client, (d) => d.getText("t").insert(0, "y".repeat(50_000)));
    await expect(beforeSync(doc, c, SYNC.update, update)).resolves.toBeUndefined();
    // Demoted while the activity step awaited: Hocuspocus does not apply it.
    c.readOnly = true;
    await afterHandleMessage(doc, c);
    w.size.recordExact(NAME, refMeasure(doc));
    expect(upperOf(NAME)).toBe(refMeasure(doc));
  });

  it("measures again when an update the trial admitted is never applied", async () => {
    const { doc, client, c } = await loadedNode();
    w.size.recordExact(NAME, L);
    const update = capture(client, (d) => d.getText("t").insert(0, "y".repeat(50_000)));
    await expect(beforeSync(doc, c, SYNC.update, update)).resolves.toBeUndefined();
    expect(rateLimit).toHaveBeenCalledTimes(1);
    expect(upperOf(NAME)).toBe(refMeasureAfter(doc, update));
    c.readOnly = true;
    await afterHandleMessage(doc, c);
    vi.advanceTimersByTime(2000);
    expect(upperOf(NAME)).toBe(refMeasure(doc));
  });

  it("forgets an admitted update whose sync sub-type Hocuspocus does not know", async () => {
    const { doc, client, c } = await loadedNode();
    const update = capture(client, (d) => d.getText("t").insert(0, "y".repeat(50_000)));
    await expect(beforeSync(doc, c, 3, update)).resolves.toBeUndefined();
    await afterHandleMessage(doc, c);
    w.size.recordExact(NAME, refMeasure(doc));
    expect(upperOf(NAME)).toBe(refMeasure(doc));
  });
});

describe("beforeSync: admitted updates of other connections still on their way", () => {
  /**
   * A document just under the limit, two writers synced with it.
   * @returns The document, its measure and two connections.
   */
  async function nearLimit(): Promise<{ doc: Document; a: FakeConnection; b: FakeConnection }> {
    await boot();
    const src = new Y.Doc();
    fill(src, L - 30_000);
    const doc = await load(NAME, src);
    return { doc, a: conn(doc, { socketId: "sa", userId: "ua" }), b: conn(doc, { socketId: "sb", userId: "ub" }) };
  }

  it("refuses a trial whose copy fits only because another admitted update has not landed", async () => {
    const { doc, a, b } = await nearLimit();
    const first = appendUpdate(doc, 20_000);
    const second = appendUpdate(doc, 20_000, "z");
    // The first one fits under the upper bound and waits for its activity write.
    await expect(beforeSync(doc, a, SYNC.update, first)).resolves.toBeUndefined();
    expect(rateLimit).not.toHaveBeenCalled();
    expect(refMeasureAfter(doc, second)).toBeLessThanOrEqual(L);
    await refuse(doc, b, SYNC.update, second, { step: "trial", after: refMeasureAfter(doc, second) });
  });

  it("refuses the second of two concurrent trials that fit the limit only one at a time", async () => {
    const { doc, a, b } = await nearLimit();
    w.size.recordExact(NAME, L);
    const first = appendUpdate(doc, 20_000);
    const second = appendUpdate(doc, 20_000, "z");
    handshake(b.socketId, doc.name);
    const results = await Promise.allSettled([beforeSync(doc, a, SYNC.update, first), beforeSync(doc, b, SYNC.update, second)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(((results[1] as PromiseRejectedResult).reason as { reason?: unknown }).reason).toBe(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  });
});

describe("beforeSync: the token bucket under concurrent messages", () => {
  it("refuses a trial whose bucket check ran before another trial spent the balance", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const a = conn(doc, { socketId: "sa", userId: "ua" });
    const b = conn(doc, { socketId: "sb", userId: "ub" });
    needTrial();
    const first = appendUpdate(doc, 100);
    const second = appendUpdate(doc, 100, "z");
    injectTrialDuration(1500, doc, first);
    handshake(b.socketId, doc.name);
    logger.warn.mockClear();
    const results = await Promise.allSettled([beforeSync(doc, a, SYNC.update, first), beforeSync(doc, b, SYNC.update, second)]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn.mock.calls[0]?.[0] as { step?: unknown }).step).toBe("budget_process");
  });

  it("charges the skeleton built for an update reaching stored pending content", async () => {
    await boot();
    const { server, filler } = storedPendingIntegrateScenario(2000);
    const doc = await load(NAME, server);
    const a = w.size.analyze(filler, doc);
    expect(a.skeletonBuilt).toBe(false);
    expect(a.integratesStored).toBe(true);
    analysis.ms = 1500;
    // Balance min(200, 200) - 1500 = -1300 before the trial's own check.
    await refuse(doc, conn(doc), SYNC.update, filler, { step: "budget_process" });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("charges the time a skeleton took to the token bucket", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    // Two offline writers: the second one's origin is the first one's new text.
    const one = syncedClient(doc, 101);
    const typed = capture(one, (d) => d.getText("t").insert(0, "ab"));
    const two = syncedClient(doc, 102);
    Y.applyUpdate(two, typed);
    const update = Y.mergeUpdates([typed, capture(two, (d) => d.getText("t").insert(2, "c"))]);
    const a = w.size.analyze(update, doc);
    expect(a.skeletonBuilt).toBe(true);
    expect(a.wouldPend).toBe(false);
    analysis.ms = 1500;
    await admit(doc, c, SYNC.update, update);
    expect(rateLimit).not.toHaveBeenCalled();
    // Balance min(200, 200) - 1500 = -1300.
    needTrial();
    await refuse(doc, c, SYNC.update, appendUpdate(doc, 100), { step: "budget_process" });
  });

  it("logs an unexpected failure with its context and lets it close the connection", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const c = conn(doc);
    needTrial();
    handshake(c.socketId, doc.name);
    const update = appendUpdate(doc, 100);
    failure.armed = true;
    const err = await beforeSync(doc, c, SYNC.update, update).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { reason?: unknown }).reason).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err, ctx: { documentName: doc.name, userId: c.context.user.id } }),
      "document_size_gate_failed",
    );
  });

  it("refuses an update listing one client in two groups before any bound or trial", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const writer = syncedClient(doc, 50);
    const structs = Y.decodeUpdate(capture(writer, (d) => d.getText("t").insert(5, "x".repeat(20)))).structs as Y.Item[];
    const junk = new Y.Item(Y.createID(50, 10_000_000), null, structs[0]!.origin, null, null, null, null, new Y.ContentString("z"));
    const twice = craft([{ client: 50, clock: 10_000_000, structs: [junk] }, { client: 50, clock: 0, structs }]);
    await refuse(doc, conn(doc), SYNC.update, twice, { step: "malformed" });
    expect(rateLimit).not.toHaveBeenCalled();
  });
});

describe("lifecycle hooks", () => {
  it("C-110 afterLoadDocument records the exact size, stored pending delete ranges included", async () => {
    await boot();
    const doc = await load(NAME, storedPendingDsDoc());
    expect(doc.store.pendingDs).not.toBeNull();
    const expected = Y.encodeStateAsUpdate(doc).byteLength + 2 * C;
    expect(w.size.measure(doc)).toBe(expected);
    expect(w.size.readDocSizeRecord(NAME)).toMatchObject({ exact: expected, upper: expected });
  });

  it("C-111 (a)(b)(f) connected pushes the current size to that connection only, read-only included", async () => {
    await boot();
    const doc = await load(NAME, helloDoc());
    const existing = conn(doc, { socketId: "s0" });
    const instance = { documents: new Map([[NAME, doc]]) };
    const cases = [
      [1_030_000, "full", false],
      [900_000, "warning", false],
      [500_000, "normal", false],
      [1_030_000, "full", true],
    ] as const;
    for (const [i, [bytes, phase, readOnly]] of cases.entries()) {
      w.size.recordExact(NAME, bytes);
      existing.sendStateless.mockClear();
      const arriving = conn(doc, { socketId: `s${i + 1}`, readOnly });
      await w.hooks.connected({
        documentName: NAME,
        socketId: arriving.socketId,
        context: arriving.context,
        instance,
        connection: arriving,
        connectionConfig: { readOnly },
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
      });
      expect(pushes(arriving)).toEqual([expectedPush(bytes, phase)]);
      expect(pushes(existing)).toEqual([]);
    }
  });

  it("C-111 (c) connected pushes limit 0 to every Space type when the cap is off", async () => {
    await boot({ max_document_bytes: 0 });
    for (const name of ["project-p1/canvas-s1", "project-p1/document-s2", "project-p1/timeline-s3", "project-p1/3d-s4"]) {
      const doc = new Document(name, undefined, { flushDelay: false });
      const arriving = conn(doc);
      await w.hooks.connected({
        documentName: name,
        socketId: arriving.socketId,
        context: arriving.context,
        instance: { documents: new Map([[name, doc]]) },
        connection: arriving,
        connectionConfig: { readOnly: false },
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
      });
      expect(pushes(arriving)).toEqual([
        { type: "doc:size", bytes: 0, limit: 0, ceiling: 0, room: 0, overwriteRoom: 0, phase: "normal" },
      ]);
    }
  });

  it("C-111 (d)(e) connected pushes nothing on meta, nor to a duplicate closed with 4403", async () => {
    await boot();
    const meta = await load("project-p1/meta");
    const metaConn = conn(meta);
    await w.hooks.connected({
      documentName: "project-p1/meta",
      socketId: metaConn.socketId,
      context: metaConn.context,
      instance: { documents: new Map([["project-p1/meta", meta]]) },
      connection: metaConn,
      connectionConfig: { readOnly: true },
      requestHeaders: new Headers(),
      requestParameters: new URLSearchParams(),
    });
    expect(pushes(metaConn)).toEqual([]);

    const doc = await load(NAME, helloDoc());
    const instance = { documents: new Map([[NAME, doc]]) };
    const first = conn(doc, { socketId: "s9" });
    const duplicate = conn(doc, { socketId: "s9" });
    for (const c of [first, duplicate]) {
      await w.hooks.connected({
        documentName: NAME,
        socketId: "s9",
        context: c.context,
        instance,
        connection: c,
        connectionConfig: { readOnly: false },
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
      });
    }
    expect(duplicate.close).toHaveBeenCalledWith({ code: 4403, reason: "duplicate-document-on-socket" });
    expect(pushes(duplicate)).toEqual([]);
  });

  it("C-112 onChange counts only non-connection updates, by structs and delete ranges", async () => {
    await boot();
    const src = new Y.Doc();
    src.clientID = 1;
    src.getText("t").insert(0, "abcdefghijklmnop");
    const doc = await load(NAME, src);
    w.size.recordExact(NAME, 500_000);

    /**
     * Two inserts and three deletes of existing text in one transaction.
     * @returns The update.
     */
    const twoStructsThreeRanges = (): Uint8Array => editUpdate(doc, (c) => {
      const t = c.getText("t");
      const n = t.length;
      t.delete(n - 1, 1);
      t.delete(n - 4, 1);
      t.delete(n - 7, 1);
      t.insert(1, "X");
      t.insert(4, "Y");
    });
    /**
     * Call onChange after applying the update with that origin.
     * @param update - The update.
     * @param origin - The transaction origin.
     */
    const change = async (update: Uint8Array, origin: unknown): Promise<void> => {
      Y.applyUpdate(doc, update, origin);
      await w.hooks.onChange({
        instance: { documents: new Map([[NAME, doc]]) },
        clientsCount: 0,
        document: doc,
        documentName: NAME,
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
        socketId: "",
        update,
        transactionOrigin: origin,
        connection: undefined,
        context: {},
      });
    };

    const a = twoStructsThreeRanges();
    expect(updateShape(a)).toEqual({ structs: 2, ranges: 3 });
    let before = upperOf(NAME);
    await change(a, { source: "redis" });
    expect(upperOf(NAME) - before).toBe(a.byteLength + 2 * C + 9 * C);

    const b = editUpdate(doc, (c) => {
      const t = c.getText("t");
      t.delete(t.length - 1, 1);
      t.delete(t.length - 3, 1);
      t.delete(t.length - 5, 1);
      t.delete(0, 1);
    });
    expect(updateShape(b)).toEqual({ structs: 0, ranges: 4 });
    before = upperOf(NAME);
    await change(b, { source: "local" });
    expect(upperOf(NAME) - before).toBe(12 * C);

    before = upperOf(NAME);
    await change(new Uint8Array([0, 0]), null);
    expect(upperOf(NAME)).toBe(before);

    const c1 = conn(doc);
    before = upperOf(NAME);
    await change(appendUpdate(doc, 50), { source: "connection", connection: c1 });
    expect(upperOf(NAME)).toBe(before);

    // Spec C-112 starts at 1 074 000, which a ~400-byte bound cannot carry
    // past CEIL; 100 bytes under the ceiling keeps what it checks.
    w.size.recordExact(NAME, CEIL - 100);
    const e = twoStructsThreeRanges();
    expect(updateShape(e)).toEqual({ structs: 2, ranges: 3 });
    await change(e, { source: "redis" });
    expect(upperOf(NAME)).toBe(CEIL - 100 + e.byteLength + 11 * C);
    expect(upperOf(NAME)).toBeGreaterThan(CEIL);
    expect(w.size.readDocSizeRecord(NAME)?.phase).toBe("full");
  });

  it("C-113 onChange counts a null-origin formatting cleanup without throwing", async () => {
    await boot();
    // A pure delete of a bold word inside a nested XmlText: the collab
    // document then removes the orphaned format markers in a transaction of
    // its own, whose origin is null. (A delete made through the editor
    // cleans the markers itself in yjs 13.6.33, so it is sent as a pure delete.)
    const client = new Y.Doc();
    client.clientID = 5;
    const p = new Y.XmlElement("paragraph");
    client.getXmlFragment("doc").insert(0, [p]);
    const xt = new Y.XmlText();
    p.insert(0, [xt]);
    xt.insert(0, "a bold c");
    xt.format(2, 4, { bold: true });
    let word: Y.Item | null = xt._start;
    while (word && !(word.content instanceof Y.ContentString && word.content.str === "bold")) word = word.right;
    if (!word) throw new Error("bold word not found");
    const doc = await load(NAME, client);
    const nullOrigin: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === null) nullOrigin.push(u);
    });
    Y.applyUpdate(doc, pureDeleteUpdate([[word.id.client, word.id.clock, word.length]]), { source: "connection" });
    expect(nullOrigin).toHaveLength(1);
    const cleanup = nullOrigin[0]!;
    const before = upperOf(NAME);
    await expect(
      w.hooks.onChange({
        instance: { documents: new Map([[NAME, doc]]) },
        clientsCount: 0,
        document: doc,
        documentName: NAME,
        requestHeaders: new Headers(),
        requestParameters: new URLSearchParams(),
        socketId: "",
        update: cleanup,
        transactionOrigin: null,
        connection: undefined,
        context: {},
      }),
    ).resolves.toBeUndefined();
    expect(upperOf(NAME)).toBe(before + onChangeBound(cleanup));
  });

  it("C-114 (a) onChange builds no record for meta, nor when the cap is off", async () => {
    await boot();
    const meta = await load("project-p1/meta");
    await expect(
      w.hooks.onChange({ document: meta, documentName: "project-p1/meta", update: g9Update(), transactionOrigin: { source: "redis" }, context: {} }),
    ).resolves.toBeUndefined();
    expect(w.size.readDocSizeRecord("project-p1/meta")).toBeUndefined();

    await boot({ max_document_bytes: 0 });
    const doc = await load(NAME, helloDoc());
    await expect(
      w.hooks.onChange({ document: doc, documentName: NAME, update: g9Update(), transactionOrigin: { source: "redis" }, context: {} }),
    ).resolves.toBeUndefined();
    expect(w.size.readDocSizeRecord(NAME)).toBeUndefined();
  });

  it("C-114 (b) onChange no longer logs the old full-encode warning", async () => {
    await boot();
    const src = new Y.Doc();
    fill(src, L + 5000);
    const doc = await load(NAME, src);
    const update = appendUpdate(doc, 10);
    Y.applyUpdate(doc, update, { source: "redis" });
    await w.hooks.onChange({ document: doc, documentName: NAME, update, transactionOrigin: { source: "redis" }, context: {} });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "Document exceeds max size limit");
  });

  /**
   * Call the production onStateless with a sync confirmation request.
   * @param doc - The document.
   * @param c - The connection.
   * @param payload - The raw stateless payload.
   * @returns The hook's promise.
   */
  function stateless(doc: Document, c: FakeConnection, payload: string): Promise<void> {
    return w.hooks.onStateless({ connection: c, documentName: doc.name, document: doc, payload });
  }

  it("C-115 (a)(b) onStateless confirms and then pushes the size, on canvas, document and timeline in every phase", async () => {
    await boot();
    for (const name of ["project-p1/canvas-s1", "project-p1/document-s2", "project-p1/timeline-s3"]) {
      const doc = await load(name, helloDoc());
      for (const [bytes, phase] of [[500_000, "normal"], [900_000, "warning"], [1_030_000, "full"]] as const) {
        for (const readOnly of [false, true]) {
          w.size.recordExact(name, bytes);
          const c = conn(doc, { readOnly, socketId: `s-${phase}-${readOnly}` });
          const id = randomUUID();
          await stateless(doc, c, JSON.stringify({ type: "sync:confirm", id }));
          const sent = c.sendStateless.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
          expect(sent).toHaveLength(2);
          expect(sent[0]).toEqual({ type: "sync:confirmed", id, ok: !readOnly });
          expect(sent[1]).toMatchObject({ type: "doc:size", bytes, phase });
        }
      }
    }
  });

  it("C-115 (c)(e)(f)(g) onStateless sends nothing more on 3d, to a detached connection, for bad JSON, or after a failed reply", async () => {
    await boot();
    const threeD = await load("project-p1/3d-s4", helloDoc());
    const c3 = conn(threeD);
    await stateless(threeD, c3, JSON.stringify({ type: "sync:confirm", id: randomUUID() }));
    expect(c3.sendStateless).not.toHaveBeenCalled();

    const doc = await load(NAME, helloDoc());
    const detached = conn(doc, { attach: false });
    await stateless(doc, detached, JSON.stringify({ type: "sync:confirm", id: randomUUID() }));
    expect(detached.sendStateless).not.toHaveBeenCalled();

    const c = conn(doc);
    logger.error.mockClear();
    await stateless(doc, c, "{");
    expect(c.sendStateless).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);

    const failing = conn(doc, { socketId: "s2" });
    failing.sendStateless.mockImplementationOnce(() => {
      throw new Error("socket gone");
    });
    logger.error.mockClear();
    await expect(stateless(doc, failing, JSON.stringify({ type: "sync:confirm", id: randomUUID() }))).resolves.toBeUndefined();
    expect(failing.sendStateless).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.anything(), "Sync confirmation failed");
  });

  it("C-115 (d) onStateless confirms a timeline but pushes no size when the cap is off", async () => {
    await boot({ max_document_bytes: 0 });
    const doc = await load("project-p1/timeline-s3", helloDoc());
    const c = conn(doc);
    const id = randomUUID();
    await stateless(doc, c, JSON.stringify({ type: "sync:confirm", id }));
    const sent = c.sendStateless.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
    expect(sent).toEqual([{ type: "sync:confirmed", id, ok: true }]);
  });

  it("C-116 afterUnloadDocument forgets the record, and a reload measures the new content", async () => {
    await boot();
    const first = await load(NAME, helloDoc());
    expect(w.size.readDocSizeRecord(NAME)).toBeDefined();
    first.destroy();
    await w.hooks.afterUnloadDocument({ instance: { documents: new Map() }, documentName: NAME });
    expect(w.size.readDocSizeRecord(NAME)).toBeUndefined();
    const other = imageNodes(5);
    const second = await load(NAME, other);
    expect(w.size.readDocSizeRecord(NAME)?.exact).toBe(refMeasure(second));
  });
});
