// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * E2E smoke — the real collab persistence extension + lazy-seed round-trip
 * a Yjs doc through the SEPARATE yjs Postgres, via a real Hocuspocus.
 *
 * Yjs collaboration is a critical path. canvas-native-e2e boots Hocuspocus
 * with NO persistence (in-memory docs), so it can't cover this. Here we
 * boot a real Hocuspocus Server WITH `createPersistenceExtension()` and
 * prove the full path against the real `breatic_yjs_test` database:
 *
 *   - INVARIANT 1 (project exists ⇒ ≥1 Space): opening a FRESH
 *     `project-{id}/meta` doc (no row — create no longer eager-seeds)
 *     triggers the lazy-seed via fetchDoc, so the loaded doc already
 *     carries one default canvas Space;
 *   - persistence round-trip: a write through Hocuspocus → store() →
 *     repo → yjs_documents row; reload → fetch() → the state comes back;
 *   - soft-delete → reload sees nothing (the deleted_at filter is
 *     load-bearing — a stale client can't recover a deleted doc).
 *
 * The persistence extension imports the real core barrel — fine under
 * this config's otel→CJS alias (the `ai` SDK moved to @breatic/domain).
 */

import { describe, it, expect, beforeAll, afterAll, inject } from "vitest";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { eq } from "drizzle-orm";

import { initCore, yjsDocuments, createTestDb } from "@breatic/core";
import * as yjsRepo from "@breatic/collab/src/services/yjs-documents.repo.js";
import { createPersistenceExtension } from "@breatic/collab/src/services/persistence.js";

initCore(process.env);

const PID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const META = `project-${PID}/meta`;
const CANVAS = `project-${PID}/canvas-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wsServer: any; // @hocuspocus/server Server — `any` to dodge dup-type issues
let hocuspocus: Hocuspocus;
let pgClient: ReturnType<typeof createTestDb>["client"];
let yjsTestDb: ReturnType<typeof createTestDb>["db"];

/**
 * Poll until `check` is true or the timeout elapses (store() is async,
 * firing after the doc unloads on the last disconnect).
 * @param check - Predicate polled every 50ms
 * @param timeoutMs - Max wait before throwing
 * @param label - Error label when the condition is never met
 */
async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error(`Condition '${label}' not met within ${timeoutMs}ms`);
}

/**
 * Open a doc, run `mutate` in a Yjs transaction, then disconnect so
 * Hocuspocus unloads the doc and persists it via store().
 * @param docName - Doc to open
 * @param mutate - Mutation applied inside the doc transaction
 */
async function writeAndPersist(
  docName: string,
  mutate: (doc: Y.Doc) => void,
): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(docName, {
    context: { user: { id: "system" }, source: "test" },
  });
  await conn.transact(mutate);
  await conn.disconnect();
}

beforeAll(async () => {
  ({ db: yjsTestDb, client: pgClient } = createTestDb(inject("YJS_DATABASE_URL")));
  await yjsTestDb.delete(yjsDocuments).where(eq(yjsDocuments.name, META));
  await yjsTestDb.delete(yjsDocuments).where(eq(yjsDocuments.name, CANVAS));

  wsServer = new Server({
    port: 0,
    quiet: true,
    debounce: 50,
    unloadImmediately: true,
    extensions: [createPersistenceExtension()],
  });
  hocuspocus = wsServer.hocuspocus;
  await wsServer.listen();
});

afterAll(async () => {
  await wsServer.destroy();
  await yjsTestDb.delete(yjsDocuments).where(eq(yjsDocuments.name, META));
  await yjsTestDb.delete(yjsDocuments).where(eq(yjsDocuments.name, CANVAS));
  await pgClient.end();
});

describe("collab persistence + lazy-seed round-trip (real Hocuspocus + real yjs PG)", () => {
  it("lazy-seeds a default Space when a fresh project's meta doc is first loaded (invariant 1)", async () => {
    // No row exists for META — opening it must lazy-seed one Space.
    const conn = await hocuspocus.openDirectConnection(META, {
      context: { user: { id: "system" }, source: "test" },
    });
    try {
      await conn.transact((doc) => {
        const spaces = doc.getMap("spaces");
        // The frontend's invariant: a freshly-opened project already has
        // at least one Space, so it never renders an empty canvas.
        expect(spaces.size).toBeGreaterThanOrEqual(1);
      });
    } finally {
      await conn.disconnect();
    }
  });

  it("persists a written canvas doc to the yjs DB and reloads it after unload", async () => {
    await writeAndPersist(CANVAS, (doc) => {
      doc.getMap("nodes").set("n1", "hello");
    });

    await waitFor(
      async () => (await yjsRepo.fetchDocData(CANVAS)) !== null,
      5000,
      "doc persisted to yjs PG",
    );

    const bytes = await yjsRepo.fetchDocData(CANVAS);
    expect(bytes).not.toBeNull();
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(bytes!));
    expect(reloaded.getMap("nodes").get("n1")).toBe("hello");
  });

  it("a soft-deleted doc reads back as absent (deleted_at filter)", async () => {
    await writeAndPersist(CANVAS, (doc) => {
      doc.getMap("nodes").set("n2", "world");
    });
    await waitFor(
      async () => (await yjsRepo.fetchDocData(CANVAS)) !== null,
      5000,
      "doc persisted before soft-delete",
    );

    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsRepo.fetchDocData(CANVAS)).toBeNull();
  });
});
