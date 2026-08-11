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
 *
 * WHAT THIS TEST DOES NOT ASSERT: how long the answer takes. It used to, with
 * a 500ms ceiling. That matched no promise we make — a Space is expected to
 * work once it is open, not to open within any particular time — and loading a
 * document another instance holds involves a wait that is a compromise rather
 * than a guarantee, so the number it measured was never a verdict on the code.
 * Two unrelated branches went red before anyone read it closely.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import * as Y from "yjs";

import { initCore, createRedisClient } from "@breatic/core";
import * as yjsRepo from "@breatic/collab/src/services/yjs-documents.repo.js";
import { createPersistenceExtension } from "@breatic/collab/src/services/persistence.js";
import { readProjectSpaceIds } from "@breatic/collab/src/services/project-space-list.js";
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
 * Direct connections opened by the body of a test, closed by `afterEach`.
 *
 * They are tracked here rather than closed at the end of the test body because
 * a failing assertion skips everything after it. An unclosed direct connection
 * keeps its document loaded — `getConnectionsCount()` counts direct connections
 * alongside websockets — and `destroy()` waits for the document count to reach
 * zero, so one skipped close turns a failed assertion into a hook that hangs
 * until the runner kills it.
 */
const openConnections: Array<{ disconnect: () => Promise<unknown> }> = [];

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
 * What the Space-existence check answers on this instance. Calls the real
 * `readProjectSpaceIds` rather than restating it, so the two tests below cover
 * both of its branches: the instance that holds the meta doc, and the one that
 * has to load it.
 * @param instance - The collab instance to ask.
 * @returns The ids it answers with.
 */
async function spaceIdsSeenBy(instance: Hocuspocus): Promise<string[]> {
  const ids = await readProjectSpaceIds(
    PID,
    instance,
    new Request("http://localhost"),
    "space-existence-check",
  );
  return [...ids];
}

beforeAll(async () => {
  initCore(process.env);
  instanceA = await startInstance("itest-a");
  instanceB = await startInstance("itest-b");
}, 60_000);

afterEach(async () => {
  for (const c of openConnections.splice(0)) {
    await c.disconnect().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const s of servers) await s.destroy();
}, 60_000);

describe("Space existence across two collab instances", () => {
  it("sees a Space that only the other instance's memory knows about", async () => {
    await seedStoredMeta([STORED_SPACE]);

    // Instance A holds the meta doc and gains a Space the way `space:create`
    // does: in memory, broadcast, with nothing written to Postgres.
    const onA = await instanceA.openDirectConnection(META_DOC, {
      context: { user: { id: "system" } },
    });
    openConnections.push(onA);
    await onA.transact((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(MEMORY_ONLY_SPACE, entry);
      entry.set("id", MEMORY_ONLY_SPACE);
    });

    // Instance B holds nothing for this project — the reconnect shape. If it
    // decided from the stored row it would miss the new Space entirely, which
    // is what #26 was.
    const seenOnB = await spaceIdsSeenBy(instanceB);

    expect(seenOnB).toContain(STORED_SPACE);
    expect(seenOnB).toContain(MEMORY_ONLY_SPACE);

    // `readProjectSpaceIds` unloads what it loaded, scheduled rather than
    // awaited. Waiting for it here keeps the next test from starting against a
    // half-unloaded document.
    await vi.waitFor(
      () => {
        expect(instanceB.documents.has(META_DOC)).toBe(false);
      },
      { timeout: 10_000 },
    );
  }, 60_000);

  it("answers from the doc this instance already holds, without loading", async () => {
    await seedStoredMeta([STORED_SPACE]);

    // The other half of #26: `space:create` writes the new id into THIS
    // instance's meta doc, and the existence check that follows runs on that
    // same instance. Deciding from storage there refuses a Space this very
    // process just announced. (Which half produced more refusals in the logs is
    // the other one — the reconnect, covered by the test above.)
    const onA = await instanceA.openDirectConnection(META_DOC, {
      context: { user: { id: "system" } },
    });
    openConnections.push(onA);
    await onA.transact((live: Y.Doc) => {
      const entry = new Y.Map<unknown>();
      live.getMap("spaces").set(MEMORY_ONLY_SPACE, entry);
      entry.set("id", MEMORY_ONLY_SPACE);
    });
    expect(instanceA.documents.has(META_DOC)).toBe(true);

    // The spy pins the path, not the answer. Loading again would return this
    // very document — `createDocument` resolves a held one without running a
    // single load hook (`hocuspocus-server.cjs:1453`) — so the two paths agree
    // on what they answer, and the assertions below would pass either way.
    // Where they differ is the end of the loading path: it schedules an unload
    // of what it read. Taking that path for a document someone else is using
    // hands their document to `unloadDocument`, and that is what this pins.
    const load = vi.spyOn(instanceA, "createDocument");
    const seenOnA = await spaceIdsSeenBy(instanceA);
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();

    expect(seenOnA).toContain(STORED_SPACE);
    expect(seenOnA).toContain(MEMORY_ONLY_SPACE);
    // Still held: this path has nothing to unload, so it must not have.
    expect(instanceA.documents.has(META_DOC)).toBe(true);
  }, 60_000);
});
