// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What collab tells which connection when a live update arrives (#1580, test spec area H): bell changes and an
 * upload's ending go to one person's meta connections, a transfer change to one Project's meta document, a credits
 * change to every live Project of the Studio, and a waveform's readiness to the Project it names. Two real Hocuspocus
 * instances share one Postgres and one Redis, each with its own relay, and each tells only its own connections.
 *
 * The `live_updates` payloads are sent with `pg_notify` exactly as the triggers send them (area A pins which writes
 * send what); this file pins where they go. A message that must not arrive is judged after a later message that must
 * arrive on the same instance has, so silence is a fact rather than a timeout.
 */

import { createHash, randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { Hocuspocus } from "@hocuspocus/server";
import type * as CoreModule from "@breatic/core";

const logged = vi.hoisted(() => [] as { level: string; msg: unknown; obj: unknown }[]);

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const record = (level: string) => (obj: unknown, msg?: unknown): void => {
    logged.push({ level, obj, msg });
  };
  return {
    ...actual,
    createLogger: () => ({ debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") }),
  };
});

import {
  createPgClient,
  createRedisClient,
  initCore,
  listenLiveUpdates,
  projectsRepo,
  publishAssetPeaksReady,
  publishUploadEnded,
  type Redis,
} from "@breatic/core";
import { canvasSpaceDocName, projectMetaDocName, type UploadStatus } from "@breatic/shared";
import { startLiveUpdateRelay } from "@collab/services/live-update-relay.js";
import { startProjectControlSync } from "@collab/services/project-control-sync.js";
import {
  connectLiveClient,
  createLiveServer,
  WIRE,
  type LiveClient,
} from "@collab/__tests__/helpers/live-hocuspocus.js";

try {
  initCore(process.env);
} catch {
  // Already initialised by another file in this fork.
}

/** The pg channel the live-updates triggers notify on (spec §0 `CH`). */
const CH = "live_updates";

let sql: ReturnType<typeof createPgClient>;
const clients: LiveClient[] = [];
const redisClients: Redis[] = [];
const stops: (() => Promise<void>)[] = [];

/**
 * A Hocuspocus instance whose connections are the person named in the `u` cookie, with its live-update relay and
 * its project control subscriber running.
 * @returns The instance.
 */
async function instance(): Promise<Hocuspocus> {
  const hocuspocus = createLiveServer({
    onAuthenticate: async ({ request }: { request: Request }) => {
      const id = /(?:^|;\s*)u=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
      return { user: { id, role: "editor" } };
    },
  });
  const source = createRedisClient(inject("REDIS_STREAM_URL"), { name: "live-update-relay-test", lazyConnect: false });
  redisClients.push(source);
  const relay = await startLiveUpdateRelay(hocuspocus, {
    listen: listenLiveUpdates,
    listLiveProjectIdsInStudio: projectsRepo.listLiveProjectIdsInStudio,
    source,
  });
  stops.push(() => relay.stop());
  stops.push(startProjectControlSync(hocuspocus, source));
  return hocuspocus;
}

/**
 * Open `userId`'s connection to a document.
 * @param hocuspocus - The instance.
 * @param userId - Whose connection.
 * @param docName - The document.
 * @returns The connection.
 */
async function open(hocuspocus: Hocuspocus, userId: string, docName: string): Promise<LiveClient> {
  const client = await connectLiveClient(hocuspocus, docName, { cookie: `u=${userId}` });
  expect(client.authenticated).toBe(true);
  clients.push(client);
  return client;
}

/**
 * The stateless messages a connection has received, parsed.
 * @param client - The connection.
 * @returns The messages, oldest first.
 */
function told(client: LiveClient): Record<string, unknown>[] {
  return client
    .frames()
    .filter((f) => f.type === WIRE.stateless)
    .map((f) => JSON.parse(f.stateless!) as Record<string, unknown>);
}

/**
 * The messages of one kind a connection has received.
 * @param client - The connection.
 * @param t - The message name.
 * @returns Those messages.
 */
function toldOf(client: LiveClient, t: string): Record<string, unknown>[] {
  return told(client).filter((m) => m.t === t);
}

/**
 * Wait until a connection has received `count` messages of one kind.
 * @param client - The connection.
 * @param t - The message name.
 * @param count - How many.
 * @returns Those messages.
 */
async function arrived(client: LiveClient, t: string, count = 1): Promise<Record<string, unknown>[]> {
  await vi.waitFor(() => expect(toldOf(client, t).length).toBeGreaterThanOrEqual(count), { timeout: 5000 });
  return toldOf(client, t);
}

/**
 * Notify on the live-updates channel the way the triggers do.
 * @param payload - The payload.
 * @returns Once sent.
 */
async function notify(payload: Record<string, unknown>): Promise<void> {
  await sql`select pg_notify(${CH}, ${JSON.stringify(payload)})`;
}

/** A user. */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, email_verified) values (${`relay-${randomUUID()}@example.test`}, true) returning id
  `;
  return row!.id;
}

/** A team studio administered by `admin`. */
async function studio(admin: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into studios (created_by_user_id, slug, type, name) values (${admin}, ${`rl-${randomUUID().slice(0, 30)}`}, 'team', 'Relay') returning id
  `;
  await sql`insert into studio_members (studio_id, user_id, role) values (${row!.id}, ${admin}, 'admin')`;
  return row!.id;
}

/** A Project in `studioId`, live unless archived or deleted. */
async function project(studioId: string, admin: string, state: "live" | "archived" | "deleted" = "live"): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into projects (studio_id, created_by_user_id, slug, name, archived_at, archived_by_user_id, deleted_at)
    values (${studioId}, ${admin}, ${`rl-${randomUUID().slice(0, 30)}`}, 'Relay',
      ${state === "archived" ? new Date() : null}, ${state === "archived" ? admin : null}, ${state === "deleted" ? new Date() : null})
    returning id
  `;
  return row!.id;
}

/** The standard scenario of spec §0: two Studios, five Projects, five people. */
interface Scenario {
  S: string;
  T: string;
  P1: string;
  P2: string;
  P3: string;
  P4: string;
  Q1: string;
  U: string;
  V: string;
  W: string;
  X: string;
}

/**
 * Build a fresh standard scenario.
 * @returns Its ids.
 */
async function scenario(): Promise<Scenario> {
  const [U, V, W, X] = [await user(), await user(), await user(), await user()];
  const S = await studio(U);
  const T = await studio(X);
  return {
    S, T, U, V, W, X,
    P1: await project(S, U),
    P2: await project(S, U),
    P3: await project(S, U, "archived"),
    P4: await project(S, U, "deleted"),
    Q1: await project(T, X),
  };
}

/**
 * A completed upload's status, as the status read answers it.
 * @param key - The upload's storage key.
 * @returns The status.
 */
function completedStatus(key: string): UploadStatus {
  return {
    key,
    state: "completed",
    result: { assetId: randomUUID(), fileUrl: `https://assets.example.test/${key}`, kind: "image", width: 64, height: 48 },
  };
}

let I1: Hocuspocus;
let I2: Hocuspocus;
let sentinelUser: string;
let sentinelOnI1: LiveClient;
let sentinelOnI2: LiveClient;

/**
 * Tell the sentinel person something and wait until both instances delivered it, so every earlier bell message has
 * been handled on both.
 * @returns Once both arrived.
 */
async function drainBells(): Promise<void> {
  const before = [toldOf(sentinelOnI1, "notifications:changed").length, toldOf(sentinelOnI2, "notifications:changed").length];
  await notify({ k: "notifications", u: sentinelUser });
  await arrived(sentinelOnI1, "notifications:changed", before[0]! + 1);
  await arrived(sentinelOnI2, "notifications:changed", before[1]! + 1);
}

beforeAll(async () => {
  sql = createPgClient(inject("DATABASE_URL"), { name: "live-update-relay-driver", max: 4, prepare: false });
  I1 = await instance();
  I2 = await instance();
  sentinelUser = await user();
  const sentinelProject = await project(await studio(sentinelUser), sentinelUser);
  sentinelOnI1 = await open(I1, sentinelUser, projectMetaDocName(sentinelProject));
  sentinelOnI2 = await open(I2, sentinelUser, projectMetaDocName(sentinelProject));
});

afterAll(async () => {
  for (const c of clients) c.close();
  for (const stop of stops) await stop();
  for (const r of redisClients) await r.quit();
  await sql?.end({ timeout: 1 });
});

describe("a bell change", () => {
  it("H-01 reaches each of the person's meta connections once, and no one else", async () => {
    const s = await scenario();
    const uOnP1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const uOnP2 = await open(I1, s.U, projectMetaDocName(s.P2));
    const vOnP1 = await open(I1, s.V, projectMetaDocName(s.P1));
    await notify({ k: "notifications", u: s.U });
    await arrived(uOnP1, "notifications:changed");
    await arrived(uOnP2, "notifications:changed");
    await drainBells();
    expect(toldOf(uOnP1, "notifications:changed")).toEqual([{ t: "notifications:changed" }]);
    expect(toldOf(uOnP2, "notifications:changed")).toEqual([{ t: "notifications:changed" }]);
    expect(told(vOnP1)).toEqual([]);
  });

  it("H-02 and H-13 is heard by both instances, each telling only its own connections, exactly once", async () => {
    const s = await scenario();
    const onI1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const onI2 = await open(I2, s.U, projectMetaDocName(s.P2));
    await notify({ k: "notifications", u: s.U });
    await arrived(onI1, "notifications:changed");
    await arrived(onI2, "notifications:changed");
    await drainBells();
    expect(toldOf(onI1, "notifications:changed")).toHaveLength(1);
    expect(toldOf(onI2, "notifications:changed")).toHaveLength(1);
  });

  it("H-03 for someone with no connection sends nothing and logs no error", async () => {
    const s = await scenario();
    const errorsBefore = logged.filter((l) => l.level === "error").length;
    await notify({ k: "notifications", u: s.U });
    await drainBells();
    expect(logged.filter((l) => l.level === "error").length).toBe(errorsBefore);
  });

  it("H-04 goes only to meta connections, never to a Space document", async () => {
    const s = await scenario();
    const onCanvas = await open(I1, s.U, canvasSpaceDocName(s.P1, randomUUID()));
    await notify({ k: "notifications", u: s.U });
    await drainBells();
    expect(told(onCanvas)).toEqual([]);
  });
});

describe("an upload's ending", () => {
  it("H-05 reaches only the uploader, with the key and the status exactly as published", async () => {
    const s = await scenario();
    const uOnP1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const vOnP1 = await open(I1, s.V, projectMetaDocName(s.P1));
    const key = `uploads/${randomUUID()}.png`;
    const status = completedStatus(key);
    await publishUploadEnded(s.U, status);
    const [got] = await arrived(uOnP1, "upload:ended");
    expect(got).toEqual({ t: "upload:ended", key, status });
    const sentinelBefore = toldOf(sentinelOnI1, "upload:ended").length;
    await publishUploadEnded(sentinelUser, completedStatus(`uploads/${randomUUID()}.png`));
    await arrived(sentinelOnI1, "upload:ended", sentinelBefore + 1);
    expect(told(vOnP1)).toEqual([]);
  });

  it("H-06 reaches the uploader on the other instance", async () => {
    const s = await scenario();
    const onI2 = await open(I2, s.U, projectMetaDocName(s.P1));
    const key = `uploads/${randomUUID()}.png`;
    const status: UploadStatus = { key, state: "failed", reason: "over_cap" };
    await publishUploadEnded(s.U, status);
    const [got] = await arrived(onI2, "upload:ended");
    expect(got).toEqual({ t: "upload:ended", key, status });
  });
});

describe("a transfer change", () => {
  it("H-07 reaches the Project's meta connections with its id, and not another Project's", async () => {
    const s = await scenario();
    const uOnP1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const vOnP1 = await open(I1, s.V, projectMetaDocName(s.P1));
    const wOnP2 = await open(I1, s.W, projectMetaDocName(s.P2));
    await notify({ k: "project-transfer", p: s.P1 });
    await arrived(uOnP1, "project-transfer:changed");
    await arrived(vOnP1, "project-transfer:changed");
    expect(toldOf(uOnP1, "project-transfer:changed")).toEqual([{ t: "project-transfer:changed", projectId: s.P1 }]);
    expect(toldOf(vOnP1, "project-transfer:changed")).toEqual([{ t: "project-transfer:changed", projectId: s.P1 }]);
    expect(told(wOnP2)).toEqual([]);
  });
});

describe("a Studio's credits change", () => {
  it("H-08 reaches every loaded live Project of the Studio, each with its own id, and not another Studio's", async () => {
    const s = await scenario();
    const onP1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const onP2 = await open(I1, s.U, projectMetaDocName(s.P2));
    const onQ1 = await open(I1, s.X, projectMetaDocName(s.Q1));
    await notify({ k: "credits", s: s.S });
    await arrived(onP1, "credits:changed");
    await arrived(onP2, "credits:changed");
    expect(toldOf(onP1, "credits:changed")).toEqual([{ t: "credits:changed", projectId: s.P1 }]);
    expect(toldOf(onP2, "credits:changed")).toEqual([{ t: "credits:changed", projectId: s.P2 }]);
    expect(told(onQ1)).toEqual([]);
  });

  it("H-09 reaches only the Projects this instance has loaded, with no error for the others", async () => {
    const s = await scenario();
    const onP2 = await open(I1, s.U, projectMetaDocName(s.P2));
    const errorsBefore = logged.filter((l) => l.level === "error" || l.level === "warn").length;
    await notify({ k: "credits", s: s.S });
    await arrived(onP2, "credits:changed");
    expect(toldOf(onP2, "credits:changed")).toEqual([{ t: "credits:changed", projectId: s.P2 }]);
    expect(I1.documents.has(projectMetaDocName(s.P1))).toBe(false);
    expect(logged.filter((l) => l.level === "error" || l.level === "warn").length).toBe(errorsBefore);
  });

  it("H-14 still reaches the other Projects when one meta document fails to relay, and logs the failure", async () => {
    const s = await scenario();
    await open(I1, s.U, projectMetaDocName(s.P1));
    const onP2 = await open(I1, s.U, projectMetaDocName(s.P2));
    const broken = I1.documents.get(projectMetaDocName(s.P1))!;
    const relay = vi.spyOn(broken, "relayStateless").mockImplementation(() => {
      throw new Error("relay broke");
    });
    const loggedBefore = logged.length;
    try {
      await notify({ k: "credits", s: s.S });
      await arrived(onP2, "credits:changed");
      await vi.waitFor(() => expect(relay).toHaveBeenCalled());
      expect(logged.slice(loggedBefore).some((l) => l.level === "warn" || l.level === "error")).toBe(true);
    } finally {
      relay.mockRestore();
    }
  });
});

describe("the live Projects of a Studio", () => {
  it("H-10 are its Projects neither archived nor deleted", async () => {
    const s = await scenario();
    expect([...(await projectsRepo.listLiveProjectIdsInStudio(s.S))].sort()).toEqual([s.P1, s.P2].sort());
  });
});

describe("a waveform made ready", () => {
  it("H-11 reaches the named Project's meta connections with the asset and its address", async () => {
    const s = await scenario();
    const onP1 = await open(I1, s.U, projectMetaDocName(s.P1));
    const onP2 = await open(I1, s.U, projectMetaDocName(s.P2));
    const assetId = randomUUID();
    const url = `https://assets.example.test/${createHash("sha256").update(assetId).digest("hex")}.mp3`;
    await publishAssetPeaksReady(s.P1, assetId, url);
    const [got] = await arrived(onP1, "asset-peaks:ready");
    expect(got).toMatchObject({ t: "asset-peaks:ready", assetId, url });
    expect(Object.keys(got!).filter((k) => !["t", "projectId", "assetId", "url"].includes(k))).toEqual([]);
    await publishAssetPeaksReady(s.P2, randomUUID(), url);
    await arrived(onP2, "asset-peaks:ready");
    expect(toldOf(onP1, "asset-peaks:ready")).toHaveLength(1);
  });
});

// #1580 PT-6: for any spread of connections over the two instances and any run
// of messages from the four sources, what each connection received is exactly
// what the routing table of design §2.7 gives it.
describe("PT-6 routing under random connections and messages", () => {
  type Message =
    | { kind: "bell"; user: number }
    | { kind: "ended"; user: number }
    | { kind: "transfer"; project: number }
    | { kind: "credits"; studio: number };
  const message: fc.Arbitrary<Message> = fc.oneof(
    fc.record({ kind: fc.constant("bell" as const), user: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("ended" as const), user: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("transfer" as const), project: fc.integer({ min: 0, max: 2 }) }),
    fc.record({ kind: fc.constant("credits" as const), studio: fc.integer({ min: 0, max: 1 }) }),
  );
  const connection = fc.record({ user: fc.integer({ min: 0, max: 2 }), project: fc.integer({ min: 0, max: 2 }), instance: fc.integer({ min: 0, max: 1 }) });

  it("delivers to each connection exactly what the table says", async () => {
    // Projects 0 and 1 are in studio 0, project 2 in studio 1.
    const studioOfProject = [0, 0, 1];
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(connection, { maxLength: 6, selector: (c) => `${c.user}-${c.project}-${c.instance}` }), fc.array(message, { minLength: 1, maxLength: 5 }), async (spread, messages) => {
        // Each run has its own people and Projects, so a message still on its way from an earlier run reaches no
        // connection of this one.
        const users = [await user(), await user(), await user()];
        const studios = [await studio(users[0]!), await studio(users[1]!)];
        const projects = [await project(studios[0]!, users[0]!), await project(studios[0]!, users[0]!), await project(studios[1]!, users[1]!)];
        const opened = await Promise.all(spread.map(async (c) => ({ ...c, client: await open(c.instance === 0 ? I1 : I2, users[c.user]!, projectMetaDocName(projects[c.project]!)) })));
        try {
          const keys = messages.map(() => `uploads/pt6-${randomUUID()}.png`);
          for (const [i, m] of messages.entries()) {
            if (m.kind === "bell") await notify({ k: "notifications", u: users[m.user] });
            else if (m.kind === "ended") await publishUploadEnded(users[m.user]!, { key: keys[i]!, state: "transferred" });
            else if (m.kind === "transfer") await notify({ k: "project-transfer", p: projects[m.project] });
            else await notify({ k: "credits", s: studios[m.studio] });
          }
          const expectedFor = (c: { user: number; project: number }): Record<string, unknown>[] =>
            messages.flatMap((m, i): Record<string, unknown>[] => {
              if (m.kind === "bell") return m.user === c.user ? [{ t: "notifications:changed" }] : [];
              if (m.kind === "ended") return m.user === c.user ? [{ t: "upload:ended", key: keys[i], status: { key: keys[i], state: "transferred" } }] : [];
              if (m.kind === "transfer") return m.project === c.project ? [{ t: "project-transfer:changed", projectId: projects[c.project] }] : [];
              return studioOfProject[c.project] === m.studio ? [{ t: "credits:changed", projectId: projects[c.project] }] : [];
            });
          const sorted = (list: Record<string, unknown>[]): string[] => list.map((x) => JSON.stringify(x)).sort();
          await vi.waitFor(() => {
            for (const c of opened) expect(told(c.client).length).toBeGreaterThanOrEqual(expectedFor(c).length);
          }, { timeout: 5000 });
          await drainBells();
          for (const c of opened) expect(sorted(told(c.client))).toEqual(sorted(expectedFor(c)));
        } finally {
          for (const c of opened) c.client.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
