// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** Actual production composition acceptance, rather than another hook-factory fixture. */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as Y from "yjs";
import * as core from "@breatic/core";
import { spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { collabActivityRows, connectCollabActivity, rejectCollabActivity, seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityClient, ActivityCollabFixture } from "./helpers/account-activity-fixture.js";
import { statelessFrame, syncFrame, SYNC, WIRE, waitFor } from "./helpers/live-hocuspocus.js";

core.initCore(process.env);
core.loadLocales();
// A spy invokes the original factory unchanged. Its actual returned Redis
// handles are observed only so the test can close the private SUBSCRIBE client
// that production's process exit owns. There is no fake PG, Redis or WS path.
const redisFactory = vi.spyOn(core, "createRedisClient");
let active: Awaited<ReturnType<typeof createCollabServer>>;
const clients: ActivityClient[] = [];

beforeAll(async () => {
  active = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"),
    redisKeyPrefix: `activity-assembly-${randomUUID()}`, shutdownDeadline: () => undefined });
  await active.server.listen();
});
afterEach(() => {
  for (const client of clients.splice(0)) { client.socket.terminate(); client.document.destroy(); }
});
afterAll(async () => {
  if (active) {
    active.stopUpgradeSessions();
    active.storeLoop.stop();
    await active.seatHandover.stop();
    await active.server.destroy();
  }
  for (const result of redisFactory.mock.results) {
    if (result.type === "return" && result.value.status !== "end") await result.value.quit();
  }
  redisFactory.mockRestore();
});

/**
 * Authenticate and synchronize one real content connection through production wiring.
 * @param fixture - Real PG identity, Project and Redis session.
 * @param mode - Actual expected authorization mode.
 * @returns The native client and receiving document.
 * @throws {Error} When native transport, auth or the initial content sync fails.
 */
async function connect(fixture: ActivityCollabFixture, mode: "read-write" | "readonly" = "read-write"): Promise<ActivityClient> {
  const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
  const client = await connectCollabActivity(active.server, fixture, name, mode);
  clients.push(client);
  client.socket.send(syncFrame(name, WIRE.sync, SYNC.step1, Y.encodeStateVector(client.document)));
  // A real provider answers the server's SyncStep1 with its SyncStep2; collab
  // drops Updates sent before that handshake frame (inner#1790).
  client.socket.send(syncFrame(name, WIRE.sync, SYNC.step2, Y.encodeStateAsUpdate(client.document)));
  await waitFor(() => client.document.getMap("activity-test").get("existing") === "preserved", "production initial content sync");
  return client;
}

/**
 * Use the shipped content confirmation protocol as a real same-connection barrier.
 * @param client - Actual authenticated WebSocket client.
 * @param writable - Whether production may confirm writes on this connection.
 * @returns After all preceding sync messages reached their production outcome.
 * @throws {Error} When production cannot return its correlated confirmation.
 */
async function confirm(client: ActivityClient, writable = true): Promise<void> {
  const id = randomUUID();
  client.socket.send(statelessFrame(client.documentName, JSON.stringify({ type: "sync:confirm", id })));
  await waitFor(() => client.replies.some((frame) => {
    if (!frame.stateless) return false;
    const reply = JSON.parse(frame.stateless) as { id?: string; type?: string; ok?: boolean };
    return reply.id === id && reply.type === "sync:confirmed" && reply.ok === writable;
  }), "production same-connection confirmation");
}

/**
 * Produce actual nonempty Yjs mutation bytes on the synchronized local document.
 * @param client - Authenticated content client.
 * @returns The real update emitted by its local mutation.
 * @throws {Error} When the requested change emits no Yjs update.
 */
function mutation(client: ActivityClient): Uint8Array {
  let update: Uint8Array | undefined;
  client.document.once("update", (value: Uint8Array) => { update = value; });
  client.document.getMap("activity-test").set("actor", "UNTRUSTED_BROWSER_ACTOR");
  if (!update) throw new Error("expected actual content mutation bytes");
  return update;
}

/**
 * Add a real viewer while retaining the fixture's actual Project and Studio admin.
 * @param fixture - Existing owner's Project.
 * @returns A distinct account's Redis-backed read-only session for that Project.
 * @throws {Error} When real PG or Redis writes fail.
 */
async function viewer(fixture: ActivityCollabFixture): Promise<ActivityCollabFixture> {
  const [user] = await core.rawPg<{ id: string }[]>`INSERT INTO users(email,email_verified) VALUES(${`assembly-viewer-${randomUUID()}@example.test`},true) RETURNING id`;
  await core.rawPg`INSERT INTO studio_members(studio_id,user_id,role) SELECT studio_id,${user!.id},'guest' FROM projects WHERE id=${fixture.projectId}`;
  await core.rawPg`INSERT INTO project_members(project_id,user_id,role) VALUES(${fixture.projectId},${user!.id},'viewer')`;
  const token = randomBytes(24).toString("hex");
  await core.setSession(core.getRedis(), token, user!.id);
  return { ...fixture, userId: user!.id, cookie: `${core.sessionCookieName()}=${token}` };
}

describe("P19/P20 createCollabServer real composition acceptance", () => {
  it("persists authenticated content activity through the actual assembled beforeSync and receipt route", async () => {
    const fixture = await seedCollabActivity();
    const client = await connect(fixture);
    expect(await collabActivityRows(fixture)).toEqual([]);
    client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, mutation(client)));
    await confirm(client);
    expect(await collabActivityRows(fixture)).toEqual([expect.objectContaining({ user_id: fixture.userId, project_id: fixture.projectId, kind: "project_edit" })]);
    expect(active.hocuspocus.documents.get(client.documentName)?.getMap("activity-test").get("actor")).toBe("UNTRUSTED_BROWSER_ACTOR");
    expect(redisFactory).toHaveBeenCalledWith(inject("REDIS_COLLAB_URL"), expect.objectContaining({ name: "collab-seat-handover-sub" }));
  });

  it("preserves the production viewer read-only gate and excludes its mutation from activity", async () => {
    const fixture = await seedCollabActivity();
    const viewerFixture = await viewer(fixture);
    const client = await connect(viewerFixture, "readonly");
    client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, mutation(client)));
    await confirm(client, false);
    expect(await collabActivityRows(viewerFixture)).toEqual([]);
    expect(await collabActivityRows(fixture)).toEqual([]);
    expect(active.hocuspocus.documents.get(client.documentName)?.getMap("activity-test").get("actor")).toBeUndefined();
  });

  it("awaits real PG admission, closes only its document on failure and accepts a fresh connection after repair", async () => {
    const fixture = await seedCollabActivity();
    const client = await connect(fixture);
    const original = active.hocuspocus.documents.get(client.documentName);
    if (!original) throw new Error("expected actual loaded production document");
    const restore = await rejectCollabActivity(fixture);
    const update = mutation(client);
    try {
      client.socket.send(syncFrame(client.documentName, WIRE.sync, SYNC.update, update));
      await waitFor(() => client.replies.some((frame) => frame.docName === client.documentName && frame.type === WIRE.close), "native production document close");
      expect(original.getConnectionsCount()).toBe(0);
      expect(original.getMap("activity-test").get("actor")).toBeUndefined();
      expect(await collabActivityRows(fixture)).toEqual([]);
    } finally { await restore(); }
    const resumed = await connect(fixture);
    resumed.socket.send(syncFrame(resumed.documentName, WIRE.sync, SYNC.update, update));
    await confirm(resumed);
    expect(await collabActivityRows(fixture)).toHaveLength(1);
  });
});
