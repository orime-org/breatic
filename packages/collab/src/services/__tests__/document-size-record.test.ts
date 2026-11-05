// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The size record of the document size cap: `recordExact`, `addUpperBound`,
 * `forget`, the phases and the `doc:size` pushes (inner#1790, design 4.1 and
 * 4.3; test spec section 5, C-70 to C-77).
 *
 * The record and the Hocuspocus `Document` it pushes to are created the way
 * production creates them, through the `afterLoadDocument` hook
 * `createCollabServer` registers (answer Q3: the caller hands the document
 * over); the tests then call `recordExact(name, bytes)`,
 * `addUpperBound(name, bound)` and `forget(name)` with the signatures spec 0.5
 * names, and read the record only through `readDocSizeRecord(name)`.
 */

import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import type * as ConfigModule from "@collab/config.js";
import type * as SizeModuleNs from "@collab/services/document-size.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  cfg: {},
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
  getCollabRedis: vi.fn(() => ({ on: vi.fn(), set: vi.fn(async () => "OK") })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  accountActivityRepo: { recordActivity: vi.fn(async () => undefined) },
}));

// Spec 0.2: the configuration reaches production through getCollabConfig.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return { ...real, getCollabConfig: () => Object.freeze({ ...real.getCollabConfig(), ...h.cfg }) };
});

vi.mock("@collab/services/persistence.js", () => ({
  createPersistenceExtension: vi.fn(() => ({ name: "persistence-stub" })),
}));

vi.mock("@collab/services/connection-registry.js", () => ({
  createConnectionRegistry: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), register: vi.fn(), unregister: vi.fn(), count: vi.fn(async () => 0) })),
}));

vi.mock("@collab/services/legacy-table-conversion.js", () => ({ convertStoredTablesOnLoad: vi.fn(async () => 0) }));

import { DocSizeStatusSchema } from "@breatic/shared";
import { D, D_CONFIG, S, S_CONFIG, refMeasure } from "./helpers/doc-size-ref.js";

type SizeModule = typeof SizeModuleNs;
type DocumentClass = typeof HocuspocusServerModule.Document;
type HocusDocument = InstanceType<DocumentClass>;
type Phase = "normal" | "warning" | "full";

/** A connection stand-in (spec 0.3). */
interface FakeConnection {
  socketId: string;
  readOnly: boolean;
  context: { user: { id: string } };
  sendStateless: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** One boot of the production modules. */
interface Booted {
  afterLoadDocument: (payload: unknown) => Promise<void>;
  size: SizeModule;
  Document: DocumentClass;
}

/** The limits a push is computed from. */
interface Limits {
  L: number;
  CEIL: number;
  FULL_AT: number;
  OVERWRITE: number;
}

const NAME = "project-p1/canvas-s1";

/**
 * Load the production modules afresh under a configuration.
 * @param cfg - Values that override `config/collab.yaml`.
 * @returns The production `afterLoadDocument`, the size module and Document.
 */
async function boot(cfg: Record<string, unknown>): Promise<Booted> {
  h.cfg = cfg;
  vi.resetModules();
  h.serverSpy.mockClear();
  const { createCollabServer } = await import("@collab/hocuspocus.js");
  const size = await import("@collab/services/document-size.js");
  const { Document } = await import("@hocuspocus/server");
  const started = await createCollabServer({ collabRedisUrl: "redis://localhost:6379/3", port: 1234, redisKeyPrefix: "test", shutdownDeadline: () => undefined });
  await started.storeLoop.stop();
  started.stopUpgradeSessions();
  started.seatHandover.stop();
  const hooks = h.serverSpy.mock.calls.at(-1)?.[0] as { afterLoadDocument: Booted["afterLoadDocument"] };
  return { afterLoadDocument: hooks.afterLoadDocument, size, Document };
}

/**
 * A connection; pushes are timestamped with the (possibly fake) clock.
 * @param socketId - Its socket.
 * @param times - Where push times are collected.
 * @returns The connection.
 */
function connection(socketId: string, times: number[] = []): FakeConnection {
  return {
    socketId,
    readOnly: false,
    context: { user: { id: "u-" + socketId } },
    sendStateless: vi.fn((payload: string) => {
      if ((JSON.parse(payload) as { type?: string }).type === "doc:size") times.push(Date.now());
    }),
    send: vi.fn(),
  };
}

/**
 * Load a small document through the production hook, then attach connections.
 * @param b - The booted modules.
 * @param name - Document name.
 * @param conns - Connections to attach after the load.
 * @returns The document.
 */
async function loadWith(b: Booted, name: string, conns: FakeConnection[]): Promise<HocusDocument> {
  const document = new b.Document(name);
  document.clientID = 1;
  document.getText("t").insert(0, "hello world");
  await b.afterLoadDocument({ documentName: name, document, context: {}, instance: { documents: new Map() }, requestHeaders: new Headers(), requestParameters: new URLSearchParams(), socketId: "" });
  for (const c of conns) document.addConnection(c as never);
  return document;
}

/**
 * `push(conn)` of spec 0.2: the `doc:size` messages a connection received.
 * @param conn - The connection.
 * @returns Parsed pushes in order.
 */
function pushes(conn: FakeConnection): Array<Record<string, unknown>> {
  return conn.sendStateless.mock.calls
    .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === "doc:size");
}

/**
 * The push section 5 expects for an upper bound.
 * @param upper - The record's upper bound.
 * @param phase - Its phase.
 * @param lim - The configuration's limits.
 * @returns The expected `doc:size` message.
 */
function status(upper: number, phase: Phase, lim: Limits = S): Record<string, unknown> {
  return {
    type: "doc:size",
    bytes: upper,
    limit: lim.L,
    ceiling: lim.CEIL,
    room: Math.max(0, lim.FULL_AT - upper),
    overwriteRoom: Math.max(0, lim.CEIL - upper - lim.OVERWRITE),
    phase,
  };
}

/**
 * Assert a connection's pushes, each also valid under the shared schema.
 * @param conn - The connection.
 * @param expected - The expected pushes in order.
 */
function expectPushes(conn: FakeConnection, expected: Array<Record<string, unknown>>): void {
  const got = pushes(conn);
  expect(got).toEqual(expected);
  for (const m of got) expect(DocSizeStatusSchema.safeParse(m).success).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recordExact and the pushes it sends (C-70, C-71, C-76)", () => {
  it("C-70 writes exact and upper and pushes once to every connection", async () => {
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    const c = connection("b");
    await loadWith(b, NAME, [a, c]);
    b.size.recordExact(NAME, 500_000);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: 500_000, upper: 500_000, phase: "normal" });
    const expected = { type: "doc:size", bytes: 500_000, limit: 1_048_576, ceiling: 1_074_790, room: 522_362, overwriteRoom: 568_236, phase: "normal" };
    expectPushes(a, [expected]);
    expectPushes(c, [expected]);
  });

  const sBoundaries: Array<[number, Phase]> = [
    [838_860, "normal"],
    [838_861, "warning"],
    [1_022_361, "warning"],
    [1_022_362, "full"],
    [1_048_577, "full"],
    [1_074_791, "full"],
  ];
  it.each(sBoundaries)("C-71 S config: recordExact(%i) is %s", async (bytes, phase) => {
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, bytes);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: bytes, upper: bytes, phase });
    expectPushes(a, [status(bytes, phase)]);
  });

  it("C-71 S config: past the ceiling room and overwriteRoom are 0", async () => {
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, 1_074_791);
    const [push] = pushes(a);
    expect(push?.room).toBe(0);
    expect(push?.overwriteRoom).toBe(0);
  });

  const dBoundaries: Array<[number, Phase]> = [
    [8_388_607, "normal"],
    [8_388_608, "warning"],
    [10_223_615, "warning"],
    [10_223_616, "full"],
  ];
  it.each(dBoundaries)("C-71 D config: recordExact(%i) is %s", async (bytes, phase) => {
    const b = await boot({ ...D_CONFIG });
    const a = connection("a");
    await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, bytes);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: bytes, upper: bytes, phase });
    expectPushes(a, [status(bytes, phase, D)]);
  });

  it("C-71 D config: at the full line room is 0 and overwriteRoom is 458752", async () => {
    const b = await boot({ ...D_CONFIG });
    const a = connection("a");
    await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, 10_223_616);
    const [push] = pushes(a);
    expect(push?.room).toBe(0);
    expect(push?.overwriteRoom).toBe(458_752);
  });

  it("C-76 pushes only to the connections of the recorded document", async () => {
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    const other = connection("b");
    await loadWith(b, "project-p1/canvas-sA", [a]);
    await loadWith(b, "project-p1/canvas-sB", [other]);
    a.sendStateless.mockClear();
    other.sendStateless.mockClear();
    b.size.recordExact("project-p1/canvas-sA", 900_000);
    expect(pushes(a)).toHaveLength(1);
    expect(pushes(other)).toHaveLength(0);
  });
});

describe("addUpperBound (C-72, C-73)", () => {
  it("C-72 pushes only when the phase changes, before it returns, with bytes = upper", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    const c = connection("b");
    await loadWith(b, NAME, [a, c]);
    b.size.recordExact(NAME, 800_000);
    a.sendStateless.mockClear();
    c.sendStateless.mockClear();

    b.size.addUpperBound(NAME, 1000);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: 800_000, upper: 801_000, phase: "normal" });
    expect(pushes(a)).toHaveLength(0);
    expect(pushes(c)).toHaveLength(0);

    b.size.addUpperBound(NAME, 38_861);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: 800_000, upper: 839_861, phase: "warning" });
    expectPushes(a, [status(839_861, "warning")]);
    expectPushes(c, [status(839_861, "warning")]);

    b.size.addUpperBound(NAME, 200_000);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: 800_000, upper: 1_039_861, phase: "full" });
    expectPushes(a, [status(839_861, "warning"), status(1_039_861, "full")]);
    expectPushes(c, [status(839_861, "warning"), status(1_039_861, "full")]);
  });

  it.each([
    [300_000, "normal"],
    [900_000, "warning"],
    [1_030_000, "full"],
  ])("C-73 from %i (%s): throttled exact recompute, pushed in every phase", async (start) => {
    vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const b = await boot({ ...S_CONFIG });
    const times: number[] = [];
    const a = connection("a", times);
    const document = await loadWith(b, NAME, [a]);
    const m0 = refMeasure(document);
    b.size.recordExact(NAME, start);
    a.sendStateless.mockClear();
    times.length = 0;
    const t0 = Date.now();

    b.size.addUpperBound(NAME, 10);
    await vi.advanceTimersByTimeAsync(500);
    b.size.addUpperBound(NAME, 10);
    await vi.advanceTimersByTimeAsync(1499);
    b.size.addUpperBound(NAME, 10);
    const lastAdd = Date.now() - t0;
    await vi.advanceTimersByTimeAsync(2000);

    // A recompute within 2000 ms of the last addUpperBound.
    expect(times.some((t) => t - t0 >= lastAdd && t - t0 <= lastAdd + 2000)).toBe(true);
    // At most one recompute in any 2000 ms window.
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2000);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: m0, upper: m0, phase: "normal" });
    // Every recompute pushes once, phase unchanged or not; the document is
    // small, so the full pass falls back to normal.
    expectPushes(a, times.map(() => status(m0, "normal")));

    const pushed = times.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(times).toHaveLength(pushed);
  });

  it("C-73 a steady stream of bounds recomputes at most once per 2000 ms and once after the last", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const b = await boot({ ...S_CONFIG });
    const times: number[] = [];
    const a = connection("a", times);
    const document = await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, 300_000);
    times.length = 0;
    const t0 = Date.now();
    for (let i = 0; i < 100; i++) {
      b.size.addUpperBound(NAME, 10);
      await vi.advanceTimersByTimeAsync(100);
    }
    const lastAdd = Date.now() - 100 - t0;
    await vi.advanceTimersByTimeAsync(2000);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2000);
    expect(times.some((t) => t - t0 >= lastAdd && t - t0 <= lastAdd + 2000)).toBe(true);
    const m0 = refMeasure(document);
    expect(b.size.readDocSizeRecord(NAME)).toEqual({ exact: m0, upper: m0, phase: "normal" });
  });
});

describe("forget (C-74)", () => {
  it("cancels the scheduled recompute and ignores later calls for the name", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const b = await boot({ ...S_CONFIG });
    const a = connection("a");
    await loadWith(b, NAME, [a]);
    b.size.recordExact(NAME, 300_000);
    b.size.addUpperBound(NAME, 10);
    b.size.forget(NAME);
    a.sendStateless.mockClear();
    expect(b.size.readDocSizeRecord(NAME)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushes(a)).toHaveLength(0);
    expect(() => b.size.addUpperBound(NAME, 5)).not.toThrow();
    expect(() => b.size.forget(NAME)).not.toThrow();
    expect(() => b.size.forget(NAME)).not.toThrow();
    expect(b.size.readDocSizeRecord(NAME)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pushes(a)).toHaveLength(0);
  });
});

describe("which loads create a record (C-75, C-77)", () => {
  it("C-75 no record when max_document_bytes is 0", async () => {
    const b = await boot({ ...S_CONFIG, max_document_bytes: 0 });
    await loadWith(b, NAME, []);
    expect(b.size.readDocSizeRecord(NAME)).toBeUndefined();
  });

  it.each(["project-p1/meta", "not-a-doc", "project-p1/canvas"])("C-75 no record for %s", async (name) => {
    const b = await boot({ ...S_CONFIG });
    await loadWith(b, name, []);
    expect(b.size.readDocSizeRecord(name)).toBeUndefined();
  });

  it.each(["canvas", "document", "timeline", "3d"])("C-77 a %s Space gets a record of its exact size", async (kind) => {
    const b = await boot({ ...S_CONFIG });
    const name = `project-p1/${kind}-s1`;
    const document = await loadWith(b, name, []);
    const record = b.size.readDocSizeRecord(name);
    expect(record).toBeDefined();
    expect(record!.exact).toBe(refMeasure(document));
    expect(record!.exact).toBe(b.size.measure(document));
  });
});
