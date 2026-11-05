// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Property tests of the document size cap (inner#1790, design 4.1, 4.2 and 8;
 * test spec section 4: INV-1 to INV-10, generators G1-G24, C-60 to C-66).
 *
 * Yjs collaboration is a critical path, so the analysis is held to yjs on a
 * full replica for every generated case: `Δ` against `growthBound` (INV-1,
 * INV-2), `wouldPend` against `ref.truth` both ways (INV-3), the precheck
 * against `ref.truth` (INV-4) and `integratesStored` against
 * `ref.storedReduced` (INV-5). C-65 and C-66 drive the production hooks
 * `createCollabServer` registers (`Server` replaced by a stand-in that records
 * its configuration), never a second copy of the hook logic.
 *
 * Every property runs with a fixed seed; the run counts are the spec's.
 */

import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";
import type * as ConfigModule from "@collab/config.js";
import type * as SizeModuleNs from "@collab/services/document-size.js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";

const h = vi.hoisted(() => ({
  serverSpy: vi.fn(),
  logs: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
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
  getCollabRedis: vi.fn(() => ({ on: vi.fn() })),
  sendMail: vi.fn(async () => ({ status: "skipped", reason: "backend_disabled" })),
  getProjectConcurrentEditorLimit: vi.fn(async () => 100),
  checkRateLimit: h.checkRateLimit,
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

import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";
import {
  GENERATORS,
  S,
  capture,
  deleteOnly,
  S_CONFIG,
  type GeneratorId,
  type Sample,
  fill,
  pendingIntervals,
  pendingUnitsNotIn,
  refMeasure,
  reload,
  replicaOutcome,
  syncedClient,
} from "./helpers/doc-size-ref.js";

type SizeModule = typeof SizeModuleNs;
type DocumentClass = typeof HocuspocusServerModule.Document;
type HocusDocument = InstanceType<DocumentClass>;

/** The production hooks C-65 and C-66 drive. */
interface Hooks {
  beforeSync: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
  onChange: (payload: unknown) => Promise<void>;
}

/** A connection stand-in (spec 0.3). */
interface FakeConnection {
  socketId: string;
  readOnly: boolean;
  context: { user: { id: string } };
  sendStateless: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}

/** What one boot of the server under a configuration hands the tests. */
interface Booted {
  hooks: Hooks;
  size: SizeModule;
  Document: DocumentClass;
}

const SEED = 1790;
const NAME = "project-p1/canvas-s1";

/**
 * Load the production modules afresh under a configuration and capture the
 * hooks `createCollabServer` registers.
 * @param cfg - Values that override `config/collab.yaml`.
 * @returns The hooks, the size module and the Document class of that load.
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
  return { hooks: h.serverSpy.mock.calls.at(-1)?.[0] as Hooks, size, Document };
}

/**
 * A writable connection of user `u1` on socket `s1`.
 * @returns The connection.
 */
function connection(): FakeConnection {
  return { socketId: "s1", readOnly: false, context: { user: { id: "u1" } }, sendStateless: vi.fn(), send: vi.fn() };
}

/**
 * Load a document through the production `afterLoadDocument`.
 * @param b - The booted server.
 * @param state - The stored state.
 * @returns The loaded document.
 */
async function load(b: Booted, state: Uint8Array): Promise<HocusDocument> {
  const document = new b.Document(NAME);
  Y.applyUpdate(document, state);
  await b.hooks.afterLoadDocument({ documentName: NAME, document, context: {}, instance: { documents: new Map() }, requestHeaders: new Headers(), requestParameters: new URLSearchParams(), socketId: "" });
  return document;
}

/**
 * Apply an update the way Hocuspocus does and hand every resulting document
 * update to the production `onChange` with its transaction origin.
 * @param b - The booted server.
 * @param document - The document.
 * @param update - The update.
 * @param origin - The transaction origin.
 */
async function applyWithOnChange(b: Booted, document: HocusDocument, update: Uint8Array, origin: unknown): Promise<void> {
  const events: Array<[Uint8Array, unknown]> = [];
  const h2 = (u: Uint8Array, o: unknown): void => {
    events.push([u, o]);
  };
  document.on("update", h2);
  try {
    Y.applyUpdate(document, update, origin);
  } finally {
    document.off("update", h2);
  }
  for (const [u, o] of events) {
    await b.hooks.onChange({ documentName: NAME, document, update: u, transactionOrigin: o, context: {}, instance: {}, clientsCount: 1, requestHeaders: new Headers(), requestParameters: new URLSearchParams(), socketId: "" });
  }
}

/**
 * Offer a client update to the production `beforeSync`.
 * @param b - The booted server.
 * @param document - The document.
 * @param conn - The connection.
 * @param update - The update (sent as a sync Update, type 2).
 * @returns Whether it was admitted.
 * @throws {Error} When the hook throws for any reason other than the size refusal.
 */
async function offer(b: Booted, document: HocusDocument, conn: FakeConnection, update: Uint8Array): Promise<boolean> {
  try {
    await b.hooks.beforeSync({ documentName: NAME, document, connection: conn, context: conn.context, type: 2, payload: update, clientsCount: 1 });
    return true;
  } catch (err) {
    if ((err as { reason?: unknown }).reason !== COLLAB_DOCUMENT_TOO_LARGE_REASON) throw err;
    return false;
  }
}

/**
 * INV-6: the record's upper bound is at least the real size.
 * @param b - The booted server.
 * @param document - The document.
 */
function expectUpperCovers(b: Booted, document: HocusDocument): void {
  const record = b.size.readDocSizeRecord(NAME);
  expect(record).toBeDefined();
  expect(record!.upper).toBeGreaterThanOrEqual(refMeasure(document));
}

/** Which invariants each generator is checked against (spec 4.2, 4.3). */
const TABLE: Array<[GeneratorId, number[], number]> = [
  ["G1", [1, 2, 3], 300],
  ["G2", [1, 2, 3], 300],
  ["G3", [1, 2, 3], 300],
  ["G4", [1, 2, 3], 300],
  ["G5", [1, 2, 3], 300],
  ["G6", [1, 2, 3], 300],
  ["G7", [1, 2, 3], 300],
  ["G8", [1, 2, 3], 300],
  ["G9", [3, 4], 300],
  ["G10", [3, 4], 300],
  ["G11", [1, 2, 3, 5], 300],
  ["G12", [1, 2, 3], 300],
  ["G13", [1, 2, 3], 300],
  ["G14", [1, 2, 3, 5], 300],
  ["G15", [3, 5], 300],
  ["G16", [3, 5], 300],
  ["G17", [3, 4], 300],
  ["G18", [3, 4], 300],
  ["G19", [3, 4], 300],
  ["G20", [3, 5], 300],
  ["G21", [3, 5], 300],
  ["G22", [1, 2, 3, 4, 5], 3000],
  ["G23", [1, 2, 3], 300],
  ["G24", [1, 2, 3], 300],
];

/** Truth values seen by INV-3 across all generators (C-62 degeneracy guard). */
const truthSeen = { yes: 0, no: 0 };

let size: SizeModule;

beforeAll(async () => {
  size = (await boot({ ...S_CONFIG })).size;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("C-60 to C-64: analyze against yjs on a full replica", () => {
  it.each(TABLE)("%s holds INV-%j", (g, invs, numRuns) => {
    fc.assert(
      fc.property(GENERATORS[g], (s) => {
        const o = replicaOutcome(s.d, s.u);
        const truth = o.added > 0;
        if (g === "G9") expect(truth).toBe(true);
        if (g === "G11") expect(truth).toBe(false);
        const a = size.analyze(s.u, s.d);
        if (invs.includes(3)) {
          // INV-3 (C-62): wouldPend iff the replica gains pending units.
          expect(a.wouldPend).toBe(truth);
          if (truth) truthSeen.yes++;
          else truthSeen.no++;
        }
        if (!a.wouldPend && !a.integratesStored) {
          // INV-1 (C-60) and INV-2 (C-61).
          if (invs.includes(1)) expect(o.delta).toBeLessThanOrEqual(a.growthBound);
          if (invs.includes(2)) expect(o.delta).toBeLessThanOrEqual(Math.max(0, a.growthBound - a.freedBytes));
        }
        // INV-4 (C-63): a precheck miss means yjs cannot pend.
        if (invs.includes(4) && !size.precheckMayPend(s.u, s.d.store)) expect(truth).toBe(false);
        // INV-5 (C-64), for updates that do not pend: an update that pends is
        // refused at step 2 whatever integratesStored says, and C-82 needs both
        // flags true on one update (design 4.1 defines it without wouldPend).
        if (invs.includes(5) && !truth) expect(a.integratesStored).toBe(o.removed > 0);
      }),
      { seed: SEED, numRuns },
    );
  }, 600_000);

  it("C-62 the generators produce at least 50 pending and 50 non-pending samples", () => {
    expect(truthSeen.yes).toBeGreaterThanOrEqual(50);
    expect(truthSeen.no).toBeGreaterThanOrEqual(50);
  });

  it("C-63 a precheck miss never pends, over 3000 mixed samples with at least 100 carrying Skip", () => {
    let withSkip = 0;
    const arb = fc.oneof(
      { arbitrary: GENERATORS.G19, weight: 3 },
      { arbitrary: GENERATORS.G22, weight: 1 },
      { arbitrary: GENERATORS.G9, weight: 1 },
      { arbitrary: GENERATORS.G10, weight: 1 },
      { arbitrary: GENERATORS.G17, weight: 1 },
      { arbitrary: GENERATORS.G18, weight: 1 },
    );
    fc.assert(
      fc.property(arb, (s) => {
        if (Y.decodeUpdate(s.u).structs.some((st) => st instanceof Y.Skip)) withSkip++;
        if (!size.precheckMayPend(s.u, s.d.store)) expect(replicaOutcome(s.d, s.u).added).toBe(0);
      }),
      { seed: SEED, numRuns: 3000 },
    );
    expect(withSkip).toBeGreaterThanOrEqual(100);
  }, 600_000);
});

/**
 * Run the C-65 loop: reload every round, offer pure deletes until one is
 * refused, stop after a round without progress.
 * @param b - The booted server.
 * @param stored0 - The starting stored state.
 * @param nextDelete - Builds the next pure delete from the round's client
 *   view, or null when there is nothing left to delete; `undo` rolls back
 *   its position after a refusal.
 * @returns The final real size.
 */
async function ratchet(
  b: Booted,
  stored0: Uint8Array,
  nextDelete: (view: Y.Doc) => { update: Uint8Array; undo: () => void } | null,
): Promise<number> {
  let stored = stored0;
  let document: HocusDocument | undefined;
  for (let round = 0; round < 100_000; round++) {
    b.size.forget(NAME);
    document = await load(b, stored);
    expectUpperCovers(b, document);
    const view = reload(document);
    const conn = connection();
    let progressed = false;
    for (;;) {
      const next = nextDelete(view);
      if (!next) break;
      if (!(await offer(b, document, conn, next.update))) {
        next.undo();
        break;
      }
      await applyWithOnChange(b, document, next.update, { source: "connection", connection: conn });
      expectUpperCovers(b, document);
      progressed = true;
    }
    stored = Y.encodeStateAsUpdate(document);
    if (!progressed) break;
  }
  b.size.forget(NAME);
  return refMeasure(document!);
}

describe("C-65 only-delete loops end at most at max(ceiling, initial size)", () => {
  it("(a) ratchet-factor: alternate single chars, BATCH per update", async () => {
    const L = 102_400;
    const H = L / 40;
    const b = await boot({ ...S_CONFIG, max_document_bytes: L, document_size_full_margin_bytes: H, document_size_delete_headroom_bytes: H, document_size_overwrite_reserve_bytes: 640 });
    const start = new Y.Doc();
    const initial = fill(start, L - 1);
    const stored0 = Y.encodeStateAsUpdate(start);
    // Spec 0.4: with no injected duration the clock stands still and a trial costs 0.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (batch) => {
        let pos = 1;
        const final = await ratchet(b, stored0, (view) => {
          const t = view.getText("t");
          let n = 0;
          const update = capture(view, () => {
            while (n < batch && pos < t.length) {
              t.delete(pos, 1);
              pos += 1;
              n++;
            }
          });
          if (n === 0) return null;
          const count = n;
          return { update, undo: () => { pos -= count; } };
        });
        expect(final).toBeLessThanOrEqual(Math.max(L + H, initial));
      }),
      { seed: SEED, numRuns: 5 },
    );
  }, 600_000);

  it("(b) delete-ratchet: 20 single-clock ranges per update on the author's text", async () => {
    const L = 262_144;
    const H = Math.round((L * 262_144) / 10_485_760);
    const A = 0x7fff1234;
    const b = await boot({ ...S_CONFIG, max_document_bytes: L, document_size_full_margin_bytes: H, document_size_delete_headroom_bytes: H, document_size_overwrite_reserve_bytes: 1638 });
    const author = new Y.Doc();
    author.clientID = A;
    author.getText("t").insert(0, "a".repeat(L - 40));
    const initial = refMeasure(author);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    let next = 1;
    const final = await ratchet(b, Y.encodeStateAsUpdate(author), () => {
      const batch: Array<[number, number]> = [];
      for (let i = 0; i < 20 && next < L - 40; i++, next += 2) batch.push([next, 1]);
      if (batch.length === 0) return null;
      const n = batch.length;
      return { update: deleteOnly([[A, batch]]), undo: () => { next -= 2 * n; } };
    });
    expect(final).toBeLessThanOrEqual(Math.max(L + H, initial));
  }, 600_000);
});

describe("C-66 model test: admitted updates, system writes and recomputes keep upper above the real size", () => {
  it("holds INV-6 to INV-9 over 500 sequences of 30 steps", async () => {
    const b = await boot({ ...S_CONFIG });
    // A fixed pool of updates from every generator (spec: E2 draws from G1-G24, E3 from G1, G4, G24).
    const pool: Sample[] = [];
    for (const g of Object.keys(GENERATORS) as GeneratorId[]) pool.push(...fc.sample(GENERATORS[g], { numRuns: 4, seed: SEED }));
    const systemPool = pool.filter((s) => s.g === "G1" || s.g === "G4" || s.g === "G24");
    const starts: Uint8Array[] = [
      Y.encodeStateAsUpdate(pool.find((s) => s.g === "G22")!.d),
      Y.encodeStateAsUpdate(pool.find((s) => s.g === "G5")!.d),
      ...[S.FULL_AT - 5000, S.L - 1000, S.L + 5000, S.CEIL + 5000].map((target) => {
        const d = new Y.Doc();
        fill(d, target);
        return Y.encodeStateAsUpdate(d);
      }),
    ];

    /**
     * An edit by a synced client of the current document, of the G1, G4 or
     * G24 kind, so that admitted and system paths see updates that apply.
     * @param document - The document.
     * @param pick - Drives the choice.
     * @param client - The client id.
     * @returns The update.
     */
    const localEdit = (document: Y.Doc, pick: number, client: number): Uint8Array => {
      const c = syncedClient(document, client);
      const t = c.getText("t");
      const nodes = c.getMap("nodes");
      const ups: Uint8Array[] = [];
      c.on("update", (u: Uint8Array) => ups.push(u));
      c.transact(() => {
        const kind = pick % 3;
        if (kind === 2 && nodes.size > 0) {
          const keys = [...nodes.keys()];
          for (let i = 0; i < 1 + (pick % 20) && keys.length > 0; i++) nodes.delete(keys.splice(pick % keys.length, 1)[0]!);
        } else if (kind === 1 && t.length > 2) {
          for (let i = 0; i < 1 + (pick % 50) && 2 * i + 1 < t.length; i++) t.delete(1 + i, 1);
        } else t.insert(pick % (t.length + 1), "y".repeat(1 + (pick % 30_000)));
      });
      return ups.length === 0 ? new Uint8Array([0, 0]) : Y.mergeUpdates(ups);
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const step = fc.record({ event: fc.integer({ min: 0, max: 2 }), pick: fc.nat(), fromPool: fc.boolean(), nullOrigin: fc.boolean() });
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: starts.length - 1 }), fc.array(step, { minLength: 30, maxLength: 30 }), async (startIx, steps) => {
        b.size.forget(NAME);
        const document = await load(b, starts[startIx]!);
        expectUpperCovers(b, document);
        const conn = connection();
        for (const [i, s] of steps.entries()) {
          if (s.event === 0) {
            // E2: a client update judged by beforeSync, applied only when admitted.
            const u = s.fromPool ? pool[s.pick % pool.length]!.u : localEdit(document, s.pick, 0x55aa0000 + i);
            const pre = refMeasure(document);
            const encodedBefore = Y.encodeStateAsUpdate(document);
            const svBefore = Y.encodeStateVector(document);
            const pendingBefore = pendingIntervals(document);
            const deletesLive = b.size.analyze(u, document).deletesLive;
            let changed = false;
            const watch = (): void => {
              changed = true;
            };
            document.on("update", watch);
            const admitted = await offer(b, document, conn, u);
            document.off("update", watch);
            expect(changed).toBe(false);
            if (admitted) {
              await applyWithOnChange(b, document, u, { source: "connection", connection: conn });
              const after = refMeasure(document);
              // INV-7.
              expect(after <= S.L || after <= pre || (deletesLive && after <= S.CEIL)).toBe(true);
              // INV-8.
              expect(pendingUnitsNotIn(pendingIntervals(document), pendingBefore)).toBe(0);
            } else {
              // INV-9, first three parts. Compared as bytes: deep equality
              // walks a megabyte array element by element, seconds per step.
              expect(Buffer.from(Y.encodeStateAsUpdate(document)).equals(encodedBefore)).toBe(true);
              expect(Buffer.from(Y.encodeStateVector(document)).equals(svBefore)).toBe(true);
              expect(pendingUnitsNotIn(pendingIntervals(document), pendingBefore)).toBe(0);
              expect(pendingUnitsNotIn(pendingBefore, pendingIntervals(document))).toBe(0);
            }
          } else if (s.event === 1) {
            // E3: a system write (Redis fan-out or a null-origin transaction) seen through onChange.
            const u = s.fromPool && systemPool.length > 0 ? systemPool[s.pick % systemPool.length]!.u : localEdit(document, s.pick, 0x66bb0000 + i);
            await applyWithOnChange(b, document, u, s.nullOrigin ? null : { source: "redis" });
          } else {
            // E4: past the measure interval.
            await vi.advanceTimersByTimeAsync(2001);
          }
          // INV-6.
          expectUpperCovers(b, document);
        }
        b.size.forget(NAME);
      }),
      { seed: SEED, numRuns: 500 },
    );
  }, 600_000);
});

describe("C-67 trial token bucket", () => {
  // The bucket reads time through the global performance.now(); fake timers
  // fake it (user decision). A trial's duration is injected on top: the
  // bucket reads the clock once when the trial starts and once when it ends
  // (spec 0.4), both after checkRateLimit (step 5 order, answer Q9), so the
  // second read after checkRateLimit returns start + d.
  it("INV-13 and the step 5 order over 1000 random arrival and duration sequences", async () => {
    const request = fc.record({ gap: fc.integer({ min: 0, max: 3000 }), d: fc.integer({ min: 1, max: 2000 }) });
    // One server per R: every boot of the module graph keeps about 10 MB, so
    // 1000 boots run the worker out of memory. A run starts the bucket full
    // the way a fresh boot does: one fake clock and one spy on it for the
    // whole test (a restored spy no longer follows the fake clock, and
    // vi.clearAllTimers() sets the clock back), and every run moves the
    // spied clock 10^9 ms on, more than the deepest balance of 20 trials of
    // 2000 ms needs to refill at R = 1, without firing the servers' timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
    const fakeNow = performance.now.bind(performance);
    let extra = 0;
    let armed: number | null = null;
    let readsSinceArm = 0;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      if (armed !== null && ++readsSinceArm === 2) {
        extra += armed;
        armed = null;
      }
      return fakeNow() + extra;
    });
    let duration = 0;
    let calls = 0;
    h.checkRateLimit.mockImplementation(async () => {
      calls++;
      armed = duration;
      readsSinceArm = 0;
      return { allowed: true };
    });
    const servers = new Map<number, Booted>();
    try {
      await fc.assert(
        fc.asyncProperty(fc.constantFrom(1, 200, 1000), fc.array(request, { minLength: 1, maxLength: 20 }), async (R, requests) => {
          extra += 1e9;
          armed = null;
          let b = servers.get(R);
          if (!b) {
            b = await boot({ ...S_CONFIG, document_size_trial_budget_ms_per_second: R });
            servers.set(R, b);
          }
          const t0 = performance.now();
          const base = new Y.Doc();
          base.clientID = 1;
          base.getText("t").insert(0, "hello");
          const document = await load(b, Y.encodeStateAsUpdate(base));
          const c = syncedClient(document, 2);
          // C-85 (b) shape: an append that needs a trial once upper sits at the ceiling.
          const u = capture(c, () => c.getText("t").insert(5, "y".repeat(100)));
          const conn = connection();
          // The model of design 4.2: full at start, R per second up to R, a
          // trial charged its duration when it ends.
          let balance: number = R;
          let at = t0;
          const refill = (t: number): void => {
            balance = Math.min(R, balance + ((t - at) * R) / 1000);
            at = t;
          };
          let allowedMs = 0;
          let dMax = 0;
          for (const r of requests) {
            vi.advanceTimersByTime(r.gap);
            b.size.recordExact(NAME, S.CEIL);
            const t = performance.now();
            refill(t);
            duration = r.d;
            const callsBefore = calls;
            h.logs.warn.mockClear();
            const admitted = await offer(b, document, conn, u);
            if (balance < -1e-6) {
              expect(admitted).toBe(false);
              expect(calls).toBe(callsBefore);
              expect(h.logs.warn).toHaveBeenCalledTimes(1);
              expect(h.logs.warn.mock.calls[0]?.[0]).toMatchObject({ step: "budget_process" });
              expect(h.logs.warn.mock.calls[0]?.[1]).toBe("document_size_limit_refused");
            } else if (balance > 1e-6) {
              expect(calls).toBe(callsBefore + 1);
              expect(admitted).toBe(true);
              refill(t + r.d);
              balance -= r.d;
              allowedMs += r.d;
              dMax = Math.max(dMax, r.d);
            } else {
              // Within float noise of 0; the outcome is read off the run.
              if (calls > callsBefore) {
                refill(t + r.d);
                balance -= r.d;
                allowedMs += r.d;
                dMax = Math.max(dMax, r.d);
              }
            }
            armed = null;
          }
          const T = (performance.now() - t0) / 1000;
          expect(allowedMs).toBeLessThanOrEqual(R * (T + 1) + dMax);
          b.size.forget(NAME);
        }),
        { seed: SEED, numRuns: 1000 },
      );
    } finally {
      nowSpy.mockRestore();
      h.checkRateLimit.mockImplementation(async () => ({ allowed: true }));
      vi.useRealTimers();
    }
  }, 600_000);
});
