// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The round 7 integration cases of the document size cap (inner#1790, v2
 * collab test spec section 14b: R7-11, R7-31 to R7-33, the integration half
 * of R7-39, R7-40 to R7-42, configuration S), with round 8's R8-02 (14c)
 * and round 9's R9-01 and R9-02 (14d, adjusted by 14e), on a real collab instance:
 * production `createCollabServer` on loopback, real yjs Postgres and Redis,
 * the production auth with real session cookies, and raw WebSocket clients
 * speaking the provider's frames (`helpers/document-size-live.ts`).
 *
 * A socket opened with the helper's defaults is the current web client: its
 * URL carries `size_ack=1` and it answers every `doc:size` with
 * `doc:size-seen`, in the same callback once the document has synced and,
 * for a push before that, when the server's SyncStep2 arrives (spec 14d.2).
 * `{ sizeAck: false }` is a page of the
 * version before (no parameter, no acknowledgement); `{ autoAck: false }`
 * carries the parameter and acknowledges only when the case says so.
 *
 * Two things are wrapped, never replaced: `createLogger` records `warn` and
 * `error` lines while still writing them, and the account activity hook can
 * be held on an Update message until a case releases it, handing the case
 * that message's connection.
 */

import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type { Connection } from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import type * as ActivityModuleShape from "@collab/hooks/account-activity.js";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { isRefused } from "@collab/infra/inbound-filter.js";
import * as size from "@collab/services/document-size.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { S, fill } from "./helpers/document-size-fixtures.js";
import {
  canvasOf,
  decodeFrame,
  documentOf,
  member,
  openDoc,
  openSocket,
  persisted,
  pushWhere,
  refusalsOf,
  refusedFor,
  seed,
  settle,
  startInstance,
  stopInstance,
  untilKnowsFull,
} from "./helpers/document-size-live.js";
import type { Instance, SizeAckOptions, SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC, WIRE, authFrame, statelessFrame, syncFrame, waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
    // Set by a case: the next Update message's activity write waits on it.
    hold: undefined as undefined | Promise<void>,
    // The connection of the held Update message.
    held: undefined as Connection | undefined,
  },
}));

vi.mock("@breatic/core", async (importOriginal) => {
  const real = await importOriginal<typeof CoreModuleShape>();
  return {
    ...real,
    createLogger: (...args: Parameters<typeof real.createLogger>): ReturnType<typeof real.createLogger> => {
      const logger = real.createLogger(...args);
      return new Proxy(logger, {
        get(target, prop, receiver): unknown {
          if (prop === "warn" || prop === "error") {
            return (...lineArgs: unknown[]): unknown => {
              state.logs.push({ level: prop, args: lineArgs });
              return Reflect.apply(Reflect.get(target, prop, receiver), target, lineArgs);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

// R7-39: the activity write of an Update can be made to wait.
vi.mock("@collab/hooks/account-activity.js", async (importOriginal) => {
  const real = await importOriginal<typeof ActivityModuleShape>();
  return {
    ...real,
    createActivityHook: (): ReturnType<typeof real.createActivityHook> => {
      const inner = real.createActivityHook();
      return async (data) => {
        const hold = state.hold;
        if (hold && data.type === SYNC.update) {
          state.hold = undefined;
          state.held = data.connection;
          await hold;
        }
        await inner(data);
      };
    },
  };
});

// Spec 0.2 configuration S.
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  const { S_CONFIG } = await import("./helpers/document-size-fixtures.js");
  return { ...real, getCollabConfig: () => ({ ...real.getCollabConfig(), ...S_CONFIG }) };
});

core.initCore(process.env);
core.loadLocales();
const sockets: SizeSocket[] = [];
let active: Instance;

/**
 * Refusal log lines for a document.
 * @param name - Document name.
 * @returns Their fields.
 */
function refusals(name: string): Array<Record<string, unknown>> {
  return refusalsOf(state.logs, name);
}

/**
 * Open a socket for a fixture's session, closed after the case.
 * @param fixture - Whose session.
 * @param opts - How it acknowledges size pushes (the current web client by default).
 * @returns The socket.
 */
async function socketOf(fixture: ActivityCollabFixture, opts: SizeAckOptions = {}): Promise<SizeSocket> {
  const socket = await openSocket(active.server.address.port, fixture.cookie, opts);
  sockets.push(socket);
  return socket;
}

/**
 * Open and synchronize a document on a socket.
 * @param socket - The socket.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @returns The synced client.
 */
async function syncedVia(socket: SizeSocket, name: string, doc?: Y.Doc): Promise<SizeDocClient> {
  const client = await openDoc(socket, name, { doc });
  await client.sync();
  return client;
}

/**
 * Open and synchronize a document on a new socket.
 * @param fixture - Whose session.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @param opts - How the socket acknowledges size pushes.
 * @returns The synced client.
 */
async function syncedOn(fixture: ActivityCollabFixture, name: string, doc?: Y.Doc, opts: SizeAckOptions = {}): Promise<SizeDocClient> {
  return syncedVia(await socketOf(fixture, opts), name, doc);
}

/**
 * The server's copy of a loaded document.
 * @param name - Document name.
 * @returns The document.
 * @throws {Error} When it is not loaded.
 */
function serverDoc(name: string): Y.Doc {
  const doc = active.hocuspocus.documents.get(name);
  if (!doc) throw new Error(`${name} is not loaded`);
  return doc;
}

/**
 * The server record's `current` of a document.
 * @param name - Document name.
 * @returns Bytes.
 * @throws {Error} When the document has no record.
 */
function cur(name: string): number {
  const record = size.readDocSizeRecord(name);
  if (!record) throw new Error(`no size record for ${name}`);
  return record.current;
}

/**
 * `nodes` of a document.
 * @param doc - The document.
 * @returns The map.
 */
function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("nodes");
}

/**
 * Add a node with a `name` to a client copy.
 * @param doc - The client copy.
 * @param key - Node key.
 * @param name - Its name.
 */
function addNode(doc: Y.Doc, key: string, name: string): void {
  const node = new Y.Map<unknown>();
  nodesOf(doc).set(key, node);
  node.set("name", name);
}

/**
 * Store a canvas grown with `fill` to about `target` bytes.
 * @param name - Document name.
 * @param target - Size aimed for.
 * @param before - Content written before the fill.
 * @returns The measured stored size.
 */
async function seedFilled(name: string, target: number, before?: (doc: Y.Doc) => void): Promise<number> {
  const src = new Y.Doc();
  before?.(src);
  const bytes = fill(src, target);
  await seed(name, src);
  return bytes;
}

/**
 * Wait until every frame a socket sent before now has reached the server and
 * the socket is still open: open another document on it and wait for its Auth answer.
 * @param socket - The socket.
 * @param other - A document of the same Project not otherwise used on it.
 */
async function barrier(socket: SizeSocket, other: string): Promise<void> {
  const since = socket.frames.length;
  socket.send(authFrame(other, "__cookie_auth__"));
  await waitFor(() => socket.frames.slice(since).some((f) => f.documentName === other && f.type === WIRE.auth), `barrier on ${other}`, 10_000);
}

/**
 * Run an edit on a client copy and return its update without sending it.
 * @param doc - The client copy.
 * @param edit - The edit.
 * @returns The update.
 * @throws {Error} When the edit emitted nothing.
 */
function localUpdate(doc: Y.Doc, edit: (d: Y.Doc) => void): Uint8Array {
  let update: Uint8Array | undefined;
  /**
   * Keep the transaction's update.
   * @param u - The update.
   */
  const listener = (u: Uint8Array): void => {
    update = update ? Y.mergeUpdates([update, u]) : u;
  };
  doc.on("update", listener);
  doc.transact(() => edit(doc));
  doc.off("update", listener);
  if (!update) throw new Error("the edit emitted no update");
  return update;
}

/**
 * A promise and its resolver.
 * @returns Both.
 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  active = await startInstance(createCollabServer, inject("REDIS_COLLAB_URL"));
});

afterEach(() => {
  state.hold = undefined;
  state.held = undefined;
  for (const socket of sockets.splice(0)) socket.close();
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (active) await stopInstance(active);
});

describe("a handshake delete set covering only deleted content (spec 14b.2)", () => {
  it("R7-11 a member reopening a warning canvas sends a handshake that changes neither current nor phase, and the next keystroke is admitted", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    // 3000 single characters deleted apart from each other: every reopening
    // member's SyncStep2 carries 3000 delete ranges of already-deleted content.
    const bytes = await seedFilled(name, S.L - 4000, (src) => {
      src.clientID = 0x5000;
      const t = src.getText("t");
      t.insert(0, "x".repeat(6000));
      src.transact(() => {
        for (let i = 5999; i >= 1; i -= 2) t.delete(i, 1);
      });
      const note = new Y.Map<unknown>();
      nodesOf(src).set("note", note);
      note.set("body", new Y.Text("note"));
    });
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    expect(bytes).toBeLessThan(S.L);

    const a = await syncedOn(fixture, name);
    const bFixture = await member(fixture, "editor");
    const b = await syncedOn(bFixture, name);
    const handshake = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(serverDoc(name)));
    expect(handshake.byteLength).toBeGreaterThan(S.L - bytes);
    b.socket.close();
    expect(await settle(a)).toEqual([]);
    const before = cur(name);
    const fromA = a.sizePushes().length;

    const back = await syncedOn(bFixture, name, b.doc);
    expect(await settle(back)).toEqual([]);
    expect(cur(name)).toBe(before);

    a.edit((d) => (nodesOf(d).get("note")!.get("body") as Y.Text).insert(0, "k"));
    expect(await settle(a)).toEqual([]);
    expect(a.sizePushes().slice(fromA).map((p) => p.phase)).not.toContain("full");
    await back.confirm();
    expect((nodesOf(back.doc).get("note")!.get("body") as Y.Text).toString()).toBe("knote");
    expect(refusals(name)).toEqual([]);
  });
});

describe("judging by the phase a connection acknowledged (spec 14b.4)", () => {
  it("R7-31 two updates sent back to back across the limit are both admitted; after A acknowledges full its next add is refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 240_000);
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const fromA = a.sizePushes().length;

    a.edit((d) => addNode(d, "big", "y".repeat(40_000)));
    a.edit((d) => addNode(d, "tail", "t"));
    expect(await settle(a)).toEqual([]);
    await b.confirm();
    expect(nodesOf(b.doc).has("big")).toBe(true);
    expect(nodesOf(b.doc).has("tail")).toBe(true);
    const stored = await persisted(active, name);
    expect(nodesOf(stored).has("big")).toBe(true);
    expect(nodesOf(stored).has("tail")).toBe(true);

    await pushWhere(a, (p) => p.phase === "full", "full push", fromA);
    await untilKnowsFull(active, size, name, fixture.userId);
    a.edit((d) => addNode(d, "after", "a"));
    await refusedFor(a);
    expect(a.closeReasons()).toEqual([COLLAB_DOCUMENT_TOO_LARGE_REASON]);
    await b.confirm();
    expect(nodesOf(b.doc).has("after")).toBe(false);
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
  });

  it("R7-32 a connection that has not acknowledged full adds; once it acknowledges, its next add is refused and only that document connection closes", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 270_000);
    expect(bytes).toBeGreaterThanOrEqual(S.L);
    expect(bytes).toBeLessThan(S.CEIL);
    await syncedOn(fixture, name);
    await untilKnowsFull(active, size, name, fixture.userId);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const cFixture = await member(fixture, "editor");
    const c = await syncedOn(cFixture, name, undefined, { autoAck: false });
    const full = await pushWhere(c, (p) => p.phase === "full", "connected full push");

    c.edit((d) => addNode(d, "c1", "c"));
    expect(await settle(c)).toEqual([]);
    await b.confirm();
    expect(nodesOf(b.doc).has("c1")).toBe(true);

    c.ack(full.seq);
    c.edit((d) => addNode(d, "c2", "c"));
    await refusedFor(c);
    await barrier(c.socket, documentOf(fixture));
    expect(c.socket.closedByServer()).toBe(false);
    expect(nodesOf(serverDoc(name)).has("c2")).toBe(false);
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
  });

  it("R7-33 the full push reaches a bystander before the update that crossed the limit", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 240_000, (src) => addNode(src, "r", "old"));
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const since = b.socket.frames.length;

    a.edit((d) => nodesOf(d).get("r")!.set("name", "z".repeat(30_000)));
    expect(await settle(a)).toEqual([]);
    await b.confirm();
    expect(nodesOf(b.doc).get("r")!.get("name")).toBe("z".repeat(30_000));
    const frames = b.socket.frames.slice(since).filter((f) => f.documentName === name);
    const pushAt = frames.findIndex((f) => f.stateless !== undefined && (JSON.parse(f.stateless) as { type?: unknown; phase?: unknown }).type === "doc:size"
      && (JSON.parse(f.stateless) as { phase?: unknown }).phase === "full");
    const updateAt = frames.findIndex((f) => f.syncSubType === SYNC.update && (f.payload?.byteLength ?? 0) >= 30_000);
    expect(pushAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(pushAt).toBeLessThan(updateAt);
  });
});

describe("the size_ack connection parameter (spec 14b.5)", () => {
  it("R7-39 a closed connection's queued update refused over the ceiling closes no WebSocket of a client without size_ack, and its new connection deletes", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 255_000);
    expect(bytes + 40_032).toBeGreaterThanOrEqual(S.CEIL);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const socket = await socketOf(fixture, { sizeAck: false });
    const c = await syncedVia(socket, name);

    const hold = deferred();
    state.hold = hold.promise;
    const u1 = localUpdate(c.doc, (d) => addNode(d, "u1", "y".repeat(40_000)));
    const u2 = localUpdate(c.doc, (d) => addNode(d, "u2", "z"));
    c.sendSync(SYNC.update, u1);
    c.sendSync(SYNC.update, u2);
    await waitFor(() => state.held !== undefined, "U1's activity write is waiting", 10_000);
    const old = state.held!;
    old.close({ code: 4403, reason: "permission-changed" });
    hold.resolve();

    await waitFor(() => refusals(name).length > 0, "U2's refusal", 10_000);
    expect(refusals(name).map((r) => r.step)).toEqual(["over_ceiling"]);
    expect(nodesOf(serverDoc(name)).has("u1")).toBe(true);
    expect(nodesOf(serverDoc(name)).has("u2")).toBe(false);
    expect(isRefused(old.socketId, name)).toBe(false);
    await barrier(socket, documentOf(fixture));
    expect(socket.closedByServer()).toBe(false);

    const fresh = await syncedVia(socket, name);
    fresh.edit((d) => nodesOf(d).delete("f1"));
    expect(await settle(fresh)).toEqual([]);
    expect(nodesOf(serverDoc(name)).has("f1")).toBe(false);
    await b.confirm();
    expect(nodesOf(b.doc).has("f1")).toBe(false);
    expect(socket.closedByServer()).toBe(false);
  });

  it("R7-40 an old page's add over the ceiling closes its whole WebSocket, and its reconnect handshake carrying the add is refused again", async () => {
    const fixture = await seedCollabActivity();
    const cv = canvasOf(fixture);
    const docName = documentOf(fixture);
    expect(await seedFilled(cv, 300_000)).toBeGreaterThanOrEqual(S.CEIL);
    const socket = await socketOf(fixture, { sizeAck: false });
    const onCv = await syncedVia(socket, cv);
    const onDoc = await syncedVia(socket, docName);
    onDoc.edit((d) => d.getText("t").insert(0, "doc"));
    expect(await settle(onDoc)).toEqual([]);

    onCv.edit((d) => addNode(d, "o1", "o"));
    await waitFor(() => socket.closedByServer(), "the server closes O's WebSocket", 10_000);
    expect(nodesOf(serverDoc(cv)).has("o1")).toBe(false);

    const again = await socketOf(fixture, { sizeAck: false });
    const cvAgain = await openDoc(again, cv, { doc: onCv.doc });
    cvAgain.sendSync(SYNC.step1, Y.encodeStateVector(onCv.doc));
    await waitFor(() => refusals(cv).length >= 2, "the reconnect handshake's refusal", 10_000);
    expect(new Set(refusals(cv).map((r) => r.step))).toEqual(new Set(["over_ceiling"]));
    await waitFor(() => again.closedByServer(), "the server closes O's second WebSocket", 10_000);
    expect(nodesOf(serverDoc(cv)).has("o1")).toBe(false);
    expect(nodesOf(await persisted(active, cv)).has("o1")).toBe(false);

    const docAgain = await syncedOn(fixture, docName, onDoc.doc, { sizeAck: false });
    expect(await settle(docAgain)).toEqual([]);
    expect(serverDoc(docName).getText("t").toString()).toBe("doc");
  });

  it("R7-41 a current page's add over the ceiling closes only that document connection; the other document on its socket stays live", async () => {
    const fixture = await seedCollabActivity();
    const cv = canvasOf(fixture);
    const docName = documentOf(fixture);
    expect(await seedFilled(cv, 300_000)).toBeGreaterThanOrEqual(S.CEIL);
    const socket = await socketOf(fixture);
    const onCv = await syncedVia(socket, cv);
    const onDoc = await syncedVia(socket, docName);
    const b = await syncedOn(await member(fixture, "editor"), docName);

    onCv.edit((d) => addNode(d, "n1", "n"));
    await refusedFor(onCv);
    expect(onCv.closeReasons()).toEqual([COLLAB_DOCUMENT_TOO_LARGE_REASON]);
    const since = socket.frames.length;
    b.edit((d) => d.getText("t").insert(0, "from b"));
    await waitFor(() => onDoc.doc.getText("t").toString() === "from b", "N receives B's write on DOC", 10_000);
    expect(socket.closedByServer()).toBe(false);
    expect(socket.frames.slice(since).filter((f) => f.documentName === docName && f.type === WIRE.auth)).toEqual([]);
    expect(onDoc.closeReasons()).toEqual([]);
  });

  it("R7-42 an old page that never acknowledges is admitted up to the hard ceiling, never refused as full, and its WebSocket closes at the first refusal", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    expect(await seedFilled(name, 200_000)).toBeLessThan(S.W);
    const socket = await socketOf(fixture, { sizeAck: false });
    const o = await syncedVia(socket, name);

    const admittedFrom: number[] = [];
    let refused = false;
    for (let i = 0; i < 6 && !refused; i++) {
      const before = cur(name);
      o.edit((d) => addNode(d, `o${i}`, "y".repeat(40_000)));
      const reasons = await settle(o);
      if (reasons.length > 0) refused = true;
      else admittedFrom.push(before);
    }
    expect(refused).toBe(true);
    for (const before of admittedFrom) expect(before).toBeLessThan(S.CEIL);
    const lines = refusals(name);
    expect(lines.map((r) => r.step)).toEqual(["over_ceiling"]);
    expect(lines[0]!.current as number).toBeGreaterThanOrEqual(S.CEIL);
    await waitFor(() => socket.closedByServer(), "the server closes O's WebSocket", 10_000);
  });
});

describe("round 8: an update written before the full push goes ahead of its acknowledgement (spec 14c.1)", () => {
  it("R8-02 a node a coalescing client wrote before it saw full is sent before the acknowledgement and admitted; its next node is refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, S.L - 25_000);
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    expect(bytes + 40_000).toBeGreaterThanOrEqual(S.L);
    const holder: { a?: SizeDocClient } = {};
    let wrote = false;
    const socketA = await socketOf(fixture, {
      // The user's a1 is still in the 1 ms send buffer when the full push is handled.
      beforeAck: (key, push): void => {
        if (wrote || holder.a === undefined || key !== name || push.phase !== "full") return;
        wrote = true;
        holder.a.edit((d) => addNode(d, "a1", "a"));
      },
    });
    const a = await openDoc(socketA, name, { flushDelayMs: 1 });
    holder.a = a;
    await a.sync();
    const b = await syncedOn(await member(fixture, "editor"), name);
    const sentFrom = socketA.sent.length;

    b.edit((d) => addNode(d, "big", "y".repeat(40_000)));
    expect(await settle(b)).toEqual([]);
    await waitFor(() => wrote && socketA.acks.length > 0, "A wrote a1 and acknowledged full", 10_000);
    expect(await settle(a)).toEqual([]);

    const sent = socketA.sent.slice(sentFrom).map(decodeFrame).filter((f) => f.documentName === name);
    const updateAt = sent.findIndex((f) => f.syncSubType === SYNC.update && Buffer.from(f.payload ?? []).includes("a1"));
    const ackAt = sent.findIndex((f) => f.stateless !== undefined && (JSON.parse(f.stateless) as { type?: unknown }).type === "doc:size-seen");
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(ackAt).toBeGreaterThan(updateAt);

    expect(a.closeReasons()).toEqual([]);
    await b.confirm();
    expect(nodesOf(b.doc).has("a1")).toBe(true);
    expect(nodesOf(await persisted(active, name)).has("a1")).toBe(true);
    expect(refusals(name)).toEqual([]);

    await untilKnowsFull(active, size, name, fixture.userId);
    a.edit((d) => addNode(d, "a2", "b"));
    a.flushPendingUpdates();
    await refusedFor(a);
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
  });
});


/** How the reconnecting client of spec 14d.1 acknowledges the connection's full push. */
type AckOrder = "after-synced" | "at-once";

/** How the reconnecting client of spec 14d.1 sends its SyncStep1. */
type Step1Timing = "with-auth" | "after-authenticated";

/**
 * Spec 14d.1's common precondition: CV in warning; B synced once, dropped and
 * wrote `b1` offline; A then filled CV past the limit (under the ceiling even
 * with `b1`) and acknowledged full.
 * @returns The fixture, B's member fixture, A's client and B's offline copy.
 */
async function reconnectAfterFull(): Promise<{ fixture: ActivityCollabFixture; bFixture: ActivityCollabFixture; a: SizeDocClient; bDoc: Y.Doc; name: string }> {
  const fixture = await seedCollabActivity();
  const name = canvasOf(fixture);
  const bytes = await seedFilled(name, 250_000);
  expect(bytes).toBeGreaterThanOrEqual(S.W);
  expect(bytes).toBeLessThan(S.L);
  const a = await syncedOn(fixture, name);
  const bFixture = await member(fixture, "editor");
  const b = await syncedOn(bFixture, name);
  await waitFor(() => b.socket.acks.some((ack) => ack.key === name), "B acknowledged the warning push", 10_000);
  expect(b.sizePushes().at(-1)?.phase).toBe("warning");
  b.socket.close();
  await waitFor(() => active.hocuspocus.documents.get(name)?.getConnectionsCount() === 1, "B's connection is gone", 10_000);
  const bDoc = b.doc;
  addNode(bDoc, "b1", "offline-b1");

  const fromA = a.sizePushes().length;
  a.edit((d) => addNode(d, "big", "y".repeat(20_000)));
  expect(await settle(a)).toEqual([]);
  expect(cur(name)).toBeGreaterThanOrEqual(S.L);
  const offline = Y.encodeStateAsUpdate(bDoc, Y.encodeStateVector(serverDoc(name)));
  expect(cur(name) + offline.byteLength).toBeLessThan(S.CEIL);
  await pushWhere(a, (p) => p.phase === "full", "A's full push", fromA);
  await untilKnowsFull(active, size, name, fixture.userId);
  return { fixture, bFixture, a, bDoc, name };
}

/**
 * B's new socket, driven frame by frame: Auth and SyncStep1 (together or after
 * `authenticated`), the server's SyncStep1 answered with a SyncStep2 carrying
 * `b1`, the server's SyncStep2 applied, and the connection's push acknowledged
 * at once, or (spec 14e.1, as web does) with the server's SyncStep2 as the
 * line: a push before it is held and only the latest acknowledged once it is
 * applied, a push after it is acknowledged in its own callback.
 * @param bFixture - B's session.
 * @param name - Document name.
 * @param bDoc - B's offline copy.
 * @param ackOrder - When the push is acknowledged.
 * @param timing - When SyncStep1 is sent.
 * @returns The socket; its frames are kept in arrival order.
 */
async function reconnectB(bFixture: ActivityCollabFixture, name: string, bDoc: Y.Doc, ackOrder: AckOrder, timing: Step1Timing): Promise<SizeSocket> {
  const socket = await socketOf(bFixture, { autoAck: false });
  let latest: unknown;
  let answered = false;
  let synced = false;
  /**
   * Sends `doc:size-seen` for a push and records it in `socket.acks`.
   * @param seq - The push's `seq`.
   */
  const ack = (seq: unknown): void => {
    socket.acks.push({ key: name, seq });
    socket.send(statelessFrame(name, JSON.stringify({ type: "doc:size-seen", seq })));
  };
  socket.ws.on("message", () => {
    const f = socket.frames.at(-1);
    if (!f || f.documentName !== name) return;
    if (f.stateless !== undefined) {
      const m = JSON.parse(f.stateless) as Record<string, unknown>;
      if (m.type !== "doc:size") return;
      if (ackOrder === "at-once" || synced) ack(m.seq);
      else latest = m.seq;
      return;
    }
    if (f.type !== WIRE.sync || !f.payload) return;
    if (f.syncSubType === SYNC.step1) {
      if (answered) return;
      answered = true;
      socket.send(syncFrame(name, WIRE.sync, SYNC.step2, Y.encodeStateAsUpdate(bDoc, f.payload)));
      return;
    }
    Y.applyUpdate(bDoc, f.payload, "server");
    if (f.syncSubType === SYNC.step2 && ackOrder === "after-synced" && !synced) {
      synced = true;
      if (latest !== undefined) ack(latest);
      latest = undefined;
    }
  });
  socket.send(authFrame(name, "__cookie_auth__"));
  if (timing === "after-authenticated") {
    await waitFor(() => socket.frames.some((f) => f.documentName === name && f.type === WIRE.auth && f.authSubType === 2), "B authenticated", 10_000);
  }
  socket.send(syncFrame(name, WIRE.sync, SYNC.step1, Y.encodeStateVector(bDoc)));
  return socket;
}

/**
 * Asserts the order spec 14e.1 gives R9-01: the server's SyncStep1 before its
 * SyncStep2, the only order the web acknowledgement depends on.
 * @param socket - B's new socket.
 * @param name - Document name.
 */
function expectServerStepsInOrder(socket: SizeSocket, name: string): void {
  const frames = socket.frames.filter((f) => f.documentName === name);
  const step1At = frames.findIndex((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step1);
  const step2At = frames.findIndex((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step2);
  expect(step1At).toBeGreaterThanOrEqual(0);
  expect(step2At).toBeGreaterThan(step1At);
}

/**
 * Asserts that B received a full push under the ceiling, whenever it arrived,
 * and acknowledged it (spec 14e.1).
 * @param socket - B's new socket.
 * @param name - Document name.
 */
function expectFullPushAcknowledged(socket: SizeSocket, name: string): void {
  const pushes = socket.frames
    .filter((f) => f.documentName === name && f.stateless !== undefined)
    .map((f) => JSON.parse(f.stateless!) as { type?: unknown; seq?: unknown; phase?: unknown; bytes?: number })
    .filter((m) => m.type === "doc:size" && m.phase === "full" && (m.bytes ?? 0) >= S.L && (m.bytes ?? 0) < S.CEIL);
  expect(pushes.length).toBeGreaterThan(0);
  const acked = socket.acks.filter((a) => a.key === name).map((a) => a.seq);
  expect(pushes.some((p) => acked.includes(p.seq))).toBe(true);
}

/**
 * Asserts the whole order R9-02's control rests on (spec 14e.1): the
 * connection's full push, then the server's SyncStep1, then the server's
 * SyncStep2. The push before SyncStep1 is what lets the immediate
 * acknowledgement of the web before round 9 reach collab ahead of B's
 * SyncStep2; it is not something the web fix depends on.
 * @param socket - B's new socket.
 * @param name - Document name.
 */
function expectPushBeforeServerSteps(socket: SizeSocket, name: string): void {
  const frames = socket.frames.filter((f) => f.documentName === name);
  const pushAt = frames.findIndex((f) => f.stateless !== undefined && (JSON.parse(f.stateless) as { type?: unknown }).type === "doc:size");
  const step1At = frames.findIndex((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step1);
  const step2At = frames.findIndex((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step2);
  expect(pushAt).toBeGreaterThanOrEqual(0);
  const push = JSON.parse(frames[pushAt]!.stateless!) as { phase?: unknown; bytes?: number };
  expect(push.phase).toBe("full");
  expect(push.bytes).toBeGreaterThanOrEqual(S.L);
  expect(push.bytes).toBeLessThan(S.CEIL);
  expect(step1At).toBeGreaterThan(pushAt);
  expect(step2At).toBeGreaterThan(step1At);
}

describe("round 9: a reconnect handshake's SyncStep2 is judged by the phase acknowledged before it (spec 14d.1)", () => {
  const timings: Step1Timing[] = ["with-auth", "after-authenticated"];

  it.each(timings)("R9-01 (%s) acknowledging after the server SyncStep2: B's offline SyncStep2 is admitted, its next add refused as full", async (timing) => {
    const { fixture, bFixture, a, bDoc, name } = await reconnectAfterFull();
    const before = refusals(name).length;
    const socket = await reconnectB(bFixture, name, bDoc, "after-synced", timing);
    await waitFor(() => socket.frames.some((f) => f.documentName === name && f.type === WIRE.syncStatus && f.applied === true)
      || socket.frames.some((f) => f.documentName === name && f.type === WIRE.close), "B's SyncStep2 is answered", 10_000);
    expectServerStepsInOrder(socket, name);
    expect(socket.frames.filter((f) => f.documentName === name && f.type === WIRE.close)).toEqual([]);
    expect(socket.frames.some((f) => f.documentName === name && f.type === WIRE.syncStatus && f.applied === true)).toBe(true);
    expect(refusals(name).length).toBe(before);
    expect(nodesOf(serverDoc(name)).has("b1")).toBe(true);
    await a.confirm();
    expect(nodesOf(a.doc).has("b1")).toBe(true);
    const stored = await persisted(active, name);
    expect(nodesOf(stored).has("b1")).toBe(true);
    expect(nodesOf(stored).has("big")).toBe(true);

    // A push that arrives after the server's SyncStep2 is acknowledged at once, so this wait is bounded either way.
    await untilKnowsFull(active, size, name, bFixture.userId);
    expectFullPushAcknowledged(socket, name);
    socket.send(syncFrame(name, WIRE.sync, SYNC.update, localUpdate(bDoc, (d) => addNode(d, "b2", "b"))));
    await waitFor(() => socket.frames.some((f) => f.documentName === name && f.type === WIRE.close), "B's b2 is refused", 10_000);
    expect(socket.frames.filter((f) => f.documentName === name && f.type === WIRE.close).map((f) => f.closeReason)).toEqual([COLLAB_DOCUMENT_TOO_LARGE_REASON]);
    await barrier(socket, documentOf(fixture));
    expect(socket.closedByServer()).toBe(false);
    const lines = refusals(name).slice(before);
    expect(lines.map((r) => r.step)).toEqual(["full"]);
    expect(lines[0]!.current as number).toBeLessThan(S.CEIL);
    expect(nodesOf(serverDoc(name)).has("b2")).toBe(false);
    await a.confirm();
    expect(nodesOf(a.doc).has("b2")).toBe(false);
    expect(nodesOf(await persisted(active, name)).has("b2")).toBe(false);
  });

  it.each(timings)("R9-02 (%s) control, acknowledging at once: the acknowledgement reaches collab first and B's offline SyncStep2 is refused as full", async (timing) => {
    const { bFixture, a, bDoc, name } = await reconnectAfterFull();
    const before = refusals(name).length;
    const socket = await reconnectB(bFixture, name, bDoc, "at-once", timing);
    await waitFor(() => socket.frames.some((f) => f.documentName === name && f.type === WIRE.close), "B's SyncStep2 is refused", 10_000);
    expectPushBeforeServerSteps(socket, name);
    expect(socket.frames.filter((f) => f.documentName === name && f.type === WIRE.close).map((f) => f.closeReason)).toEqual([COLLAB_DOCUMENT_TOO_LARGE_REASON]);
    expect(socket.frames.some((f) => f.documentName === name && f.type === WIRE.syncStatus && f.applied === true)).toBe(false);
    const lines = refusals(name).slice(before);
    expect(lines.map((r) => r.step)).toEqual(["full"]);
    expect(lines[0]!.current as number).toBeGreaterThanOrEqual(S.L);
    expect(lines[0]!.current as number).toBeLessThan(S.CEIL);
    expect(nodesOf(serverDoc(name)).has("b1")).toBe(false);
    await a.confirm();
    expect(nodesOf(a.doc).has("b1")).toBe(false);
    expect(nodesOf(await persisted(active, name)).has("b1")).toBe(false);
  });
});
