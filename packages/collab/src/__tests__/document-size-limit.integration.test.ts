// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The document size cap on a real collab instance (inner#1790, test spec 7
 * and 10.2 under the I configuration): production `createCollabServer`
 * listening on loopback, real Postgres, real Redis, the production auth with
 * a real session cookie, and raw WebSocket clients speaking the provider's
 * frames (`helpers/document-size-live.ts`).
 *
 * Two things are wrapped, never replaced: the `Server` constructor records
 * the configuration it was given (so a case can call a production hook
 * directly, or see in which order production `beforeSync` ran), and
 * `createLogger` records `warn` and `error` lines while still writing them.
 * The I configuration reaches production through `getCollabConfig`.
 *
 * Deviation from spec 10.2: the client is a raw WebSocket, not
 * `@hocuspocus/provider` (a web dependency collab does not declare); it sends
 * what the provider sends, and a refusal is read from the CLOSE frame's reason.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import { Document } from "@hocuspocus/server";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as CoreModuleShape from "@breatic/core";
import type * as ConfigModuleShape from "@collab/config.js";
import * as core from "@breatic/core";
import { COLLAB_DOCUMENT_TOO_LARGE_REASON, spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { storeDocumentNow } from "@collab/services/persistence.js";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";
import * as size from "@collab/services/document-size.js";

import { seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import {
  appendUpdate,
  buildNodes,
  fill,
  helloDoc,
  imageNodes,
  onChangeBound,
  pendingCounts,
  reload,
  storedPendingDsDoc,
  storedPendingStructsDoc,
} from "./helpers/document-size-fixtures.js";
import { openDoc, openSocket } from "./helpers/document-size-live.js";
import type { SizeDocClient, SizeSocket } from "./helpers/document-size-live.js";
import { SYNC, syncFrame, WIRE, waitFor } from "./helpers/live-hocuspocus.js";

const { state } = vi.hoisted(() => ({
  state: {
    // Spec 10.2 I configuration.
    config: {
      max_document_bytes: 262_144,
      document_size_warn_ratio: 0.8,
      document_size_full_margin_bytes: 6554,
      document_size_delete_headroom_bytes: 6554,
      document_size_overwrite_reserve_bytes: 1638,
      document_size_measure_interval_ms: 2000,
      document_size_trials_per_user_per_minute: 6,
      document_size_trial_budget_ms_per_second: 200,
    },
    configs: [] as Array<Record<string, unknown>>,
    beforeSyncCalls: [] as Array<{ documentName: string; socketId: string; type: number }>,
    delayStep2Ms: 0,
    logs: [] as Array<{ level: "warn" | "error"; args: unknown[] }>,
  },
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0];
  /**
   * Record the configuration and wrap `beforeSync` so its calls are seen.
   * @param config - What production passed.
   * @returns The configuration the real server gets.
   */
  const wrap = (config: Config): Config => {
    const cfg = (config ?? {}) as Record<string, unknown>;
    state.configs.push(cfg);
    const original = cfg.beforeSync as ((payload: unknown) => Promise<void>) | undefined;
    return {
      ...cfg,
      beforeSync: async (payload: { documentName: string; type: number; connection: { socketId: string } }): Promise<void> => {
        if (payload.type === SYNC.step2 && state.delayStep2Ms > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.delayStep2Ms));
        }
        state.beforeSyncCalls.push({ documentName: payload.documentName, socketId: payload.connection.socketId, type: payload.type });
        await original?.(payload);
      },
    };
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

vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModuleShape>();
  return { ...real, getCollabConfig: () => ({ ...real.getCollabConfig(), ...state.config }) };
});

const L_I = 262_144;
const CEIL_I = 268_698;
const FULL_AT_I = 255_590;

type Instance = Awaited<ReturnType<typeof createCollabServer>>;

/** The production hooks a direct call drives. */
interface Hooks {
  beforeSync: (payload: unknown) => Promise<void>;
  afterLoadDocument: (payload: unknown) => Promise<void>;
}

core.initCore(process.env);
core.loadLocales();
const redisFactory = vi.spyOn(core, "createRedisClient");
const sockets: SizeSocket[] = [];
let active: Instance;

/**
 * Start a production instance and listen on loopback.
 * @returns The instance.
 */
async function start(): Promise<Instance> {
  const instance = await createCollabServer({
    port: 0,
    collabRedisUrl: inject("REDIS_COLLAB_URL"),
    redisKeyPrefix: `document-size-${randomUUID()}`,
    shutdownDeadline: () => undefined,
  });
  await instance.server.listen();
  return instance;
}

/**
 * Stop an instance the way shutdown does (documents are stored on destroy).
 * @param instance - The instance.
 */
async function stop(instance: Instance): Promise<void> {
  instance.stopUpgradeSessions();
  instance.storeLoop.stop();
  await instance.seatHandover.stop();
  await instance.server.destroy();
}

/**
 * A socket to an instance carrying the fixture's session, closed after the case.
 * @param fixture - Whose session.
 * @param instance - Which instance.
 * @returns The socket.
 */
async function socketFor(fixture: ActivityCollabFixture, instance: Instance = active): Promise<SizeSocket> {
  const socket = await openSocket(instance.server.address.port, fixture.cookie);
  sockets.push(socket);
  return socket;
}

/**
 * Open and synchronize a document on a new socket.
 * @param fixture - Whose session.
 * @param name - Document name.
 * @param doc - The client copy to bring.
 * @param instance - Which instance.
 * @returns The synced client.
 */
async function syncedOn(fixture: ActivityCollabFixture, name: string, doc?: Y.Doc, instance: Instance = active): Promise<SizeDocClient> {
  const client = await openDoc(await socketFor(fixture, instance), name, { doc });
  await client.sync();
  return client;
}

/**
 * The canvas document of a fixture.
 * @param fixture - The fixture.
 * @returns Its name.
 */
function canvasOf(fixture: ActivityCollabFixture): string {
  return spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
}

/**
 * Store content as the document's row before anyone opens it.
 * @param name - Document name.
 * @param src - Content.
 */
async function seed(name: string, src: Y.Doc): Promise<void> {
  await yjsRepo.upsertDocData(name, Y.encodeStateAsUpdate(src));
}

/**
 * The persisted row, decoded.
 * @param instance - The instance holding the document.
 * @param name - Document name.
 * @returns A document built from the stored bytes.
 */
async function persisted(instance: Instance, name: string): Promise<Y.Doc> {
  await storeDocumentNow(instance.hocuspocus, name);
  const data = await yjsRepo.fetchDocData(name);
  if (!data) throw new Error(`no stored row for ${name}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, data);
  return doc;
}

/**
 * The real trial quota key in DB0 (`checkRateLimit` adds the env prefix).
 * @param name - Document name.
 * @param userId - User id.
 * @returns The key.
 */
function trialKey(name: string, userId: string): string {
  return `${core.env.ENV}:ratelimit:collab-doc-size-trial:${name}:${userId}`;
}

/**
 * How many trials the (document, user) pair has used in its window.
 * @param name - Document name.
 * @param userId - User id.
 * @returns The sorted set's size (0 when absent).
 */
async function trials(name: string, userId: string): Promise<number> {
  return core.getRedis().zcard(trialKey(name, userId));
}

/**
 * Refusal log lines for a document.
 * @param name - Document name.
 * @returns Their fields.
 */
function refusals(name: string): Array<Record<string, unknown>> {
  return state.logs
    .filter((l) => l.level === "warn" && l.args[1] === "document_size_limit_refused")
    .map((l) => l.args[0] as Record<string, unknown>)
    .filter((f) => f.documentName === name);
}

/**
 * Expect a client never to have been refused for size.
 * @param client - The client.
 */
function expectNotRefused(client: SizeDocClient): void {
  expect(client.closeReasons()).not.toContain(COLLAB_DOCUMENT_TOO_LARGE_REASON);
  expect(refusals(client.documentName)).toEqual([]);
}

/**
 * Wait for a client's document connection to be closed for size.
 * @param client - The client.
 */
async function refusedFor(client: SizeDocClient): Promise<void> {
  await waitFor(() => client.closeReasons().includes(COLLAB_DOCUMENT_TOO_LARGE_REASON), `size refusal of ${client.key}`, 30_000);
}

/**
 * Add a viewer of the fixture's Project, with a session of its own.
 * @param fixture - The owner's fixture.
 * @returns The viewer's fixture.
 */
async function viewer(fixture: ActivityCollabFixture): Promise<ActivityCollabFixture> {
  const [user] = await core.rawPg<{ id: string }[]>`INSERT INTO users(email,email_verified) VALUES(${`size-viewer-${randomUUID()}@example.test`},true) RETURNING id`;
  await core.rawPg`INSERT INTO studio_members(studio_id,user_id,role) SELECT studio_id,${user!.id},'guest' FROM projects WHERE id=${fixture.projectId}`;
  await core.rawPg`INSERT INTO project_members(project_id,user_id,role) VALUES(${fixture.projectId},${user!.id},'viewer')`;
  const token = randomBytes(24).toString("hex");
  await core.setSession(core.getRedis(), token, user!.id);
  return { ...fixture, userId: user!.id, cookie: `${core.sessionCookieName()}=${token}` };
}

/**
 * A fake Hocuspocus connection for a direct hook call.
 * @param doc - The document.
 * @param socketId - Socket id.
 * @param userId - User id.
 * @returns The connection.
 */
function directConnection(doc: Document, socketId: string, userId: string): Record<string, unknown> {
  const connection = {
    socketId,
    readOnly: false,
    context: { user: { id: userId, role: "owner" }, seatCap: null },
    sendStateless: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    messageAddress: doc.name,
    document: doc,
  };
  doc.addConnection(connection as unknown as Parameters<Document["addConnection"]>[0]);
  return connection;
}

/**
 * Load a document into a `Document` and run the production `afterLoadDocument` on it.
 * @param name - Document name.
 * @param src - Content.
 * @returns The document.
 */
async function loadDirect(name: string, src: Y.Doc): Promise<Document> {
  const hooks = state.configs.at(-1) as unknown as Hooks;
  const doc = new Document(name, undefined, { flushDelay: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(src));
  await hooks.afterLoadDocument({ documentName: name, document: doc, instance: { documents: new Map([[name, doc]]) }, context: {} });
  return doc;
}

/**
 * Call the production `beforeSync` with an append that has to be tried
 * (C-85 (b) shape: the upper bound is raised to the limit first).
 * @param doc - The document.
 * @param connection - The fake connection.
 * @returns Whether it was admitted (applied) or the error it threw.
 */
async function tryAppend(doc: Document, connection: Record<string, unknown>): Promise<"admitted" | Error> {
  const hooks = state.configs.at(-1) as unknown as Hooks;
  size.recordExact(doc.name, L_I);
  const update = appendUpdate(doc, 100);
  try {
    await hooks.beforeSync({ documentName: doc.name, document: doc, connection, context: connection.context, type: SYNC.update, payload: update, clientsCount: 1 });
    Y.applyUpdate(doc, update, { source: "connection", connection });
    return "admitted";
  } catch (err) {
    return err as Error;
  }
}

beforeAll(async () => {
  active = await start();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  state.delayStep2Ms = 0;
});

afterAll(async () => {
  if (active) await stop(active);
  for (const result of redisFactory.mock.results) {
    if (result.type === "return" && result.value.status !== "end") await result.value.quit();
  }
  redisFactory.mockRestore();
});

describe("trial budget on real Redis", () => {
  it("C-101 admits six trials a minute per document and user, refuses the seventh, under the real key", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await core.getRedis().del(trialKey(name, fixture.userId));
    const doc = await loadDirect(name, helloDoc());
    const connection = directConnection(doc, "s1", fixture.userId);
    const outcomes: Array<"admitted" | Error> = [];
    for (let i = 0; i < 7; i++) outcomes.push(await tryAppend(doc, connection));
    expect(outcomes.slice(0, 6)).toEqual(Array(6).fill("admitted"));
    expect(outcomes[6]).toBeInstanceOf(Error);
    expect(refusals(name).map((r) => r.step)).toEqual(["budget_user"]);
    expect(await trials(name, fixture.userId)).toBe(6);
    const ttl = await core.getRedis().pttl(trialKey(name, fixture.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await core.getCollabRedis().exists(trialKey(name, fixture.userId))).toBe(0);
  });

  it("C-102 shares the count across one user's sockets and keeps documents and users apart", async () => {
    const fixture = await seedCollabActivity();
    const other = await viewer(fixture);
    const name = canvasOf(fixture);
    const otherName = spaceContentDocName(fixture.projectId, fixture.spaceIds.document, "document");
    for (const [n, u] of [[name, fixture.userId], [name, other.userId], [otherName, fixture.userId]] as const) {
      await core.getRedis().del(trialKey(n, u));
    }
    const doc = await loadDirect(name, helloDoc());
    const s1 = directConnection(doc, "s1", fixture.userId);
    const s2 = directConnection(doc, "s2", fixture.userId);
    for (let i = 0; i < 4; i++) expect(await tryAppend(doc, s1)).toBe("admitted");
    for (let i = 0; i < 2; i++) expect(await tryAppend(doc, s2)).toBe("admitted");
    expect(await tryAppend(doc, s2)).toBeInstanceOf(Error);
    expect(refusals(name).map((r) => r.step)).toEqual(["budget_user"]);

    const u2 = directConnection(doc, "s3", other.userId);
    expect(await tryAppend(doc, u2)).toBe("admitted");
    const otherDoc = await loadDirect(otherName, helloDoc());
    expect(await tryAppend(otherDoc, directConnection(otherDoc, "s1", fixture.userId))).toBe("admitted");
  });

  it("C-103 does not reset the count when the same socket re-authenticates", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await core.getRedis().del(trialKey(name, fixture.userId));
    const src = new Y.Doc();
    fill(src, L_I - 1000);
    await seed(name, src);
    const socket = await socketFor(fixture);
    for (let round = 0; round < 10; round++) {
      const client = await openDoc(socket, name);
      await client.sync();
      client.edit((d) => d.getText("t").insert(0, "y".repeat(20_480)));
      await refusedFor(client);
    }
    expect(refusals(name).map((r) => r.step)).toEqual([...Array(6).fill("trial"), ...Array(4).fill("budget_user")]);
    expect(await trials(name, fixture.userId)).toBe(6);
  });
});

describe("lifecycle on a real instance", () => {
  it("C-117 loads a document once while it stays loaded", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await syncedOn(fixture, name);
    size.addUpperBound(name, 12_345);
    const before = size.readDocSizeRecord(name);
    await syncedOn(fixture, name);
    expect(size.readDocSizeRecord(name)).toEqual(before);
  });
});

describe("refusal and what it leaves behind", () => {
  it("C-140 refuses an over-limit update with the size reason, and nobody else gets it", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    fill(src, FULL_AT_I + 1000);
    await seed(name, src);
    const a = await syncedOn(fixture, name);
    const b = await syncedOn(fixture, name);
    a.edit((d) => d.getText("t").insert(0, `REFUSED-MARKER${"y".repeat(20_000)}`));
    await refusedFor(a);

    const server = active.hocuspocus.documents.get(name);
    expect(server?.getText("t").toString()).not.toContain("REFUSED-MARKER");
    expect((await b.confirm()).ok).toBe(true);
    expect(b.doc.getText("t").toString()).not.toContain("REFUSED-MARKER");
    expect((await persisted(active, name)).getText("t").toString()).not.toContain("REFUSED-MARKER");
    const lines = refusals(name);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      documentName: name,
      userId: fixture.userId,
      upper: expect.any(Number),
      after: expect.any(Number),
      limit: 262_144,
      ceiling: 268_698,
      step: "trial",
    });
  });

  it("C-144 after a refusal the same socket opens the document afresh and writes to it", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = buildNodes("image", 20);
    fill(src, FULL_AT_I + 1000);
    await seed(name, src);
    const socket = await socketFor(fixture);
    const a = await openDoc(socket, name);
    await a.sync();
    a.edit((d) => d.getText("t").insert(0, `REFUSED-MARKER${"y".repeat(20_000)}`));
    await refusedFor(a);

    const fresh = await openDoc(socket, name);
    await fresh.sync();
    fresh.edit((d) => d.getMap("nodes").delete("node-3"));
    fresh.edit((d) => {
      const t = d.getText("t");
      t.insert(t.length, "z".repeat(1000));
    });
    await fresh.confirm();
    const server = active.hocuspocus.documents.get(name);
    expect(server?.getMap("nodes").has("node-3")).toBe(false);
    expect(server?.getText("t").toString().endsWith("z".repeat(1000))).toBe(true);
    expect(server?.store.pendingStructs).toBeNull();
    expect(server?.store.pendingDs).toBeNull();
  });

  it("C-153 a viewer's write is not applied and does not close the viewer", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    fill(src, FULL_AT_I + 1000);
    await seed(name, src);
    const reader = await viewer(fixture);
    await core.getRedis().del(trialKey(name, reader.userId));
    const v = await openDoc(await socketFor(reader), name, { mode: "readonly" });
    await v.sync();
    v.edit((d) => d.getText("t").insert(0, `VIEWER-WRITE${"x".repeat(20_000)}`));
    expect((await v.confirm()).ok).toBe(false);
    expectNotRefused(v);
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString()).not.toContain("VIEWER-WRITE");
    expect(await trials(name, reader.userId)).toBe(0);
  });
});

describe("documents already over the line", () => {
  it("C-141 opens, reconnects and deletes on a document over the hard ceiling without a trial", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await core.getRedis().del(trialKey(name, fixture.userId));
    const src = imageNodes(200);
    fill(src, CEIL_I + 20_000);
    await seed(name, src);
    const first = await syncedOn(fixture, name);
    expectNotRefused(first);
    first.socket.close();
    const again = await syncedOn(fixture, name, first.doc);
    expectNotRefused(again);
    expect(await trials(name, fixture.userId)).toBe(0);

    const nodesBefore = active.hocuspocus.documents.get(name)?.getMap("nodes").size ?? 0;
    again.edit((d) => d.getMap("nodes").delete("node-100"));
    await again.confirm();
    expectNotRefused(again);
    expect(active.hocuspocus.documents.get(name)?.getMap("nodes").size).toBe(nodesBefore - 1);
  });

  it("C-142 three clients reconnecting after a restart are all let in without a trial", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await core.getRedis().del(trialKey(name, fixture.userId));
    const src = new Y.Doc();
    fill(src, FULL_AT_I + 1000);
    await seed(name, src);
    const first = await start();
    let restarted: Instance | undefined;
    try {
      const clients: SizeDocClient[] = [];
      for (let i = 0; i < 3; i++) clients.push(await syncedOn(fixture, name, undefined, first));
      await stop(first);
      const next = await start();
      restarted = next;
      const back = await Promise.all(clients.map((c) => syncedOn(fixture, name, c.doc, next)));
      for (const c of back) expectNotRefused(c);
      expect(await trials(name, fixture.userId)).toBe(0);
    } finally {
      if (restarted) await stop(restarted);
    }
  });

  it("C-143 a system write through a direct connection is applied, stored and counted past the limit", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = buildNodes("image", 1);
    fill(src, FULL_AT_I + 1000);
    await seed(name, src);
    await syncedOn(fixture, name);
    expect(size.readDocSizeRecord(name)?.phase).toBe("full");
    const before = size.readDocSizeRecord(name)!.upper;
    const server = active.hocuspocus.documents.get(name)!;
    let written: Uint8Array | undefined;
    server.once("update", (u: Uint8Array) => {
      written = u;
    });
    const direct = await active.hocuspocus.openDirectConnection(name, { context: { user: { id: "system" }, source: "task-listener" } });
    await direct.transact((d) => {
      (d.getMap("nodes").get("node-0") as Y.Map<unknown>).set("result", "r".repeat(20_480));
    });
    await direct.disconnect();
    expect(written).toBeDefined();
    await waitFor(() => size.readDocSizeRecord(name)!.upper !== before, "onChange counted the system write");
    expect(size.readDocSizeRecord(name)!.upper).toBe(before + onChangeBound(written!));
    expect(size.readDocSizeRecord(name)!.upper).toBeGreaterThan(L_I);
    expect(refusals(name)).toEqual([]);
    const stored = await persisted(active, name);
    expect((stored.getMap("nodes").get("node-0") as Y.Map<unknown>).get("result")).toBe("r".repeat(20_480));
  });
});

describe("reconnects that carry offline edits", () => {
  it("C-146 a lost in-flight update and offline typing arrive in the reconnect handshake", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, helloDoc());
    const a = await syncedOn(fixture, name);
    // The update for this edit never reaches the server, then the socket drops.
    a.doc.getText("t").insert(0, "LOST;");
    a.socket.close();
    for (const ch of ["a", "b", "c"]) a.doc.getText("t").insert(0, ch);
    const back = await syncedOn(fixture, name, a.doc);
    await back.confirm();
    expectNotRefused(back);
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString()).toBe(a.doc.getText("t").toString());
  });

  it("C-147 after a restart that lost an applied update, typing before the handshake is not refused", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = helloDoc();
    await seed(name, src);
    const instance = await start();
    const a = await syncedOn(fixture, name, undefined, instance);
    a.edit((d) => d.getText("t").insert(0, "APPLIED;"));
    await a.confirm();
    await stop(instance);
    // The store of that update never happened.
    await seed(name, src);
    const restarted = await start();
    try {
      const back = await openDoc(await socketFor(fixture, restarted), name, { doc: a.doc });
      back.edit((d) => d.getText("t").insert(0, "TYPED1;"));
      back.edit((d) => d.getText("t").insert(0, "TYPED2;"));
      await back.sync();
      await back.confirm();
      expectNotRefused(back);
      const server = restarted.hocuspocus.documents.get(name)!;
      expect(server.getText("t").toString()).toBe(a.doc.getText("t").toString());
      expect(server.store.pendingStructs).toBeNull();
      expect(server.store.pendingDs).toBeNull();
    } finally {
      await stop(restarted);
    }
  });

  it.each([300, 600])("C-148 updates sent while the handshake waits %i ms reach beforeSync after it", async (ms) => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, helloDoc());
    const a = await syncedOn(fixture, name);
    a.socket.close();
    a.doc.getText("t").insert(0, "OFFLINE;");
    state.delayStep2Ms = ms;
    const socket = await socketFor(fixture);
    const socketCalls = state.beforeSyncCalls.length;
    const back = await openDoc(socket, name, { doc: a.doc });
    const syncing = back.sync();
    await waitFor(() => back.frames().some((f) => f.type === WIRE.sync && f.syncSubType === SYNC.step1), "server SyncStep1");
    for (const ch of ["1", "2", "3"]) back.edit((d) => d.getText("t").insert(0, ch));
    await syncing;
    await back.confirm();
    expectNotRefused(back);
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString()).toBe(a.doc.getText("t").toString());
    const types = state.beforeSyncCalls.slice(socketCalls).filter((c) => c.documentName === name).map((c) => c.type);
    const step2At = types.indexOf(SYNC.step2);
    expect(step2At).toBeGreaterThanOrEqual(0);
    expect(types.filter((t) => t === SYNC.update)).toHaveLength(3);
    expect(types.slice(0, step2At)).not.toContain(SYNC.update);
  });

  it.each([
    ["pendingDs", storedPendingDsDoc],
    ["pendingStructs", storedPendingStructsDoc],
  ] as const)("C-150 a document loaded with stored %s takes an offline edit on reconnect", async (_kind, build) => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    await seed(name, build());
    const a = await syncedOn(fixture, name);
    const pendingBefore = pendingCounts(active.hocuspocus.documents.get(name)!);
    a.socket.close();
    a.doc.getText("t").insert(0, "OFFLINE-EDIT;");
    const back = await syncedOn(fixture, name, a.doc);
    await back.confirm();
    expectNotRefused(back);
    const server = active.hocuspocus.documents.get(name)!;
    expect(server.getText("t").toString()).toContain("OFFLINE-EDIT;");
    const pendingAfter = pendingCounts(server);
    expect(pendingAfter.p).toBeLessThanOrEqual(pendingBefore.p);
    expect(pendingAfter.q).toBeLessThanOrEqual(pendingBefore.q);
  });
});

describe("the inbound filter on a real instance", () => {
  it.each([
    ["Sync", WIRE.sync],
    ["SyncReply", WIRE.syncReply],
  ] as const)("C-154 Updates sent before the SyncStep2 (outer %s) are dropped and arrive inside it", async (_label, outer) => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = helloDoc();
    await seed(name, src);
    const socket = await socketFor(fixture);
    const calls = state.beforeSyncCalls.length;
    const client = await openDoc(socket, name, { doc: reload(src), answerServerStep1: false });
    for (const ch of ["1", "2", "3"]) client.edit((d) => d.getText("t").insert(0, ch), outer);
    client.sendSync(SYNC.step2, Y.encodeStateAsUpdate(client.doc, Y.encodeStateVector(src)), outer);
    client.edit((d) => d.getText("t").insert(0, "4"), outer);
    await client.confirm();
    expect(client.closeReasons()).toEqual([]);
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString()).toBe(client.doc.getText("t").toString());
    const types = state.beforeSyncCalls.slice(calls).filter((c) => c.documentName === name).map((c) => c.type);
    expect(types).toEqual([SYNC.step2, SYNC.update]);
  });

  it("C-155 a refused key cannot be bypassed with another session suffix before a new Auth", async () => {
    const fixture = await seedCollabActivity();
    const name = canvasOf(fixture);
    const src = new Y.Doc();
    fill(src, L_I - 1000);
    await seed(name, src);
    const socket = await socketFor(fixture);
    const first = await openDoc(socket, name, { key: `${name}\0sess-1` });
    await first.sync();
    first.edit((d) => d.getText("t").insert(0, "y".repeat(20_480)));
    await refusedFor(first);

    const calls = state.beforeSyncCalls.length;
    const bypass = `${name}\0sess-2`;
    const sneaky = reload(src);
    const sv = Y.encodeStateVector(sneaky);
    sneaky.getText("t").insert(0, "DROPPED;");
    const sneakyUpdate = Y.encodeStateAsUpdate(sneaky, sv);
    socket.send(syncFrame(bypass, WIRE.sync, SYNC.update, sneakyUpdate));
    socket.send(syncFrame(bypass, WIRE.sync, SYNC.step2, sneakyUpdate));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.beforeSyncCalls.slice(calls).filter((c) => c.documentName === name)).toEqual([]);

    const again = await openDoc(socket, name, { key: bypass });
    await again.sync();
    await again.confirm();
    expect(active.hocuspocus.documents.get(name)?.getText("t").toString()).not.toContain("DROPPED;");
  });
});
