// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External agents' presence on the assembled collab server (breatic#1488
 * §19.2): a member reaching the meta document is the check for an agent
 * whose credential ended while no instance held that document, so no
 * announcement reached it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as core from "@breatic/core";
import { canvasSpaceDocName, projectMetaDocName } from "@breatic/shared";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createCollabServer } from "@collab/hocuspocus.js";
import { listAgentPresence, markAgentActive } from "@collab/hooks/presence.js";
import { connectCollabActivity, seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityClient } from "./helpers/account-activity-fixture.js";
import { awarenessFrame, SYNC, syncFrame, waitFor, WIRE } from "./helpers/live-hocuspocus.js";
import { readLastViews, recordLastView } from "@collab/services/last-view-cache.js";

core.initCore(process.env);
core.loadLocales();
const redisFactory = vi.spyOn(core, "createRedisClient");
let active: Awaited<ReturnType<typeof createCollabServer>>;
const PREFIX = `agent-presence-${randomUUID()}`;
const clients: ActivityClient[] = [];

beforeAll(async () => {
  active = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"),
    redisKeyPrefix: PREFIX, shutdownDeadline: () => undefined });
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

describe("a member arriving at the meta document", () => {
  it("marks offline an agent whose connection ended unannounced, and keeps one still usable", async () => {
    const fixture = await seedCollabActivity();
    const ended = await core.agentAccessService.createPersonalAccessToken({ userId: fixture.userId, name: "ended", expiresAt: null });
    const kept = await core.agentAccessService.createPersonalAccessToken({ userId: fixture.userId, name: "kept", expiresAt: null });
    if (!ended.ok || !kept.ok) throw new Error("expected both tokens");
    const metaName = projectMetaDocName(fixture.projectId);
    const direct = await active.hocuspocus.openDirectConnection(metaName, {});
    try {
    await direct.transact((meta) => {
      for (const connectionId of [ended.connectionId, kept.connectionId]) {
        markAgentActive({ document: meta, userId: fixture.userId, connectionId, spaceId: null, focus: undefined, now: Date.now() });
      }
    });
    // Revoked in the database only: no announcement goes out.
    await core.agentAccessService.disconnect(ended.connectionId, fixture.userId);

    clients.push(await connectCollabActivity(active.server, fixture, metaName, "readonly"));
    const meta = active.hocuspocus.documents.get(metaName)!;
    /**
     * Whether a connection's agent reads online.
     * @param connectionId - The agent connection.
     * @returns Its online flag.
     */
    const onlineOf = (connectionId: string): boolean | undefined => listAgentPresence(meta).find((a) => a.connectionId === connectionId)?.online;
    await waitFor(() => onlineOf(ended.connectionId) === false, "the ended agent marked offline on arrival");
    expect(onlineOf(kept.connectionId)).toBe(true);
    } finally {
      await direct.disconnect();
    }
  });
});

describe("what a member has on screen (#1488 §6)", () => {
  it("is kept from the awareness their canvas connection sends", async () => {
    const fixture = await seedCollabActivity();
    const canvas = canvasSpaceDocName(fixture.projectId, fixture.spaceIds.canvas);
    const client = await connectCollabActivity(active.server, fixture, canvas);
    clients.push(client);
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalState({ activeNodeIds: ["n1"], pointer: { x: 1, y: 2 }, camera: { x: 0, y: 0, width: 100, height: 50, at: 1 } });
    client.socket.send(awarenessFrame(canvas, encodeAwarenessUpdate(awareness, [awareness.clientID])));
    for (let i = 0; i < 100 && (await readLastViews(core.getCollabRedis(), PREFIX, fixture.projectId, Date.now())).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readLastViews(core.getCollabRedis(), PREFIX, fixture.projectId, Date.now())).toEqual([
      expect.objectContaining({
        userId: fixture.userId,
        spaceId: fixture.spaceIds.canvas,
        activeNodeIds: ["n1"],
        pointer: { x: 1, y: 2 },
        camera: { x: 0, y: 0, width: 100, height: 50 },
      }),
    ]);
  });

  it("outlives its first expiry once the member's socket shows a sign of life", async () => {
    const fixture = await seedCollabActivity();
    const canvas = canvasSpaceDocName(fixture.projectId, fixture.spaceIds.canvas);
    const view = { activeNodeIds: null, pointer: null, camera: null, cursor: null };
    await recordLastView(core.getCollabRedis(), PREFIX, { projectId: fixture.projectId, userId: fixture.userId, spaceId: fixture.spaceIds.canvas, view }, 1000, Date.now());
    const client = await connectCollabActivity(active.server, fixture, canvas);
    clients.push(client);
    // Messages are signs of life; a sync request rewrites no view.
    const sending = setInterval(() => client.socket.send(syncFrame(canvas, WIRE.sync, SYNC.step1, Y.encodeStateVector(new Y.Doc()))), 100);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300));
    } finally {
      clearInterval(sending);
    }
    expect((await readLastViews(core.getCollabRedis(), PREFIX, fixture.projectId, Date.now())).map((v) => v.userId)).toEqual([fixture.userId]);
  });
});
