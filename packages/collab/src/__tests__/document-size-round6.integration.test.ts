// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The round 6 integration cases of the document size cap (inner#1790, v2
 * collab test spec section 14a: R6-10, R6-13, R6-23, configuration S) on a
 * real collab instance: production `createCollabServer` on loopback,
 * real yjs Postgres and Redis, the production auth with real session cookies,
 * and raw WebSocket clients speaking the provider's frames
 * (`helpers/document-size-live.ts`).
 *
 * Two things are wrapped, never replaced: `createLogger` records `warn` and
 * `error` lines while still writing them, and the account activity hook can
 * be held on an Update message until a case releases it (the spec's "the
 * activity write waits"), handing the case that message's connection.
 *
 * R6-22 (re-authenticate at once on the same socket while the old
 * connection's queue waits) is not here: the production `connected` hook
 * refuses that new connection as `duplicate-document-on-socket`, because the
 * old connection's `onDisconnect`, which forgets it, runs only after its
 * pending messages (Hocuspocus `createConnection` awaits
 * `waitForPendingMessages`).
 */

import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import type * as ActivityModuleShape from "@collab/hooks/account-activity.js";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";
import { isRefused } from "@collab/infra/inbound-filter.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { applyOfflineDeletes, bigNodeUpdate, enc, fill, offlineDeletes } from "./helpers/document-size-fixtures.js";
import {
  canvasOf,
  documentOf,
  member,
  openDoc,
  openSocket,
  persisted,
  pushWhere,
  refusalsOf,
  seed,
  settle,
  startInstance,
  stopInstance,
} from "./helpers/document-size-live.js";
import type { Instance, SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC, waitFor } from "./helpers/live-hocuspocus.js";

/** A connection as the activity hook sees it. */
interface HeldConnection {
  socketId: string;
}

const { state } = vi.hoisted(() => ({
  state: {
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
    // Set by a case: the next Update message's activity write waits on it.
    hold: undefined as undefined | Promise<void>,
    // The connection of the held Update message.
    held: undefined as undefined | HeldConnection,
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

// Spec R6-23: the activity write of an Update can be made to wait.
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
 * Open a socket for a fixture's session.
 * @param fixture - Whose session.
 * @returns The socket.
 */
async function socketOf(fixture: ActivityCollabFixture): Promise<SizeSocket> {
  const socket = await openSocket(active.server.address.port, fixture.cookie);
  sockets.push(socket);
  return socket;
}

/**
 * Open and synchronize a document on a new socket.
 * @param fixture - Whose session.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @returns The synced client.
 */
async function syncedOn(fixture: ActivityCollabFixture, name: string, doc?: Y.Doc): Promise<SizeDocClient> {
  const client = await openDoc(await socketOf(fixture), name, { doc });
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
 * `nodes` of a document.
 * @param doc - The document.
 * @returns The map.
 */
function nodesOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>("nodes");
}

/**
 * The text of every paragraph of a `document-store` fragment.
 * @param doc - The document.
 * @returns One string per paragraph.
 */
function paragraphs(doc: Y.Doc): string[] {
  return doc.getXmlFragment("document-store").toArray().map((p) => ((p as Y.XmlElement).get(0) as Y.XmlText).toString());
}

/**
 * Store `fill(·, 230 000)` (229 989 bytes, normal under S) as a canvas.
 * @param name - Document name.
 */
async function seedNormal(name: string): Promise<void> {
  const src = new Y.Doc();
  expect(fill(src, 230_000)).toBe(229_989);
  await seed(name, src);
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

describe("round 6 on a live instance", () => {
  it("R6-10 an Update sent with an unknown sync sub-type is admitted, never applied, and measured out within 5 s", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedNormal(name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    const c = await syncedOn(fixture, name);
    const big = bigNodeUpdate(c.doc);
    expect(big.byteLength).toBe(40_032);
    const from = b.sizePushes().length;

    c.sendSync(3, big);
    await pushWhere(b, (p) => p.phase === "full", "full push after the admit", from);
    await waitFor(() => {
      const last = b.sizePushes().at(-1);
      return last?.phase === "normal" && last.bytes === enc(serverDoc(name));
    }, "a normal push of the measured size", 5000);
    expect(nodesOf(serverDoc(name)).has("big")).toBe(false);
    expect(nodesOf(b.doc).has("big")).toBe(false);
    expect(refusals(name)).toEqual([]);
  });

  it("R6-13 a member reconnecting with 600 offline deletes (1200 split endpoints) below the limit is let in and the deletes reach everyone", async () => {
    const fixture = await seedCollabActivity();
    const name = documentOf(fixture);
    const od = offlineDeletes();
    expect(enc(od.author)).toBe(40_607);
    await seed(name, od.author);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);

    a.socket.close();
    applyOfflineDeletes(a.doc, 600);
    const back = await syncedOn(fixture, name, a.doc);
    expect(await settle(back)).toEqual([]);
    expect(refusals(name)).toEqual([]);
    await b.confirm();
    const expected = paragraphs(a.doc);
    expect(expected.reduce((n, p) => n + p.length, 0)).toBe(20 * 2000 - 600);
    expect(paragraphs(serverDoc(name))).toEqual(expected);
    expect(paragraphs(b.doc)).toEqual(expected);
    expect(paragraphs(await persisted(active, name))).toEqual(expected);
  });

  it("R6-23 messages still queued when the socket closes drain without leaving a refusal mark behind", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedNormal(name);
    const socket = await socketOf(fixture);
    const c = await openDoc(socket, name);
    await c.sync();

    const hold = deferred();
    state.hold = hold.promise;
    const u1 = localUpdate(c.doc, (d) => {
      const big = new Y.Map<unknown>();
      nodesOf(d).set("u1", big);
      big.set("name", "y".repeat(40_000));
    });
    const u2 = localUpdate(c.doc, (d) => {
      const small = new Y.Map<unknown>();
      nodesOf(d).set("c", small);
      small.set("name", "z");
    });
    c.sendSync(SYNC.update, u1);
    c.sendSync(SYNC.update, u2);
    await waitFor(() => state.held !== undefined, "U1's activity write is waiting", 10_000);
    const old = state.held as HeldConnection;
    socket.close();
    await waitFor(() => !(active.hocuspocus.documents.get(name)?.getConnections() ?? []).some((x) => x.socketId === old.socketId), "the closed socket's connection leaves the document", 10_000);
    hold.resolve();

    await waitFor(() => refusals(name).length > 0, "U2's refusal", 10_000);
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
    expect(nodesOf(serverDoc(name)).has("u1")).toBe(true);
    expect(isRefused(old.socketId, name)).toBe(false);
  });
});
