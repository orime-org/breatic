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
import { projectMetaDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { listAgentPresence, markAgentActive } from "@collab/hooks/presence.js";
import { connectCollabActivity, seedCollabActivity } from "./helpers/account-activity-fixture.js";
import type { ActivityClient } from "./helpers/account-activity-fixture.js";
import { waitFor } from "./helpers/live-hocuspocus.js";

core.initCore(process.env);
core.loadLocales();
const redisFactory = vi.spyOn(core, "createRedisClient");
let active: Awaited<ReturnType<typeof createCollabServer>>;
const clients: ActivityClient[] = [];

beforeAll(async () => {
  active = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"),
    redisKeyPrefix: `agent-presence-${randomUUID()}`, shutdownDeadline: () => undefined });
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
