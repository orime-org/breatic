// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * E2E smoke — the real collab persistence extension round-trips a Yjs
 * doc through Postgres via the unified core `yjsDocumentsRepo`.
 *
 * Yjs collaboration is a critical path; this PR re-pointed collab's
 * persistence from a hand-rolled postgres.js pool to the shared core
 * repo. canvas-native-e2e boots Hocuspocus with NO persistence
 * extension (in-memory docs), so it can't cover this. Here we boot a
 * real Hocuspocus Server WITH `createPersistenceExtension()` and prove
 * the full path against a real testcontainer PG:
 *
 *   write through Hocuspocus → store() → yjsDocumentsRepo.upsertDocData
 *     → yjs_documents row;  reload → fetch() → yjsDocumentsRepo.fetchDocData
 *     → the state comes back;  soft-delete the row → reload sees nothing
 *     (the deleted_at filter is load-bearing — a stale client can't
 *     recover a deleted doc).
 *
 * NOTE: process.env is set by integration-setup.ts; initCore(process.env)
 * runs before any real-core access. The persistence extension imports
 * the real core barrel — fine under this config's otel→CJS alias.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  inject,
} from "vitest";
import { Server } from "@hocuspocus/server";
import type { Hocuspocus } from "@hocuspocus/server";
import * as Y from "yjs";
import { eq } from "drizzle-orm";

import {
  initCore,
  schema,
  createTestDb,
  yjsDocumentsRepo,
} from "@breatic/core";
import { createPersistenceExtension } from "@breatic/collab/src/services/persistence.js";

initCore(process.env);

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
  }
}

const DOC = "project-dddddddd-dddd-4ddd-8ddd-dddddddddddd/canvas-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wsServer: any; // @hocuspocus/server Server — `any` to dodge dup-type issues
let hocuspocus: Hocuspocus;
let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

/**
 * Poll until `check` is true or the timeout elapses (store() is async,
 * firing after the doc unloads on the last disconnect).
 * @param check - Predicate polled every 50ms.
 * @param timeoutMs - Max wait before throwing.
 * @param label - Error label when the condition is never met.
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
 * @param mutate - Mutation applied inside the doc transaction.
 */
async function writeAndPersist(mutate: (doc: Y.Doc) => void): Promise<void> {
  const conn = await hocuspocus.openDirectConnection(DOC, {
    context: { user: { id: "system" }, source: "test" },
  });
  await conn.transact(mutate);
  await conn.disconnect();
}

beforeAll(async () => {
  const DATABASE_URL = inject("DATABASE_URL");
  ({ db, client: pgClient } = createTestDb(DATABASE_URL));
  await db.delete(schema.yjsDocuments).where(eq(schema.yjsDocuments.name, DOC));

  // Real Hocuspocus with the REAL unified persistence extension. Small
  // debounce + unloadImmediately so store() fires promptly on disconnect.
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
  await db.delete(schema.yjsDocuments).where(eq(schema.yjsDocuments.name, DOC));
  await pgClient.end();
});

describe("collab persistence round-trip (real Hocuspocus + real PG)", () => {
  it("persists a written doc to yjs_documents and reloads it after unload", async () => {
    await writeAndPersist((doc) => {
      doc.getMap("nodes").set("n1", "hello");
    });

    // store() lands a row in PG via the core repo.
    await waitFor(
      async () => (await yjsDocumentsRepo.fetchDocData(DOC)) !== null,
      5000,
      "doc persisted to PG",
    );

    // Reload into a fresh Y.Doc from the persisted bytes — proves fetch()
    // reads back through the repo.
    const bytes = await yjsDocumentsRepo.fetchDocData(DOC);
    expect(bytes).not.toBeNull();
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, new Uint8Array(bytes!));
    expect(reloaded.getMap("nodes").get("n1")).toBe("hello");
  });

  it("a soft-deleted doc reads back as absent (deleted_at filter)", async () => {
    await writeAndPersist((doc) => {
      doc.getMap("nodes").set("n2", "world");
    });
    await waitFor(
      async () => (await yjsDocumentsRepo.fetchDocData(DOC)) !== null,
      5000,
      "doc persisted before soft-delete",
    );

    const changed = await yjsDocumentsRepo.softDeleteByName(DOC);
    expect(changed).toBe(true);
    // The persistence fetch path filters soft-deleted rows.
    expect(await yjsDocumentsRepo.fetchDocData(DOC)).toBeNull();
  });
});
