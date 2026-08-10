// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Two collab instances, one Redis, one Postgres — the topology production
 * actually runs (#26).
 *
 * The Space-existence check answers from the meta doc this process holds, and
 * loads one when it holds none. Whether that is right across instances lives
 * entirely in what the load produces: Postgres hands back a row that may be a
 * store tick behind, and `@hocuspocus/extension-redis` then asks the peers for
 * anything newer. Reading the library and reasoning about the window is not
 * the same as running it, so this runs it.
 *
 * The shape under test is the one the logs show (2026-08-10 11:13:21): an
 * instance comes up, a browser that has already synced reconnects every open
 * document at once, and the content-doc handshakes arrive on an instance that
 * holds nothing for this project.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";

import { initCore, createRedisClient } from "@breatic/core";
import * as yjsRepo from "@breatic/collab/src/services/yjs-documents.repo.js";
import { createPersistenceExtension } from "@breatic/collab/src/services/persistence.js";
import { createChangeTrackingExtension } from "@breatic/collab/src/services/change-tracking.js";

const PID = "44444444-4444-4444-8444-444444444444";
const META_DOC = `project-${PID}/meta`;
/** Written to Postgres before anything starts. */
const STORED_SPACE = "55555555-5555-4555-8555-555555555555";
/** Created in one instance's memory only — never stored. */
const MEMORY_ONLY_SPACE = "66666666-6666-4666-8666-666666666666";

let instanceA: Hocuspocus;
let instanceB: Hocuspocus;
const servers: Array<{ destroy: () => Promise<void> }> = [];

/**
 * Build one collab instance wired the way production wires it: the change
 * tracker, the persistence extension, and the Redis extension over the
 * instance-coordination database.
 * @param name - Distinguishes the two instances' Redis clients.
 * @returns The running server's Hocuspocus instance.
 * @throws {Error} When the integration environment has no `REDIS_COLLAB_URL`.
 */
async function startInstance(name: string): Promise<Hocuspocus> {
  const collabUrl = process.env.REDIS_COLLAB_URL;
  if (!collabUrl) {
    throw new Error("REDIS_COLLAB_URL missing from the integration env");
  }
  const wsServer = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    unloadImmediately: true,
    extensions: [
      createChangeTrackingExtension(),
      createPersistenceExtension(),
      new RedisExtension({
        createClient: () => createRedisClient(collabUrl, { name }),
        prefix: "itest:hocuspocus",
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[],
  });
  await wsServer.listen();
  servers.push({ destroy: () => wsServer.destroy() });
  return wsServer.hocuspocus;
}

/**
 * Put a meta row in Postgres listing exactly the given Spaces — the state a
 * load starts from before the peers get a say.
 * @param ids - Space ids the stored row claims exist.
 */
async function seedStoredMeta(ids: string[]): Promise<void> {
  const doc = new Y.Doc();
  const spaces = doc.getMap("spaces");
  for (const id of ids) {
    const entry = new Y.Map<unknown>();
    spaces.set(id, entry);
    entry.set("id", id);
  }
  await yjsRepo.seedInitialState(META_DOC, Y.encodeStateAsUpdate(doc));
}

/**
 * What the Space-existence check would answer on this instance: the ids in
 * the meta doc it holds, loading one when it holds none. Mirrors
 * `loadProjectSpaceIds` in `packages/collab/src/hooks/auth.ts`.
 * @param instance - The collab instance to ask.
 * @returns The ids it answers with, and how long answering took.
 */
async function spaceIdsSeenBy(
  instance: Hocuspocus,
): Promise<{ ids: string[]; ms: number }> {
  const started = process.hrtime.bigint();
  const held = instance.documents.get(META_DOC);
  const doc =
    held ??
    (await instance.createDocument(
      META_DOC,
      new Request("http://localhost"),
      "space-existence-check",
      { isAuthenticated: true, readOnly: true },
      {},
    ));
  const ids = [...doc.getMap("spaces").keys()];
  return { ids, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

beforeAll(async () => {
  initCore(process.env);
  instanceA = await startInstance("itest-a");
  instanceB = await startInstance("itest-b");
}, 60_000);

afterAll(async () => {
  for (const s of servers) await s.destroy();
});

describe("Space existence across two collab instances", () => {
  it("sees a Space that only the other instance's memory knows about", async () => {
    await seedStoredMeta([STORED_SPACE]);

    // Instance A holds the meta doc and gains a Space the way `space:create`
    // does: in memory, broadcast, with nothing written to Postgres.
    const onA = await instanceA.openDirectConnection(META_DOC, {
      context: { user: { id: "system" } },
    });
    await onA.transact((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(MEMORY_ONLY_SPACE, entry);
      entry.set("id", MEMORY_ONLY_SPACE);
    });

    // Instance B holds nothing for this project — the reconnect shape. If it
    // decided from the stored row it would miss the new Space entirely, which
    // is what #26 was.
    const seenOnB = await spaceIdsSeenBy(instanceB);

    expect(seenOnB.ids).toContain(STORED_SPACE);
    expect(seenOnB.ids).toContain(MEMORY_ONLY_SPACE);
    // Answering is on the handshake path, so it has to be fast. Loose enough
    // not to be flaky on a loaded CI box, tight enough to catch the second a
    // connection-based load would have cost.
    expect(seenOnB.ms).toBeLessThan(500);

    // A document loaded with no connection is never unloaded on its own, so
    // whoever loads one puts it back. Doing that here is not tidiness: it is
    // the same return the check schedules, and without it `destroy()` — which
    // waits for the document count to reach zero — never finishes.
    const borrowed = instanceB.documents.get(META_DOC);
    expect(borrowed).toBeDefined();
    expect(borrowed?.getConnectionsCount()).toBe(0);
    if (borrowed) await instanceB.unloadDocument(borrowed);
    expect(instanceB.documents.has(META_DOC)).toBe(false);

    await onA.disconnect();
  }, 60_000);
});
