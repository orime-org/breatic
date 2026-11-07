// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap, second version, on a real collab instance
 * (inner#1790, v2 collab test spec section 13: I-01 to I-08, I-13, I-16,
 * I-17, S configuration): production `createCollabServer` listening on
 * loopback, real yjs Postgres, real Redis, the production auth with real
 * session cookies, and raw WebSocket clients speaking the provider's frames
 * (`helpers/document-size-live.ts`).
 *
 * Two things are wrapped, never replaced: the `Server` constructor records
 * each `onChange` call with the size record read just before and just after
 * the production hook ran its synchronous part (so I-13 sees what that one
 * call counted, whatever a measurement does later), and `createLogger`
 * records `warn` and `error` lines while still writing them. The S
 * configuration reaches production through `getCollabConfig`.
 *
 * Each case seeds its own Project and the state the spec's chain leads to
 * (I-02 to I-04 start from a stored `full` document instead of running the
 * case before them), so one failure does not decide the next.
 */

import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { createCollabServer } from "@collab/hocuspocus.js";
import * as size from "@collab/services/document-size.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { S, enc, fill, mass } from "./helpers/document-size-fixtures.js";
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
import type { Instance, SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
    changes: [] as Array<{ documentName: string; update: Uint8Array; source: unknown; before?: number; after?: number }>,
    current: undefined as ((name: string) => number | undefined) | undefined,
  },
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0];
  type ChangePayload = { documentName: string; update: Uint8Array; transactionOrigin?: { source?: unknown } | null };
  /**
   * Record every `onChange` call with the record around its synchronous part.
   * @param config - What production passed.
   * @returns The configuration the real server gets.
   */
  const wrap = (config: Config): Config => {
    const cfg = (config ?? {}) as Record<string, unknown>;
    const original = cfg.onChange as ((payload: ChangePayload) => Promise<void>) | undefined;
    return {
      ...cfg,
      onChange: (payload: ChangePayload): Promise<void> => {
        const before = state.current?.(payload.documentName);
        const running = original?.(payload) ?? Promise.resolve();
        const after = state.current?.(payload.documentName);
        state.changes.push({ documentName: payload.documentName, update: payload.update, source: payload.transactionOrigin?.source, before, after });
        return running;
      },
    } as Config;
  };
  class Server extends real.Server {
    constructor(config: Config) {
      super(wrap(config));
    }
  }
  return { ...real, Server };
});

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
 * Open and synchronize a document on a new socket.
 * @param fixture - Whose session.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @param mode - The authorization expected.
 * @returns The synced client.
 */
async function syncedOn(fixture: ActivityCollabFixture, name: string, doc?: Y.Doc, mode: "read-write" | "readonly" = "read-write"): Promise<SizeDocClient> {
  const socket = await openSocket(active.server.address.port, fixture.cookie);
  sockets.push(socket);
  const client = await openDoc(socket, name, { doc, mode });
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
 * The fill nodes of a client copy.
 * @param doc - The client copy.
 * @returns `nodes`.
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
 * Every push a client received has exactly the v2 keys.
 * @param client - The client.
 */
function expectV2Pushes(client: SizeDocClient): void {
  expect(client.sizePushes().length).toBeGreaterThan(0);
  for (const push of client.sizePushes()) expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
}

/**
 * A stored canvas grown with `fill` to about `target` bytes, with a
 * `position` node `p1` and a small node `small` written before the fill.
 * @param name - Document name.
 * @param target - Size aimed for.
 * @returns The measured stored size.
 */
async function seedFilled(name: string, target: number): Promise<number> {
  const src = new Y.Doc();
  const p1 = new Y.Map<unknown>();
  nodesOf(src).set("p1", p1);
  p1.set("position", { x: 0, y: 0 });
  addNode(src, "small", "s");
  const bytes = fill(src, target);
  await seed(name, src);
  return bytes;
}

beforeAll(async () => {
  active = await startInstance(createCollabServer, inject("REDIS_COLLAB_URL"));
  state.current = (name: string): number | undefined => size.readDocSizeRecord(name)?.current;
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (active) await stopInstance(active);
});

describe("below the limit and at full", () => {
  it("I-01 a large add from warning crosses the limit and is admitted; A and B are told full", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 250_000);
    expect(bytes).toBeGreaterThanOrEqual(S.W);
    expect(bytes).toBeLessThan(S.L);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    await pushWhere(a, () => true, "connected push");
    await pushWhere(b, () => true, "connected push");

    a.edit((d) => addNode(d, "big", "y".repeat(30_000)));
    expect(await settle(a)).toEqual([]);
    await pushWhere(a, (p) => p.phase === "full", "full push");
    await pushWhere(b, (p) => p.phase === "full", "full push");
    expect(nodesOf(serverDoc(name)).has("big")).toBe(true);
    await b.confirm();
    expect(nodesOf(b.doc).has("big")).toBe(true);
    expect(nodesOf(await persisted(active, name)).has("big")).toBe(true);
    expect(refusals(name)).toEqual([]);
    expectV2Pushes(a);
    expectV2Pushes(b);
  });

  it("I-02 at full the next add is refused with the size reason, reaches nobody and is not stored", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 280_000);
    expect(bytes).toBeGreaterThanOrEqual(S.L);
    expect(bytes).toBeLessThan(S.CEIL);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);

    a.edit((d) => addNode(d, "n-abc", "abc"));
    await refusedFor(a);
    expect(nodesOf(serverDoc(name)).has("n-abc")).toBe(false);
    await b.confirm();
    expect(nodesOf(b.doc).has("n-abc")).toBe(false);
    expect(nodesOf(await persisted(active, name)).has("n-abc")).toBe(false);
    expect(refusals(name)).toEqual([
      { documentName: name, userId: fixture.userId, current: expect.any(Number), limit: S.L, ceiling: S.CEIL, step: "full" },
    ]);
  });

  it("I-03 at full a whole-node delete is admitted and a position change is refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const bytes = await seedFilled(name, 280_000);
    expect(bytes).toBeGreaterThanOrEqual(S.L);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);

    a.edit((d) => nodesOf(d).delete("f1"));
    expect(await settle(a)).toEqual([]);
    await b.confirm();
    expect(nodesOf(serverDoc(name)).has("f1")).toBe(false);
    expect(nodesOf(b.doc).has("f1")).toBe(false);

    a.edit((d) => nodesOf(d).get("p1")!.set("position", { x: 5, y: 5 }));
    await refusedFor(a);
    await b.confirm();
    expect(nodesOf(serverDoc(name)).get("p1")!.get("position")).toEqual({ x: 0, y: 0 });
    expect(nodesOf(b.doc).get("p1")!.get("position")).toEqual({ x: 0, y: 0 });
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
  });

  it("I-04 deleting back under the limit at full brings a warning or normal push to A and B within 2 s", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedFilled(name, 280_000);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);
    await pushWhere(a, (p) => p.phase === "full", "connected full push");
    await pushWhere(b, (p) => p.phase === "full", "connected full push");
    const fromA = a.sizePushes().length;
    const fromB = b.sizePushes().length;

    a.edit((d) => {
      for (const key of ["f0", "f1", "f2", "f3"]) nodesOf(d).delete(key);
    });
    expect(await settle(a)).toEqual([]);
    expect(enc(serverDoc(name))).toBeLessThan(S.L);
    const below = (p: Record<string, unknown>): boolean => p.phase === "warning" || p.phase === "normal";
    await Promise.all([pushWhere(a, below, "push below full", fromA), pushWhere(b, below, "push below full", fromB)]);
    expect(refusals(name)).toEqual([]);
    expectV2Pushes(a);
    expectV2Pushes(b);
  });

  it("I-05 deleting all 500 nodes of mass(500) at warning never pushes full and falls to normal within 2 s", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const { server: src } = mass(500);
    expect(enc(src)).toBeGreaterThanOrEqual(S.W);
    expect(enc(src)).toBeLessThan(S.L);
    await seed(name, src);
    const a = await syncedOn(fixture, name);
    await pushWhere(a, (p) => p.phase === "warning", "connected warning push");
    const from = a.sizePushes().length;

    a.edit((d) => {
      for (const key of [...nodesOf(d).keys()]) nodesOf(d).delete(key);
    });
    expect(await settle(a)).toEqual([]);
    expect(nodesOf(serverDoc(name)).size).toBe(0);
    await pushWhere(a, (p) => p.phase === "normal", "normal push", from);
    expect(a.sizePushes().slice(from).map((p) => p.phase)).not.toContain("full");
    expect(refusals(name)).toEqual([]);
    expectV2Pushes(a);
  });
});

describe("over the hard ceiling and documents already over the line", () => {
  it("I-06 over the ceiling a whole-node delete is admitted and deleting one character is refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    text.insert(0, "hello world");
    paragraph.insert(0, [text]);
    src.getXmlFragment("body").insert(0, [paragraph]);
    addNode(src, "small", "s");
    expect(fill(src, 300_000)).toBeGreaterThanOrEqual(S.CEIL);
    await seed(name, src);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(await member(fixture, "editor"), name);

    a.edit((d) => nodesOf(d).delete("small"));
    expect(await settle(a)).toEqual([]);
    await b.confirm();
    expect(nodesOf(serverDoc(name)).has("small")).toBe(false);
    expect(nodesOf(b.doc).has("small")).toBe(false);

    a.edit((d) => ((d.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(2, 1));
    await refusedFor(a);
    await b.confirm();
    const textOf = (d: Y.Doc): string => ((d.getXmlFragment("body").get(0) as Y.XmlElement).get(0) as Y.XmlText).toString();
    expect(textOf(serverDoc(name))).toBe("hello world");
    expect(textOf(b.doc)).toBe("hello world");
    expect(refusals(name)).toEqual([
      { documentName: name, userId: fixture.userId, current: expect.any(Number), limit: S.L, ceiling: S.CEIL, step: "over_ceiling" },
    ]);
  });

  it("I-07 stored documents at full and over the ceiling open, finish the handshake, are told so, and take a delete", async () => {
    const fixture = await seedCollabActivity();
    const cv = canvasOf(fixture);
    const doc = documentOf(fixture);
    const cvBytes = await seedFilled(cv, 270_000);
    const docBytes = await seedFilled(doc, 300_000);
    expect(cvBytes).toBeGreaterThanOrEqual(S.L);
    expect(cvBytes).toBeLessThan(S.CEIL);
    expect(docBytes).toBeGreaterThanOrEqual(S.CEIL);
    const socket = await openSocket(active.server.address.port, fixture.cookie);
    sockets.push(socket);
    const onCv = await openDoc(socket, cv);
    await onCv.sync();
    const onDoc = await openDoc(socket, doc);
    await onDoc.sync();

    const cvPush = await pushWhere(onCv, () => true, "connected push");
    const docPush = await pushWhere(onDoc, () => true, "connected push");
    expect(cvPush.phase).toBe("full");
    expect(cvPush.bytes as number).toBeLessThan(S.CEIL);
    expect(docPush.phase).toBe("full");
    expect(docPush.bytes as number).toBeGreaterThanOrEqual(S.CEIL);
    expect(pushKeys(cvPush)).toEqual(V2_PUSH_KEYS);
    expect(pushKeys(docPush)).toEqual(V2_PUSH_KEYS);

    for (const client of [onCv, onDoc]) {
      client.edit((d) => nodesOf(d).delete("f1"));
      expect(await settle(client)).toEqual([]);
      expect(nodesOf(serverDoc(client.documentName)).has("f1")).toBe(false);
    }
    expect(refusals(cv)).toEqual([]);
    expect(refusals(doc)).toEqual([]);
  });

  it("I-08 three clients dropping and reconnecting at once on a full and an over-ceiling document are all let in", async () => {
    const fixture = await seedCollabActivity();
    const people = [fixture, await member(fixture, "editor"), await member(fixture, "editor")];
    const cv = canvasOf(fixture);
    const doc = documentOf(fixture);
    for (const [name, target] of [[cv, 270_000], [doc, 300_000]] as const) {
      // A node created and deleted before the fill: every reconnect handshake
      // then carries a delete set covering only already-deleted content.
      const src = new Y.Doc();
      addNode(src, "gone", "g".repeat(500));
      nodesOf(src).delete("gone");
      fill(src, target);
      await seed(name, src);
    }
    for (const name of [cv, doc]) {
      const first: SizeDocClient[] = [];
      for (const who of people) first.push(await syncedOn(who, name));
      for (const c of first) c.socket.close();
      const back = await Promise.all(first.map((c, i) => syncedOn(people[i]!, name, c.doc)));
      for (const c of back) {
        expect(await settle(c)).toEqual([]);
        await pushWhere(c, () => true, "reconnect push");
        expectV2Pushes(c);
      }
      expect(refusals(name)).toEqual([]);
    }
  });
});

describe("system writes, a rebuilt provider and viewers", () => {
  it("I-13 a system write through a direct connection at full is applied and counted by its length", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    const n0 = new Y.Map<unknown>();
    nodesOf(src).set("n0", n0);
    n0.set("data", new Y.Map<unknown>());
    fill(src, 280_000);
    await seed(name, src);
    await syncedOn(fixture, name);
    expect(size.readDocSizeRecord(name)?.phase).toBe("full");

    let written: Uint8Array | undefined;
    serverDoc(name).once("update", (u: Uint8Array) => {
      written = u;
    });
    const direct = await active.hocuspocus.openDirectConnection(name, { context: { user: { id: "system" }, source: "task-listener" } });
    await direct.transact((d) => {
      (nodesOf(d).get("n0")!.get("data") as Y.Map<unknown>).set("content", "r".repeat(20_480));
    });
    await direct.disconnect();
    expect(written).toBeDefined();
    await waitFor(() => state.changes.some((c) => c.update === written), "onChange saw the system write");
    const change = state.changes.find((c) => c.update === written)!;
    expect(change.source).not.toBe("connection");
    expect(change.after! - change.before!).toBe(written!.byteLength);
    expect(refusals(name)).toEqual([]);
    const stored = await persisted(active, name);
    expect((nodesOf(stored).get("n0")!.get("data") as Y.Map<unknown>).get("content")).toBe("r".repeat(20_480));
  });

  it("I-16 after a refusal the provider rebuilt on the same socket handshakes unrefused and deletes", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedFilled(name, 280_000);
    const socket = await openSocket(active.server.address.port, fixture.cookie);
    sockets.push(socket);
    const a = await openDoc(socket, name);
    await a.sync();
    a.edit((d) => addNode(d, "n-abc", "abc"));
    await refusedFor(a);

    const fresh = await openDoc(socket, name);
    await fresh.sync();
    expect(await settle(fresh)).toEqual([]);
    fresh.edit((d) => nodesOf(d).delete("f1"));
    expect(await settle(fresh)).toEqual([]);
    expect(nodesOf(serverDoc(name)).has("f1")).toBe(false);
    expect(refusals(name).map((r) => r.step)).toEqual(["full"]);
    const push = await pushWhere(fresh, () => true, "connected push");
    expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
    expect(push.phase).toBe("full");
  });

  it("I-17 a viewer's local write on an over-ceiling document is not applied and logs no refusal", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seedFilled(name, 300_000);
    const v = await syncedOn(await member(fixture, "viewer"), name, undefined, "readonly");
    const push = await pushWhere(v, () => true, "connected push");

    v.edit((d) => addNode(d, "viewer-node", "v"));
    expect((await v.confirm()).ok).toBe(false);
    expect(v.closeReasons()).toEqual([]);
    expect(nodesOf(serverDoc(name)).has("viewer-node")).toBe(false);
    expect(refusals(name)).toEqual([]);
    expect(pushKeys(push)).toEqual(V2_PUSH_KEYS);
    expect(push.phase).toBe("full");
    expect(push.bytes as number).toBeGreaterThanOrEqual(S.CEIL);
  });
});
