// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Pending content on a real collab instance (inner#1790, second version,
 * v2 collab test spec section 13: I-09, I-10, I-11, I-14, I-15, S
 * configuration): a connection's update that leaves the server new pending
 * structs or a longer pending delete set is refused after it was applied
 * (design 4.2 step 2a, 4.3), the part that integrated stays, the messages the
 * client queued behind it are refused at step 0, and honest members of a
 * document that already holds pending content are never refused.
 *
 * Production `createCollabServer` on loopback, real yjs Postgres and Redis,
 * raw WebSocket clients (`helpers/document-size-live.ts`); the forged client
 * C sends hand-built frames on the same client. `createLogger` is wrapped,
 * not replaced, to read the refusal lines.
 */

import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { S, capture, enc, legacyDoc, pendingStructs } from "./helpers/document-size-fixtures.js";
import {
  V2_PUSH_KEYS,
  canvasOf,
  documentOf,
  member,
  openDoc,
  openSocket,
  persisted,
  pushKeys,
  pushWhere,
  refusalsOf,
  refusedFor,
  seed,
  settle,
  startInstance,
  stopInstance,
} from "./helpers/document-size-live.js";
import type { Instance, SizeAckOptions, SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC, WIRE, authFrame, waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: { logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }> },
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
 * A new socket carrying a fixture's session, closed after the file.
 * @param fixture - Whose session.
 * @param opts - How it acknowledges size pushes (the current web client by default).
 * @returns The socket.
 */
async function socketFor(fixture: ActivityCollabFixture, opts: SizeAckOptions = {}): Promise<SizeSocket> {
  const socket = await openSocket(active.server.address.port, fixture.cookie, opts);
  sockets.push(socket);
  return socket;
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
  const client = await openDoc(await socketFor(fixture, opts), name, { doc });
  await client.sync();
  return client;
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
 * The lengths of a document's pending content.
 * @param doc - The document.
 * @returns Pending structs and pending delete set lengths, null when absent.
 */
function pendingLengths(doc: Y.Doc): { structs: number | null; ds: number | null } {
  return { structs: doc.store.pendingStructs?.update.byteLength ?? null, ds: doc.store.pendingDs?.byteLength ?? null };
}

/**
 * Wait until every frame a socket sent before now has reached the server:
 * open another document on it and wait for its Auth answer.
 * @param socket - The socket.
 * @param other - A document of the same Project not otherwise used on it.
 */
async function barrier(socket: SizeSocket, other: string): Promise<void> {
  const since = socket.frames.length;
  socket.send(authFrame(other, "__cookie_auth__"));
  await waitFor(() => socket.frames.slice(since).some((f) => f.documentName === other && f.type === WIRE.auth), `barrier on ${other}`, 10_000);
}

/**
 * A small stored canvas with no pending content: `getText("body")` holds "hello world".
 * @param name - Document name.
 */
async function seedPlain(name: string): Promise<void> {
  const src = new Y.Doc();
  src.getText("body").insert(0, "hello world");
  await seed(name, src);
}

beforeAll(async () => {
  active = await startInstance(createCollabServer, inject("REDIS_COLLAB_URL"));
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (active) await stopInstance(active);
});

describe("a mixed update and the messages queued behind it", () => {
  let fixture: ActivityCollabFixture;
  let name: string;
  let bFixture: ActivityCollabFixture;
  let b: SizeDocClient;

  it("I-09 the integrable part stays, the pending part is dropped and the queued updates never apply", async () => {
    fixture = await seedCollabActivity();
    name = canvasOf(fixture);
    await seedPlain(name);
    bFixture = await member(fixture, "editor");
    b = await syncedOn(bFixture, name);
    const c = await syncedOn(fixture, name);

    const writer = new Y.Doc();
    writer.clientID = 900;
    const integrated = capture(writer, () => writer.getText("body").insert(0, "INTEGRATED"));
    const queued2 = capture(writer, () => writer.getText("body").insert(0, "QUEUED2 "));
    const queued3 = capture(writer, () => writer.getText("body").insert(0, "QUEUED3 "));
    const mixed = Y.mergeUpdates([integrated, pendingStructs(777, 2000)]);
    c.sendSync(SYNC.update, mixed);
    c.sendSync(SYNC.update, queued2);
    c.sendSync(SYNC.update, queued3);
    await refusedFor(c);
    await barrier(c.socket, documentOf(fixture));

    const server = serverDoc(name);
    expect(server.getText("body").toString()).toContain("INTEGRATED");
    expect(server.getText("body").toString()).not.toContain("QUEUED");
    expect(server.store.pendingStructs).toBeNull();
    expect(server.store.pendingDs).toBeNull();
    await b.confirm();
    expect(b.doc.getText("body").toString()).toContain("INTEGRATED");
    expect(b.doc.getText("body").toString()).not.toContain("QUEUED");
    const stored = await persisted(active, name);
    expect(stored.getText("body").toString()).toContain("INTEGRATED");
    expect(stored.getText("body").toString()).not.toContain("QUEUED");
    expect(stored.store.pendingStructs).toBeNull();

    const lines = refusals(name);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]).toEqual({ documentName: name, userId: fixture.userId, current: expect.any(Number), limit: S.L, ceiling: S.CEIL, step: "pending", pendingBefore: expect.anything(), pendingAfter: expect.anything() });
    for (const line of lines.slice(1)) expect(line.step).toBe("after_refusal");
  });

  it("I-10 B reconnecting afterwards gets a SyncStep2 without client 777's structs", async () => {
    b.socket.close();
    const back = await openDoc(await socketFor(bFixture), name, { doc: b.doc });
    await back.sync();
    const step2 = back.frames().filter((f) => (f.type === WIRE.sync || f.type === WIRE.syncReply) && f.syncSubType === SYNC.step2 && f.payload);
    expect(step2.length).toBeGreaterThan(0);
    for (const f of step2) {
      expect(Y.decodeUpdate(f.payload!).structs.filter((s) => s.id.client === 777)).toEqual([]);
    }
    expect(back.doc.store.pendingStructs).toBeNull();
    expect(back.doc.getText("body").toString()).toContain("INTEGRATED");
    const push = await pushWhere(back, () => true, "connected push");
    expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
  });
});

describe("a mixed update from a client without size_ack", () => {
  it("I-09 without size_ack the server closes the whole WebSocket after the 2a refusal and the queued updates never apply", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedPlain(name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const c = await syncedOn(fixture, name, undefined, { sizeAck: false });

    const writer = new Y.Doc();
    writer.clientID = 900;
    const integrated = capture(writer, () => writer.getText("body").insert(0, "INTEGRATED"));
    const queued2 = capture(writer, () => writer.getText("body").insert(0, "QUEUED2 "));
    const queued3 = capture(writer, () => writer.getText("body").insert(0, "QUEUED3 "));
    c.sendSync(SYNC.update, Y.mergeUpdates([integrated, pendingStructs(777, 2000)]));
    c.sendSync(SYNC.update, queued2);
    c.sendSync(SYNC.update, queued3);
    await refusedFor(c);
    await waitFor(() => c.socket.closedByServer(), "the server closes C's WebSocket", 10_000);

    const server = serverDoc(name);
    expect(server.getText("body").toString()).toContain("INTEGRATED");
    expect(server.getText("body").toString()).not.toContain("QUEUED");
    expect(server.store.pendingStructs).toBeNull();
    await b.confirm();
    expect(b.doc.getText("body").toString()).not.toContain("QUEUED");
    expect(refusals(name)[0]).toMatchObject({ step: "pending" });
  });
});

describe("documents that already hold pending content", () => {
  it("I-11 honest members typing, deleting, going offline and reconnecting together are never refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, legacyDoc());
    const expected = { structs: 2024, ds: 22 };

    const a = await syncedOn(fixture, name);
    expect(pendingLengths(serverDoc(name))).toEqual(expected);
    a.edit((d) => d.getText("body").insert(0, "A1 "));
    expect(await settle(a)).toEqual([]);
    a.edit((d) => d.getText("body").delete(0, 1));
    expect(await settle(a)).toEqual([]);
    expect(pendingLengths(serverDoc(name))).toEqual(expected);

    a.socket.close();
    a.doc.getText("body").insert(0, "AOFF ");
    const a2 = await syncedOn(fixture, name, a.doc);
    expect(await settle(a2)).toEqual([]);
    expect(pendingLengths(serverDoc(name))).toEqual(expected);

    const bFixture = await member(fixture, "editor");
    const b = await syncedOn(bFixture, name);
    b.edit((d) => d.getText("body").insert(0, "B1 "));
    expect(await settle(b)).toEqual([]);
    expect(pendingLengths(serverDoc(name))).toEqual(expected);

    a2.socket.close();
    b.socket.close();
    const [a3, b2] = await Promise.all([syncedOn(fixture, name, a2.doc), syncedOn(bFixture, name, b.doc)]);
    expect(await settle(a3)).toEqual([]);
    expect(await settle(b2)).toEqual([]);
    expect(pendingLengths(serverDoc(name))).toEqual(expected);
    const body = serverDoc(name).getText("body").toString();
    expect(body).toContain("AOFF ");
    expect(body).toContain("B1 ");
    expect(refusals(name)).toEqual([]);
    for (const client of [a3, b2]) {
      const push = await pushWhere(client, () => true, "connected push");
      expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
    }
  });
});

describe("a forged client sending content that pends", () => {
  it.each([
    ["with size_ack", true],
    ["without size_ack", false],
  ])("I-14 %s pending structs on a fresh document are refused and leave no pending content, stored or loaded", async (_label, sizeAck) => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedPlain(name);
    const c = await syncedOn(fixture, name, undefined, { sizeAck });
    c.sendSync(SYNC.update, pendingStructs(333, 2000));
    await refusedFor(c);
    if (sizeAck) expect(c.socket.closedByServer()).toBe(false);
    else await waitFor(() => c.socket.closedByServer(), "the server closes C's WebSocket", 10_000);

    const server = serverDoc(name);
    expect(server.store.pendingStructs).toBeNull();
    expect(server.store.pendingDs).toBeNull();
    const stored = await persisted(active, name);
    expect(stored.store.pendingStructs).toBeNull();
    expect(stored.store.pendingDs).toBeNull();
    expect(refusals(name)).toEqual([
      { documentName: name, userId: fixture.userId, current: expect.any(Number), limit: S.L, ceiling: S.CEIL, step: "pending", pendingBefore: expect.anything(), pendingAfter: expect.anything() },
    ]);
  });

  it("I-15 thirty rounds of new pending structs on a legacy document are each refused and the document does not grow", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, legacyDoc());
    // Keeps the document loaded for the whole run.
    await syncedOn(await member(fixture, "editor"), name);
    const start = enc(serverDoc(name));
    const socket = await socketFor(fixture);

    for (let i = 0; i < 30; i++) {
      const c = await openDoc(socket, name, { answerServerStep1: false });
      c.sendSync(SYNC.step1, Y.encodeStateVector(new Y.Doc()));
      c.sendSync(SYNC.step2, Y.encodeStateAsUpdate(new Y.Doc()));
      c.sendSync(SYNC.update, pendingStructs(10_000 + i, 4000));
      await refusedFor(c);
    }
    expect(socket.closedByServer()).toBe(false);
    expect(enc(serverDoc(name))).toBe(start);
    expect(refusals(name)).toEqual(Array(30).fill(
      { documentName: name, userId: fixture.userId, current: expect.any(Number), limit: S.L, ceiling: S.CEIL, step: "pending", pendingBefore: expect.anything(), pendingAfter: expect.anything() },
    ));
  });

  it("I-15 without size_ack thirty rounds, each on a new socket the server closes after the refusal, leave the document as it was", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, legacyDoc());
    await syncedOn(await member(fixture, "editor"), name);
    const start = enc(serverDoc(name));

    for (let i = 0; i < 30; i++) {
      const socket = await socketFor(fixture, { sizeAck: false });
      const c = await openDoc(socket, name, { answerServerStep1: false });
      c.sendSync(SYNC.step1, Y.encodeStateVector(new Y.Doc()));
      c.sendSync(SYNC.step2, Y.encodeStateAsUpdate(new Y.Doc()));
      c.sendSync(SYNC.update, pendingStructs(20_000 + i, 4000));
      await refusedFor(c);
      await waitFor(() => socket.closedByServer(), `the server closes round ${i}'s WebSocket`, 10_000);
    }
    expect(enc(serverDoc(name))).toBe(start);
    expect(refusals(name).map((r) => r.step)).toEqual(Array(30).fill("pending"));
  });
});
