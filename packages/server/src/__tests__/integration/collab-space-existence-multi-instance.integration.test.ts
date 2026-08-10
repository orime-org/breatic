// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Two collab instances, one Redis, one Postgres — the topology production
 * actually runs (#26).
 *
 * The Space-existence check answers from the meta doc this process holds, and
 * loads it when it holds none. Everything about whether that is correct across
 * instances lives in what the load produces: Postgres hands back a row that
 * may be a store tick behind, and `@hocuspocus/extension-redis` then asks the
 * peers for anything newer. Reading the library and reasoning about the window
 * is not the same as running it, so this runs it.
 *
 * The shape under test is the one the logs show (2026-08-10 11:13:21): an
 * instance restarts, a browser that has already synced reconnects every open
 * document at once, and the content-doc handshakes arrive before the meta doc
 * is loaded here.
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
/** Already in Postgres before anything starts. */
const OLD_SPACE = "55555555-5555-4555-8555-555555555555";
/** Created in one instance's memory only — never stored. */
const NEW_SPACE = "66666666-6666-4666-8666-666666666666";

let instanceA: Hocuspocus;
let instanceB: Hocuspocus;
const servers: Array<{ destroy: () => Promise<void> }> = [];

/**
 * Build one collab instance wired the way production wires it: the change
 * tracker, the persistence extension, and the Redis extension over the
 * instance-coordination database.
 * @param name - Used only to tell the two apart in a Redis client name.
 * @returns The running server's Hocuspocus instance.
 */
async function startInstance(name: string): Promise<Hocuspocus> {
  const collabUrl = process.env.REDIS_COLLAB_URL;
  if (!collabUrl) throw new Error("REDIS_COLLAB_URL missing from the integration env");
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
 * Put a meta row in Postgres listing exactly the given Spaces — the state the
 * fallback would decide from.
 * @param ids - Space ids the stored row claims exist.
 */
async function seedPersistedMeta(ids: string[]): Promise<void> {
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
 * The Space ids a freshly loaded meta doc reports on this instance.
 * @param instance - The collab instance to ask.
 * @returns The ids, and how long getting them took.
 */
async function readSpacesVia(
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
      { readOnly: true },
      {},
    ));
  const ids = [...doc.getMap("spaces").keys()];
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ids, ms };
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
    await seedPersistedMeta([OLD_SPACE]);

    // Instance A holds the meta doc and gains a Space the way `space:create`
    // does: in memory, broadcast, with nothing written to Postgres.
    const onA = await instanceA.openDirectConnection(META_DOC, {
      context: { user: { id: "system" } },
    });
    await onA.transact((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(NEW_SPACE, entry);
      entry.set("id", NEW_SPACE);
    });

    // Give the pub/sub a beat — this is the propagation the design leans on.
    await new Promise((r) => setTimeout(r, 300));

    // Instance B holds nothing for this project. This is the reconnect shape.
    const seenOnB = await readSpacesVia(instanceB);

    // eslint-disable-next-line no-console
    console.log("MEASURED B:", JSON.stringify(seenOnB));

    expect(seenOnB.ids).toContain(OLD_SPACE);
    expect(seenOnB.ids).toContain(NEW_SPACE);

    // A document loaded with no connection is never unloaded on its own:
    // `unloadDocument` is only reached from a closing client connection or a
    // finishing store, and neither happens here. Whoever loads it has to put
    // it back, or `getDocumentsCount()` never returns to zero — which is also
    // what `Server.destroy()` waits for.
    const strandedOnB = instanceB.documents.get(META_DOC);
    expect(strandedOnB).toBeDefined();
    expect(strandedOnB?.getConnectionsCount()).toBe(0);
    const unloadStarted = process.hrtime.bigint();
    if (strandedOnB) await instanceB.unloadDocument(strandedOnB);
    // eslint-disable-next-line no-console
    console.log(
      "MEASURED unload ms:",
      Number(process.hrtime.bigint() - unloadStarted) / 1e6,
      "| documents left on B:",
      instanceB.getDocumentsCount(),
    );
    expect(instanceB.documents.has(META_DOC)).toBe(false);

    const disconnectStarted = process.hrtime.bigint();
    await onA.disconnect();
    // eslint-disable-next-line no-console
    console.log(
      "MEASURED openDirectConnection disconnect ms:",
      Number(process.hrtime.bigint() - disconnectStarted) / 1e6,
    );
  }, 60_000);
});
