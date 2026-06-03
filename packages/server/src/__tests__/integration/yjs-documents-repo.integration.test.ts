// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Integration test — the core `yjs_documents` repo against a real
 * Postgres (testcontainer).
 *
 * `yjs_documents` is shared infra with a single repo home in
 * `@breatic/core`; the collab persistence / auth / space-rpc paths and
 * the server project create / delete / duplicate cascade all route
 * through it. This pins the load-bearing SQL invariants against real PG:
 *
 *   - fetch filters soft-deleted rows (a stale client can't recover a
 *     deleted doc);
 *   - upsert resurrects a soft-deleted row (clears `deleted_at`);
 *   - softDelete is idempotent + returns whether a row changed;
 *   - restore clears `deleted_at`;
 *   - insertInitialState writes inside the caller's transaction;
 *   - the project-prefix cascade soft-delete + duplicate-with-rewrite.
 *
 * The repo uses the env-bound `db` singleton (initCore'd to the
 * container); a separate `createTestDb` client seeds + reads raw row
 * state. Rows are scoped to dedicated test project ids so the suite
 * never collides with other integration files sharing the container.
 *
 * NOTE: process.env is set by integration-setup.ts (setupFiles); we
 * call initCore(process.env) before any real-core access. Importing the
 * core barrel here does NOT pull the `ai` SDK (it moved to
 * @breatic/domain), so no otel mock is needed beyond the config's alias.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  inject,
} from "vitest";
import { eq, like, or } from "drizzle-orm";

import {
  initCore,
  schema,
  createTestDb,
  yjsDocumentsRepo,
  db as coreDb,
} from "@breatic/core";

initCore(process.env);

// Declare the shape of values provided by globalSetup.setup() via provide().
declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
    REDIS_URL: string;
    REDIS_QUEUE_URL: string;
    REDIS_STREAM_URL: string;
  }
}

const TEST_PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_DUP_PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const META = `project-${TEST_PID}/meta`;
const CANVAS = `project-${TEST_PID}/canvas-${SID}`;

let pgClient: ReturnType<typeof createTestDb>["client"];
let db: ReturnType<typeof createTestDb>["db"];

/** Delete only this suite's rows so it can't collide with other files. */
async function cleanup(): Promise<void> {
  await db
    .delete(schema.yjsDocuments)
    .where(
      or(
        like(schema.yjsDocuments.name, `project-${TEST_PID}/%`),
        like(schema.yjsDocuments.name, `project-${TEST_DUP_PID}/%`),
      ),
    );
}

/** Read the raw row (including `deletedAt`) for a doc name, or null. */
async function rawRow(name: string) {
  const rows = await db
    .select()
    .from(schema.yjsDocuments)
    .where(eq(schema.yjsDocuments.name, name))
    .limit(1);
  return rows[0] ?? null;
}

beforeAll(() => {
  const DATABASE_URL = inject("DATABASE_URL");
  ({ db, client: pgClient } = createTestDb(DATABASE_URL));
});

afterAll(async () => {
  await cleanup();
  await pgClient.end();
});

beforeEach(cleanup);

describe("yjsDocumentsRepo (real Postgres)", () => {
  it("fetchDocData returns stored bytes, then null once the row is soft-deleted", async () => {
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([1, 2, 3, 4]));
    const got = await yjsDocumentsRepo.fetchDocData(CANVAS);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3, 4]);

    const changed = await yjsDocumentsRepo.softDeleteByName(CANVAS);
    expect(changed).toBe(true);
    // The deleted row is invisible to fetch (stale client can't recover it).
    expect(await yjsDocumentsRepo.fetchDocData(CANVAS)).toBeNull();
  });

  it("upsertDocData resurrects a soft-deleted row (clears deleted_at) and overwrites data", async () => {
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    await yjsDocumentsRepo.softDeleteByName(CANVAS);

    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([9, 9]));

    const got = await yjsDocumentsRepo.fetchDocData(CANVAS);
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([9, 9]);
    const row = await rawRow(CANVAS);
    expect(row?.deletedAt).toBeNull();
  });

  it("softDeleteByName is idempotent (second call returns false)", async () => {
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    expect(await yjsDocumentsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsDocumentsRepo.softDeleteByName(CANVAS)).toBe(false);
  });

  it("restoreByName clears deleted_at so fetch sees the row again", async () => {
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([7]));
    await yjsDocumentsRepo.softDeleteByName(CANVAS);
    expect(await yjsDocumentsRepo.fetchDocData(CANVAS)).toBeNull();

    await yjsDocumentsRepo.restoreByName(CANVAS);
    const got = await yjsDocumentsRepo.fetchDocData(CANVAS);
    expect(Array.from(got!)).toEqual([7]);
  });

  it("insertInitialState writes a row inside the caller's transaction", async () => {
    await coreDb.transaction(async (tx) => {
      await yjsDocumentsRepo.insertInitialState(tx, META, new Uint8Array([5, 5, 5]));
    });
    const got = await yjsDocumentsRepo.fetchDocData(META);
    expect(Array.from(got!)).toEqual([5, 5, 5]);
  });

  it("softDeleteByProjectPrefix soft-deletes meta + every space doc of the project", async () => {
    await yjsDocumentsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([2]));

    await coreDb.transaction(async (tx) => {
      await yjsDocumentsRepo.softDeleteByProjectPrefix(tx, TEST_PID);
    });

    expect(await yjsDocumentsRepo.fetchDocData(META)).toBeNull();
    expect(await yjsDocumentsRepo.fetchDocData(CANVAS)).toBeNull();
  });

  it("duplicateByProjectPrefix copies every doc to the new project id, rewriting the prefix, leaving originals intact", async () => {
    await yjsDocumentsRepo.upsertDocData(META, new Uint8Array([1, 1]));
    await yjsDocumentsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));

    await coreDb.transaction(async (tx) => {
      await yjsDocumentsRepo.duplicateByProjectPrefix(tx, TEST_PID, TEST_DUP_PID);
    });

    const dupMeta = await yjsDocumentsRepo.fetchDocData(
      `project-${TEST_DUP_PID}/meta`,
    );
    const dupCanvas = await yjsDocumentsRepo.fetchDocData(
      `project-${TEST_DUP_PID}/canvas-${SID}`,
    );
    expect(Array.from(dupMeta!)).toEqual([1, 1]);
    expect(Array.from(dupCanvas!)).toEqual([2, 2]);
    // Originals untouched.
    expect(Array.from((await yjsDocumentsRepo.fetchDocData(META))!)).toEqual([
      1, 1,
    ]);
  });
});
