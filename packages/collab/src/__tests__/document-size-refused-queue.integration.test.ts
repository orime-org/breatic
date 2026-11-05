// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * After `beforeSync` refuses an update, the updates the client had already
 * queued behind it never reach `beforeSync` (inner#1790, DD 6.5 R×C5,
 * spec C-131).
 *
 * Hocuspocus empties a connection's queue when a message handler throws
 * (`hocuspocus-server.cjs:497-505`), and the inbound filter drops whatever of
 * that document arrives afterwards until the next Auth. Real production
 * composition from `createCollabServer`, real Postgres, Redis and WebSocket;
 * `Server` is only subclassed to record every `beforeSync` call.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import type * as HocuspocusServerModule from "@hocuspocus/server";
import type * as ConfigModule from "@collab/config.js";

const { beforeSyncCalls } = vi.hoisted(() => ({
  beforeSyncCalls: [] as { documentName: string; type: number; payload: Uint8Array }[],
}));

vi.mock("@hocuspocus/server", async (importOriginal) => {
  const real = await importOriginal<typeof HocuspocusServerModule>();
  type Config = ConstructorParameters<typeof real.Server>[0] & {
    beforeSync?: (payload: { documentName: string; type: number; payload: Uint8Array }) => Promise<unknown>;
  };
  /** The real server, recording each `beforeSync` call before running the production hook. */
  class RecordingServer extends real.Server {
    /**
     * Wrap the production `beforeSync`.
     * @param config - The production configuration.
     */
    constructor(config: Config) {
      const hook = config.beforeSync;
      super({
        ...config,
        beforeSync: hook
          ? async (payload: { documentName: string; type: number; payload: Uint8Array }): Promise<unknown> => {
            beforeSyncCalls.push({ documentName: payload.documentName, type: payload.type, payload: payload.payload });
            return hook(payload);
          }
          : undefined,
      } as Config);
    }
  }
  return { ...real, Server: RecordingServer };
});

// The integration configuration of spec 10.2 (I config).
vi.mock("@collab/config.js", async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  const scaled = Object.freeze({
    ...real.getCollabConfig(),
    max_document_bytes: 262_144,
    document_size_warn_ratio: 0.8,
    document_size_full_margin_bytes: 6_554,
    document_size_delete_headroom_bytes: 6_554,
    document_size_overwrite_reserve_bytes: 1_638,
    document_size_measure_interval_ms: 2000,
    document_size_trials_per_user_per_minute: 6,
    document_size_trial_budget_ms_per_second: 200,
  });
  return { ...real, getCollabConfig: () => scaled };
});

import * as core from "@breatic/core";
import { spaceContentDocName } from "@breatic/shared";
import { createCollabServer } from "@collab/hocuspocus.js";
import { connectCollabActivity, seedCollabActivity } from "@collab/__tests__/helpers/account-activity-fixture.js";
import type { ActivityClient } from "@collab/__tests__/helpers/account-activity-fixture.js";
import { SYNC, WIRE, authFrame, statelessFrame, syncFrame, waitFor } from "@collab/__tests__/helpers/live-hocuspocus.js";

core.initCore(process.env);
core.loadLocales();
const redisFactory = vi.spyOn(core, "createRedisClient");
let active: Awaited<ReturnType<typeof createCollabServer>>;
const clients: ActivityClient[] = [];

beforeAll(async () => {
  active = await createCollabServer({ port: 0, collabRedisUrl: inject("REDIS_COLLAB_URL"),
    redisKeyPrefix: `doc-size-queue-${randomUUID()}`, shutdownDeadline: () => undefined });
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
 * A V1 update with no structs and one delete range wholly past every known
 * clock (client 9999, `[0, 800000)`), which `beforeSync` refuses at step 2
 * (spec C-46 (a), C-81 (a)).
 * @returns The update bytes.
 */
function pendingUpdate(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, 9999);
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, 0);
  encoding.writeVarUint(encoder, 800_000);
  return encoding.toUint8Array(encoder);
}

describe("a refused connection's queued updates", () => {
  it("C-131 never reach beforeSync before the next Auth", async () => {
    const fixture = await seedCollabActivity();
    const name = spaceContentDocName(fixture.projectId, fixture.spaceIds.canvas, "canvas");
    const client = await connectCollabActivity(active.server, fixture, name);
    clients.push(client);

    // Handshake both ways: initial content in, then the client's SyncStep2 out.
    client.socket.send(syncFrame(name, WIRE.sync, SYNC.step1, Y.encodeStateVector(client.document)));
    await waitFor(() => client.document.getMap("activity-test").get("existing") === "preserved", "initial content sync");
    client.socket.send(syncFrame(name, WIRE.sync, SYNC.step2, Y.encodeStateAsUpdate(client.document)));
    const confirmId = randomUUID();
    client.socket.send(statelessFrame(name, JSON.stringify({ type: "sync:confirm", id: confirmId })));
    await waitFor(() => client.replies.some((frame) => frame.stateless !== undefined && frame.stateless.includes(confirmId)), "handshake confirmed");

    // Five ordinary edits, sent in the same batch right behind the refused update.
    const followers: Uint8Array[] = [];
    client.document.on("update", (update: Uint8Array) => followers.push(update));
    for (let i = 0; i < 5; i++) client.document.getMap("activity-test").set(`after-${i}`, i);
    expect(followers).toHaveLength(5);
    const refused = pendingUpdate();
    const before = beforeSyncCalls.length;
    client.socket.send(syncFrame(name, WIRE.sync, SYNC.update, refused));
    for (const update of followers) client.socket.send(syncFrame(name, WIRE.sync, SYNC.update, update));

    await waitFor(() => client.replies.some((frame) => frame.docName === name && frame.type === WIRE.close), "the refused document is closed");
    // Every frame sent before this Auth has reached the server once its answer is back.
    const other = spaceContentDocName(fixture.projectId, fixture.spaceIds.document, "document");
    client.socket.send(authFrame(other, "__cookie_auth__"));
    await waitFor(() => client.replies.some((frame) => frame.docName === other && frame.type === WIRE.auth), "barrier on another document");

    const after = beforeSyncCalls.slice(before).filter((call) => call.documentName === name);
    expect(after).toHaveLength(1);
    expect(after[0]!.type).toBe(SYNC.update);
    expect(Array.from(after[0]!.payload)).toEqual(Array.from(refused));
  });
});
