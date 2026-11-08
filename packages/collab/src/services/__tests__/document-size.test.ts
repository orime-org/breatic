// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size record of the document size cap, second version (inner#1790,
 * design 4.1 and 4.3; v2 collab test spec sections 4, 8, 14 and 14a: R-01
 * to R-21, PU-01 to PU-07, X-01, X-02, R6-04).
 *
 * Every case boots a fresh module graph and takes the hooks
 * `createCollabServer` hands to the Hocuspocus `Server` (spec 0.4), so the
 * record module is the one production wires. A record is opened either
 * through the production `afterLoadDocument` (where the spec says the hook
 * loads the document, and wherever a transaction on the document must reach
 * the listeners production installs) or through `openDocSizeRecord` with a
 * real Hocuspocus `Document`. Pushes are read off the `sendStateless` spies of
 * fake connections registered on that document. The record is read only
 * through `readDocSizeRecord(name)` (answer Q14). Time is vitest's fake clock.
 */

import { EventEmitter } from "node:events";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import type * as ConfigModule from "@collab/config.js";
import type * as SizeModuleNs from "@collab/services/document-size.js";
import { Document } from "@hocuspocus/server";
import { updateShape } from "@breatic/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  C,
  D,
  D_CONFIG,
  NAMES,
  beyondDs,
  capture,
  cost,
  enc,
  mass,
  nodeDoc,
  pendingStructs,
  syncedClient,
} from "../../__tests__/helpers/document-size-fixtures.js";

const h = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  cfg: { current: {} },
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
  getCollabRedis: vi.fn(() => ({ on: vi.fn(), publish: vi.fn(async () => 1), set: vi.fn(async () => null) })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  accountActivityRepo: { recordActivity: vi.fn(async () => undefined) },
}));

// Spec 0.2: configuration D reaches production through getCollabConfig.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  const { D_CONFIG: base } = await import("../../__tests__/helpers/document-size-fixtures.js");
  return { ...real, getCollabConfig: () => Object.freeze({ ...real.getCollabConfig(), ...base, ...h.cfg.current }) };
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

vi.mock("@collab/services/legacy-table-conversion.js", () => ({ convertStoredTablesOnLoad: vi.fn(async () => 0) }));

vi.mock("@collab/hooks/account-activity.js", () => ({ createActivityHook: () => vi.fn(async () => undefined) }));

type SizeModule = typeof SizeModuleNs;

/** The v2 record as `readDocSizeRecord` returns it. */
interface Rec {
  exact: number;
  current: number;
  phase: "normal" | "warning" | "full";
  heldSum: number;
}

/** A pushed `doc:size` message. */
interface Push {
  type: "doc:size";
  seq: number;
  bytes: number;
  limit: number;
  ceiling: number;
  phase: string;
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

/** The production hooks a case uses. */
interface Hooks {
  afterLoadDocument: (payload: unknown) => Promise<void>;
  beforeSync: (payload: unknown) => Promise<void>;
  afterHandleMessage: (payload: unknown) => Promise<void>;
}

const { CV, DOC, TD, TL, META, ODD } = NAMES;
/** The fake clock's start; spec times are offsets from it. */
const T0 = 1_000_000;

let hooks: Hooks;
let size: SizeModule;

/**
 * Boot a fresh `createCollabServer` and take the hooks it registered.
 * @param config - Configuration over configuration D.
 * @returns Nothing.
 */
async function boot(config: Record<string, unknown> = {}): Promise<void> {
  h.cfg.current = config;
  vi.resetModules();
  size = await import("@collab/services/document-size.js");
  const { createCollabServer } = await import("@collab/hocuspocus.js");
  h.serverSpy.mockClear();
  await createCollabServer({
    collabRedisUrl: "redis://localhost:6379/3",
    port: 0,
    redisKeyPrefix: "document-size-record",
    shutdownDeadline: () => undefined,
  });
  hooks = h.serverSpy.mock.calls.at(-1)?.[0] as Hooks;
}

/**
 * A Hocuspocus `Document` holding a copy of `src`.
 * @param name - The document name.
 * @param src - Content to copy in, if any.
 * @returns The document.
 */
function docOf(name: string, src?: Y.Doc): Document {
  const doc = new Document(name, undefined, { flushDelay: false } as unknown as ConstructorParameters<typeof Document>[2]);
  if (src) Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
  return doc;
}

/**
 * Load a document the way Hocuspocus does: the production `afterLoadDocument`.
 * @param name - The document name.
 * @param src - Stored content, if any.
 * @returns The loaded document.
 */
async function load(name: string, src?: Y.Doc): Promise<Document> {
  const doc = docOf(name, src);
  await hooks.afterLoadDocument({
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
 * Open a record straight through `openDocSizeRecord`.
 * @param name - The document name.
 * @param src - Content, if any.
 * @returns The document.
 */
function open(name: string, src?: Y.Doc): Document {
  const doc = docOf(name, src);
  size.openDocSizeRecord(doc);
  return doc;
}

/**
 * A fake connection registered on the document, so pushes reach it.
 * @param doc - The document.
 * @param socketId - Socket id.
 * @returns The connection.
 */
function conn(doc: Document, socketId = "s1"): FakeConnection {
  const connection: FakeConnection = {
    socketId,
    readOnly: false,
    context: { user: { id: "u1", role: "editor" }, seatCap: null, arrivedAtMs: 0 },
    sendStateless: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    messageAddress: doc.name,
    document: doc,
    webSocket: Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() }),
    request: new Request("http://collab.test/?size_ack=1"),
  };
  doc.addConnection(connection as unknown as Parameters<Document["addConnection"]>[0]);
  return connection;
}

/**
 * The record of a document.
 * @param name - The document name.
 * @returns The record, or undefined without one.
 */
function rec(name: string): Rec | undefined {
  return size.readDocSizeRecord(name);
}

/**
 * The record of a document, which must exist.
 * @param name - The document name.
 * @returns The record.
 * @throws {Error} When there is none.
 */
function must(name: string): Rec {
  const r = rec(name);
  if (!r) throw new Error(`${name} has no record`);
  return r;
}

/**
 * The `doc:size` pushes a connection received; each must carry exactly the
 * six keys of design 3 (X-02) and a non-negative integer `seq`.
 * @param c - The connection.
 * @returns The parsed pushes, oldest first.
 */
function pushes(c: FakeConnection): Push[] {
  const out: Push[] = [];
  for (const [payload] of c.sendStateless.mock.calls as Array<[string]>) {
    const parsed = JSON.parse(payload) as Push;
    if (parsed.type !== "doc:size") continue;
    expect(Object.keys(parsed).sort()).toEqual(["bytes", "ceiling", "limit", "phase", "seq", "type"]);
    expect(Number.isInteger(parsed.seq) && parsed.seq >= 0, `seq ${String(parsed.seq)}`).toBe(true);
    out.push(parsed);
  }
  return out;
}

/**
 * Expect the pushes a connection received to carry consecutive `seq`s.
 * @param c - The connection; every push of its document reached it.
 */
function expectConsecutiveSeqs(c: FakeConnection): void {
  const seqs = pushes(c).map((p) => p.seq);
  expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
}

/**
 * Advance the fake clock to `T0 + ms`, running timers and microtasks due.
 * @param ms - The spec time.
 * @returns Nothing.
 */
async function at(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(T0 + ms - Date.now());
}

/**
 * Let anything due now run (a push arranged by `recordExact`, a measure
 * scheduled for the next turn).
 * @returns Nothing.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Call the production `beforeSync` for an Update message (spec 0.4 payload).
 * @param doc - The document.
 * @param c - The connection.
 * @param update - The update.
 * @returns The hook's promise.
 */
function beforeSync(doc: Document, c: FakeConnection, update: Uint8Array): Promise<void> {
  return hooks.beforeSync({
    clientsCount: doc.getConnectionsCount(),
    context: c.context,
    document: doc,
    documentName: doc.name,
    connection: c,
    type: 2,
    payload: update,
  });
}

/**
 * Call the production `afterHandleMessage` for a connection.
 * @param doc - The document.
 * @param c - The connection.
 * @returns The hook's promise.
 */
function afterHandleMessage(doc: Document, c: FakeConnection): Promise<void> {
  return hooks.afterHandleMessage({ documentName: doc.name, document: doc, connection: c, context: c.context });
}

/**
 * A server document with a little content, and a client synced with it.
 * @returns Both.
 */
function smallDoc(): { src: Y.Doc; client: Y.Doc } {
  const src = new Y.Doc();
  src.getText("t").insert(0, "hello");
  return { src, client: syncedClient(src, 42) };
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"],
    now: T0,
  });
  await boot();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("measure and the record (spec section 4)", () => {
  it("R-01 measure is the encoded state, pending content included and nothing added for it", () => {
    const plain = nodeDoc().server;
    expect(size.measure(plain)).toBe(enc(plain));
    const pending = new Y.Doc();
    Y.applyUpdate(pending, pendingStructs(777, 2000));
    expect(pending.store.pendingStructs?.update.byteLength).toBe(2024);
    expect(size.measure(pending)).toBe(enc(pending));
  });

  it("R-02 afterLoadDocument starts a Space document's record at its exact size", async () => {
    const { src } = smallDoc();
    src.getText("t").insert(5, "x".repeat(950));
    const doc = await load(CV, src);
    const bytes = enc(doc);
    expect(rec(CV)).toEqual({ exact: bytes, current: bytes, phase: "normal", heldSum: 0, seen: new Map() });
  });

  // Unchanged from the first version: no record for meta, unparseable names or limit 0.
  it("R-03 keeps no record for meta, an unparseable name, or a limit of 0", async () => {
    await load(META, smallDoc().src);
    await load(ODD, smallDoc().src);
    expect(rec(META)).toBeUndefined();
    expect(rec(ODD)).toBeUndefined();
    await boot({ max_document_bytes: 0 });
    await load(CV, smallDoc().src);
    expect(rec(CV)).toBeUndefined();
  });

  it("R-04 records document, 3d and timeline Spaces too", async () => {
    for (const name of [DOC, TD, TL]) {
      const doc = await load(name, smallDoc().src);
      const bytes = size.measure(doc);
      expect(rec(name), name).toEqual({ exact: bytes, current: bytes, phase: "normal", heldSum: 0, seen: new Map() });
    }
  });

  it("R-05 sets the phase from current against the warning line and the limit", () => {
    open(CV, smallDoc().src);
    const expected: Array<[number, Rec["phase"]]> = [
      [9_437_183, "normal"],
      [9_437_184, "warning"],
      [10_485_759, "warning"],
      [10_485_760, "full"],
      [10_747_903, "full"],
      [10_747_904, "full"],
    ];
    for (const [bytes, phase] of expected) {
      size.recordExact(CV, bytes);
      expect(must(CV).phase, String(bytes)).toBe(phase);
      expect(must(CV).current, String(bytes)).toBe(bytes);
      expect(must(CV).heldSum).toBe(0);
    }
  });

  it("R-06 R-07 R-08 admit adds to current and held, a measure keeps held on top, release removes one entry, says so and leaves current", () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    size.recordExact(CV, 1000);
    expect(must(CV).current).toBe(1000);
    size.admit(CV, a, 300);
    expect(must(CV).current).toBe(1300);
    size.admit(CV, b, 50);
    expect(must(CV)).toMatchObject({ exact: 1000, current: 1350, heldSum: 350 });
    // R-07
    size.recordExact(CV, 1200);
    expect(must(CV)).toMatchObject({ exact: 1200, current: 1550, heldSum: 350 });
    // R-08
    expect(size.release(CV, a)).toBe(true);
    expect(must(CV)).toMatchObject({ current: 1550, heldSum: 50 });
    size.recordExact(CV, 1400);
    expect(must(CV)).toMatchObject({ exact: 1400, current: 1450, heldSum: 50 });
  });

  it("R-09 release drops the connection's oldest held entry", () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc);
    size.recordExact(CV, 1000);
    size.admit(CV, a, 10);
    size.admit(CV, a, 20);
    size.release(CV, a);
    expect(must(CV).heldSum).toBe(20);
  });

  it("R-10 release of a connection holding nothing returns false and leaves the others' held alone", () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    size.recordExact(CV, 1000);
    size.admit(CV, b, 40);
    expect(size.release(CV, a)).toBe(false);
    expect(must(CV).heldSum).toBe(40);
  });

  it("R-11 addApplied adds to current only", () => {
    open(CV, smallDoc().src);
    size.recordExact(CV, 1000);
    size.addApplied(CV, 500);
    expect(must(CV)).toEqual({ exact: 1000, current: 1500, phase: "normal", heldSum: 0, seen: new Map() });
  });

  it("R-12 every record function is a no-op on a document without a record", () => {
    const doc = open(ODD, smallDoc().src);
    const a = conn(doc);
    expect(() => {
      size.recordExact(ODD, 100);
      size.admit(ODD, a, 10);
      size.addApplied(ODD, 10);
      size.release(ODD, a);
      size.scheduleMeasure(ODD);
      size.forget(ODD);
    }).not.toThrow();
    expect(rec(ODD)).toBeUndefined();
  });

  it("R-13 scheduleMeasure under one interval after the last measure measures when the interval is up", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 123);
    await settle();
    const a = conn(doc);
    await at(500);
    size.scheduleMeasure(CV);
    await at(1999);
    expect(must(CV).exact).toBe(123);
    expect(pushes(a)).toHaveLength(0);
    await at(2000);
    expect(must(CV).exact).toBe(size.measure(doc));
    expect(pushes(a)).toHaveLength(1);
  });

  it("R-14 scheduleMeasure a full interval after the last measure measures on the next turn", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 123);
    await settle();
    const a = conn(doc);
    await at(5000);
    size.scheduleMeasure(CV);
    await settle();
    expect(must(CV).exact).toBe(size.measure(doc));
    expect(pushes(a)).toHaveLength(1);
  });

  it("R-15 scheduleMeasure with a timer already set changes nothing", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 123);
    await settle();
    const a = conn(doc);
    await at(500);
    size.scheduleMeasure(CV);
    await at(800);
    size.scheduleMeasure(CV);
    await at(1500);
    size.scheduleMeasure(CV);
    await at(1999);
    expect(pushes(a)).toHaveLength(0);
    await at(2000);
    expect(pushes(a)).toHaveLength(1);
    expect(must(CV).exact).toBe(size.measure(doc));
    await at(10_000);
    expect(pushes(a)).toHaveLength(1);
  });

  it("R-16 forget drops the record and its timer", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 123);
    await settle();
    const a = conn(doc);
    await at(500);
    size.scheduleMeasure(CV);
    size.forget(CV);
    await at(10_500);
    expect(rec(CV)).toBeUndefined();
    expect(pushes(a)).toHaveLength(0);
    expect(() => {
      size.admit(CV, a, 10);
      size.addApplied(CV, 10);
      size.release(CV, a);
      size.recordExact(CV, 10);
    }).not.toThrow();
    expect(rec(CV)).toBeUndefined();
  });

  it("R-17 admitting schedules no measure; releasing an unapplied message in afterHandleMessage does, and the measure takes its cost out", async () => {
    const { src, client } = smallDoc();
    const doc = await load(CV, src);
    const m = size.measure(doc);
    expect(must(CV)).toMatchObject({ exact: m, current: m });
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    await at(5000);
    const u = capture(client, () => client.getText("t").insert(0, "never applied "));
    const c = cost(u, doc);
    expect(c).toBe(u.byteLength);
    await beforeSync(doc, a, u);
    const admitted = must(CV).current;
    expect(must(CV)).toMatchObject({ exact: m, heldSum: admitted - m });
    // Not applied: the activity write threw or the connection turned read-only.
    await at(10_000);
    expect(must(CV)).toMatchObject({ exact: m, current: admitted });
    expect(pushes(a)).toHaveLength(0);
    await afterHandleMessage(doc, a);
    expect(must(CV).heldSum).toBe(0);
    await at(12_000);
    expect(must(CV)).toMatchObject({ exact: m, current: m, heldSum: 0, phase: "normal" });
    for (const x of [a, b]) {
      expect(pushes(x)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: m, limit: D.L, ceiling: D.CEIL, phase: "normal" }]);
    }
    expect(admitted).toBe(m + c);
  });

  it("R-18 every transaction on a loaded document schedules a measure, whatever its origin", async () => {
    const { src, client } = smallDoc();
    const doc = await load(CV, src);
    const a = conn(doc);
    const loaded = must(CV).exact;
    const origins: unknown[] = [null, { source: "redis" }, { source: "connection", connection: a }];
    let step = 0;
    for (const origin of origins) {
      step++;
      const u = capture(client, () => client.getText("t").insert(0, `edit-${step}-`.repeat(20)));
      Y.applyUpdate(doc, u, origin);
      await at(2000 * step);
      expect(must(CV).exact, JSON.stringify(origin && { source: (origin as { source: string }).source })).toBe(size.measure(doc));
    }
    expect(must(CV).exact).not.toBe(loaded);
  });

  it("R-19 a measure between admitting and applying keeps the held cost; the next measure corrects current", async () => {
    const { src, client } = smallDoc();
    const doc = await load(CV, src);
    const a = conn(doc);
    // An earlier transaction at t=0 schedules the measure at t=2000.
    Y.applyUpdate(doc, capture(client, () => client.getText("t").insert(0, "earlier ")), null);
    await at(1990);
    const u = capture(client, () => client.getText("t").insert(0, "admitted ".repeat(30)));
    size.admit(CV, a, 300);
    await at(2000);
    const beforeApply = size.measure(doc);
    expect(must(CV)).toMatchObject({ exact: beforeApply, current: beforeApply + 300, heldSum: 300 });
    await at(2010);
    Y.applyUpdate(doc, u, { source: "connection", connection: a });
    expect(must(CV)).toMatchObject({ current: beforeApply + 300, heldSum: 0 });
    await at(4000);
    const after = size.measure(doc);
    expect(after).not.toBe(beforeApply);
    expect(must(CV)).toMatchObject({ exact: after, current: after, heldSum: 0 });
  });

  it("R-20 deleting all 500 nodes of a large canvas costs its 4488-byte length, frees 239 708 bytes, and the next measure corrects current", async () => {
    const m = mass(500);
    const doc = await load(CV, m.server);
    const a = conn(doc);
    expect(enc(doc)).toBe(247_618);
    const u = capture(m.client, () => {
      for (const key of [...m.nodes.keys()]) m.nodes.delete(key);
    });
    expect(u.byteLength).toBe(4488);
    expect(updateShape(u, doc.store)).toMatchObject({ pureDelete: true, splitEndpoints: 0, beyondClockRanges: 0, wholeTypesOnly: true });
    expect(cost(u, doc)).toBe(4488);
    const before = must(CV).current;
    await beforeSync(doc, a, u);
    expect(must(CV).current).toBe(before + 4488);
    const measured = size.measure(doc);
    Y.applyUpdate(doc, u, { source: "connection", connection: a });
    expect(measured - size.measure(doc)).toBe(239_708);
    await at(2000);
    expect(must(CV)).toMatchObject({ exact: size.measure(doc), current: size.measure(doc), heldSum: 0 });
  });

  it("R-21 cost is the message length plus C per split endpoint and per beyond-clock range", () => {
    const nd = nodeDoc();
    const textCut = capture(nd.client, () => nd.text.delete(2, 3));
    expect(updateShape(textCut, nd.server.store)).toMatchObject({ pureDelete: true, splitEndpoints: 2 });
    expect(textCut.byteLength).toBe(6);
    expect(cost(textCut, nd.server)).toBe(6 + 2 * C);
    const beyond = beyondDs(4242, 100, 1);
    expect(updateShape(beyond, nd.server.store)).toMatchObject({ pureDelete: true, beyondClockRanges: 1 });
    expect(cost(beyond, nd.server)).toBe(7 + C);
    const insert = capture(nd.client, () => {
      const n2 = new Y.Map<unknown>();
      nd.nodes.set("n2", n2);
      n2.set("name", "abc");
    });
    expect(insert.byteLength).toBe(32);
    expect(cost(insert, nd.server)).toBe(32);
  });
});

describe("doc:size pushes (spec section 8)", () => {
  it("PU-01 a phase change pushes at once to every connection of the document", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 9_437_000);
    await settle();
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    size.admit(CV, a, 184);
    for (const c of [a, b]) {
      expect(pushes(c)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: 9_437_184, limit: D.L, ceiling: D.CEIL, phase: "warning" }]);
    }
    expect(pushes(a)[0]?.seq).toBe(pushes(b)[0]?.seq);
  });

  it("PU-02 admit and addApplied inside one phase, and full below the ceiling, push nothing", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 1000);
    await settle();
    const a = conn(doc);
    size.admit(CV, a, 10);
    size.addApplied(CV, 10);
    await settle();
    expect(must(CV).current).toBe(1020);
    expect(pushes(a)).toHaveLength(0);
    size.release(CV, a);
    size.recordExact(CV, 10_500_000);
    await settle();
    a.sendStateless.mockClear();
    size.admit(CV, a, 10);
    size.addApplied(CV, 10);
    await settle();
    expect(must(CV)).toMatchObject({ current: 10_500_020, phase: "full" });
    expect(pushes(a)).toHaveLength(0);
  });

  it("PU-03 every measure pushes, even with the phase unchanged", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, 123);
    await settle();
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    size.scheduleMeasure(CV);
    await at(2000);
    const current = must(CV).current;
    expect(current).toBe(size.measure(doc));
    for (const c of [a, b]) {
      expect(pushes(c)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: current, limit: D.L, ceiling: D.CEIL, phase: "normal" }]);
    }
    expect(pushes(a)[0]?.seq).toBe(pushes(b)[0]?.seq);
  });

  it("PU-04 addApplied crossing from warning to full pushes full at once", async () => {
    const doc = open(CV, smallDoc().src);
    size.recordExact(CV, D.W);
    await settle();
    expect(must(CV).phase).toBe("warning");
    const a = conn(doc);
    size.addApplied(CV, D.L - D.W);
    expect(pushes(a)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: D.L, limit: D.L, ceiling: D.CEIL, phase: "full" }]);
  });

  it("PU-05 pushes reach only the connections of the document whose phase changed", async () => {
    const cv = open(CV, smallDoc().src);
    const other = open(DOC, smallDoc().src);
    size.recordExact(CV, 1000);
    size.recordExact(DOC, 1000);
    await settle();
    const a = conn(cv, "sa");
    const d = conn(other, "sd");
    size.admit(CV, a, D.W);
    expect(pushes(a)).toHaveLength(1);
    expect(pushes(a)[0]?.phase).toBe("warning");
    expect(pushes(d)).toHaveLength(0);
  });

  it("PU-06 a push carries the record's current and a ceiling of limit plus the delete headroom", async () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc);
    a.sendStateless.mockClear();
    size.recordExact(CV, 9_000_000);
    await settle();
    expect(pushes(a).at(-1)?.bytes).toBe(must(CV).current);
    size.admit(CV, a, 437_184);
    expect(pushes(a).at(-1)?.bytes).toBe(must(CV).current);
    size.addApplied(CV, 2_000_000);
    expect(pushes(a).at(-1)?.bytes).toBe(must(CV).current);
    expect(pushes(a).length).toBeGreaterThanOrEqual(3);
    expectConsecutiveSeqs(a);
    for (const p of pushes(a)) {
      expect(p.limit).toBe(D_CONFIG.max_document_bytes);
      expect(p.ceiling).toBe(D_CONFIG.max_document_bytes + D_CONFIG.document_size_delete_headroom_bytes);
    }
  });

  it("PU-07 over the ceiling the push says full with bytes at or above the ceiling, also when crossing it from full", async () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc);
    size.recordExact(CV, D.CEIL + 10);
    await settle();
    const last = pushes(a).at(-1);
    expect(last).toEqual({ type: "doc:size", seq: expect.any(Number), bytes: D.CEIL + 10, limit: D.L, ceiling: D.CEIL, phase: "full" });
    size.recordExact(CV, D.CEIL - 10);
    await settle();
    a.sendStateless.mockClear();
    size.admit(CV, a, 20);
    expect(pushes(a)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: D.CEIL + 10, limit: D.L, ceiling: D.CEIL, phase: "full" }]);
  });

  it("R6-04 crossing the hard ceiling pushes even with the phase unchanged; staying over does not; a measure always pushes", async () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc, "sa");
    const b = conn(doc, "sb");
    size.recordExact(CV, 10_746_904);
    await settle();
    expect(must(CV).phase).toBe("full");
    a.sendStateless.mockClear();
    b.sendStateless.mockClear();
    /**
     * The push both connections should have received last, and how many each has.
     * @param bytes - The pushed size.
     * @param count - Pushes so far.
     */
    const expectBoth = (bytes: number, count: number): void => {
      for (const c of [a, b]) {
        expect(pushes(c)).toHaveLength(count);
        expect(pushes(c).at(-1)).toEqual({ type: "doc:size", seq: expect.any(Number), bytes, limit: D.L, ceiling: D.CEIL, phase: "full" });
      }
    };
    size.admit(CV, a, 1500);
    expect(must(CV).current).toBe(10_748_404);
    expectBoth(10_748_404, 1);
    size.admit(CV, a, 10);
    expect(pushes(a)).toHaveLength(1);
    size.recordExact(CV, 10_600_000);
    await settle();
    expect(must(CV).current).toBe(10_601_510);
    expectBoth(10_601_510, 2);
    size.admit(CV, a, 200_000);
    expect(must(CV).current).toBe(10_801_510);
    expectBoth(10_801_510, 3);
    expectConsecutiveSeqs(a);
    expect(pushes(b).map((p) => p.seq)).toEqual(pushes(a).map((p) => p.seq));
  });
});

describe("what the second version removes (spec section 14)", () => {
  it("X-01 the record module no longer exports the first version's prediction and upper bound", () => {
    for (const name of ["analyze", "precheckMayPend", "addUpperBound"]) {
      expect(name in size, name).toBe(false);
    }
  });

  it("X-02 a doc:size push carries no room or overwriteRoom", () => {
    const doc = open(CV, smallDoc().src);
    const a = conn(doc);
    a.sendStateless.mockClear();
    size.pushDocSize(CV, a);
    const plain = docOf(ODD);
    const b = conn(plain, "sb");
    size.pushDocSize(ODD, b);
    for (const c of [a, b]) {
      const [payload] = c.sendStateless.mock.calls.at(-1) as [string];
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("room");
      expect(parsed).not.toHaveProperty("overwriteRoom");
    }
    expect(pushes(a)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: must(CV).current, limit: D.L, ceiling: D.CEIL, phase: "normal" }]);
    expect(pushes(b)).toEqual([{ type: "doc:size", seq: expect.any(Number), bytes: 0, limit: 0, ceiling: 0, phase: "normal" }]);
  });
});
