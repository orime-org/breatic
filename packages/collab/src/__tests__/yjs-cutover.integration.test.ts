// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Integration test — the yjs two-DB cutover against REAL Postgres.
 *
 * After the cutover the `yjs_documents` repo lives in `@breatic/collab`
 * and targets a SEPARATE database (`yjsDb` / YJS_DATABASE_URL). This
 * pins the load-bearing behaviour the cutover depends on, against a real
 * second PG database (the shared container setup creates `breatic_yjs_test` in the same
 * container + migrates it):
 *
 *   - repo round-trip on the yjs DB (fetch / upsert / soft-delete /
 *     restore / seed) — recreated from the old core-repo test;
 *   - duplicate integrity: prefix-rewrite (with the load-bearing ::int
 *     cast), meta `DO UPDATE` winning over a racing lazy-seed, canvas
 *     `DO NOTHING` idempotency on redelivery, originals untouched;
 *   - CROSS-DB CANARY: a business-DB transaction ROLLBACK does not roll
 *     back an already-committed yjs-DB write — proving the two are
 *     genuinely separate databases (and doubling as the
 *     YJS_DATABASE_URL==DATABASE_URL misconfig detector: under a
 *     same-db misconfig this test would fail).
 *
 * The repo binds the env-bound `yjsDb` singleton (initCore'd to the
 * container); a separate `createTestDb(yjsUrl)` reads raw row state.
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
import * as Y from "yjs";

import {
  initCore,
  yjsDocuments,
  createTestDb,
  db as coreDb,
  encodeInitialMetaState,
  writeSpaceEntry,
} from "@breatic/core";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

initCore(process.env);

const TEST_PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEST_DUP_PID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const META = `project-${TEST_PID}/meta`;
const CANVAS = `project-${TEST_PID}/canvas-${SID}`;

let pgClient: ReturnType<typeof createTestDb>["client"];
let yjsTestDb: ReturnType<typeof createTestDb>["db"];

/** Delete only this suite's rows from the yjs DB so it can't collide. */
async function cleanup(): Promise<void> {
  await yjsTestDb
    .delete(yjsDocuments)
    .where(
      or(
        like(yjsDocuments.name, `project-${TEST_PID}/%`),
        like(yjsDocuments.name, `project-${TEST_DUP_PID}/%`),
      ),
    );
}

/** Read the raw yjs row (including `deletedAt`) for a doc name, or null. */
async function rawRow(
  name: string,
): Promise<{ deletedAt: Date | null; updatedAt: Date | null } | null> {
  const rows = await yjsTestDb
    .select()
    .from(yjsDocuments)
    .where(eq(yjsDocuments.name, name))
    .limit(1);
  return rows[0] ?? null;
}

beforeAll(() => {
  // The raw read/seed client points at the SEPARATE yjs database.
  ({ db: yjsTestDb, client: pgClient } = createTestDb(inject("YJS_DATABASE_URL")));
});

afterAll(async () => {
  await cleanup();
  await pgClient.end();
});

beforeEach(cleanup);

describe("yjs repo against the separate yjs DB", () => {
  it("fetch returns stored bytes, then null once soft-deleted", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1, 2, 3, 4]));
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([1, 2, 3, 4]);

    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsRepo.fetchDocData(CANVAS)).toBeNull();
  });

  it("a store after a soft-delete keeps the row deleted and writes the content into it", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    await yjsRepo.softDeleteByName(CANVAS);
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([9, 9]));
    expect(await yjsRepo.fetchDocData(CANVAS)).toBeNull();
    expect((await rawRow(CANVAS))?.deletedAt).not.toBeNull();
    // A restore later brings back the latest content, not the content at deletion.
    await yjsRepo.restoreByName(CANVAS);
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([9, 9]);
  });

  it("softDeleteByName is idempotent (second call returns false)", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([1]));
    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(true);
    expect(await yjsRepo.softDeleteByName(CANVAS)).toBe(false);
  });

  it("restoreByName clears deleted_at so fetch sees the row again", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([7]));
    await yjsRepo.softDeleteByName(CANVAS);
    await yjsRepo.restoreByName(CANVAS);
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([7]);
  });

  it("restoreByName moves updated_at to the restore", async () => {
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([7]));
    await yjsTestDb
      .update(yjsDocuments)
      .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(yjsDocuments.name, CANVAS));
    await yjsRepo.softDeleteByName(CANVAS);
    const before = Date.now();
    await yjsRepo.restoreByName(CANVAS);
    expect((await rawRow(CANVAS))!.updatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("counts only live Space content docs, not other rows under the project", async () => {
    await yjsRepo.upsertDocData(META, new Uint8Array([1]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2]));
    await yjsRepo.upsertDocData(`project-${TEST_PID}/canvas`, new Uint8Array([3]));
    await yjsRepo.upsertDocData(`project-${TEST_PID}/node/n1`, new Uint8Array([4]));

    expect(await yjsRepo.countLiveSpaceDocs(TEST_PID)).toBe(1);
  });

  it("seedInitialState inserts once and is idempotent under a race (DO NOTHING)", async () => {
    const bytes = encodeInitialMetaState({
      spaceId: SID,
      kind: "canvas",
      name: "Canvas",
      createdBy: "system",
      ts: 1,
    });
    expect(await yjsRepo.seedInitialState(META, bytes)).toBe(true);
    // Second seed (lazy-seed race loser) does NOT overwrite + reports false.
    expect(await yjsRepo.seedInitialState(META, new Uint8Array([0]))).toBe(false);
    expect(Array.from((await yjsRepo.fetchDocData(META))!)).toEqual(Array.from(bytes));
  });
});

describe("duplicate integrity", () => {
  const DUP_META = `project-${TEST_DUP_PID}/meta`;
  const DUP_CANVAS = `project-${TEST_DUP_PID}/canvas-${SID}`;
  const TRASHED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const UNSTORED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  /**
   * A source meta listing exactly the given canvas Spaces.
   * @param spaceIds - The Spaces the meta lists.
   * @returns The encoded meta state.
   */
  function metaListing(spaceIds: readonly string[]): Uint8Array {
    const doc = new Y.Doc();
    const spaces = doc.getMap("spaces");
    spaceIds.forEach((spaceId, order) =>
      writeSpaceEntry(spaces, {
        spaceId,
        type: "canvas",
        name: `Space ${order}`,
        order,
        createdAt: 1,
        createdBy: "system",
      }),
    );
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    return bytes;
  }

  /**
   * Live content rows under the duplicate project, meta excluded.
   * @returns Their names, sorted.
   */
  async function liveDuplicateContent(): Promise<string[]> {
    const rows = await yjsTestDb
      .select()
      .from(yjsDocuments)
      .where(like(yjsDocuments.name, `project-${TEST_DUP_PID}/%`));
    return rows
      .filter((r) => r.name !== DUP_META && r.deletedAt === null)
      .map((r) => r.name)
      .sort();
  }

  it("copies the meta and the content of the Spaces it lists, originals intact", async () => {
    const meta = metaListing([SID]);
    await yjsRepo.upsertDocData(META, meta);
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual(Array.from(meta));
    expect(Array.from((await yjsRepo.fetchDocData(DUP_CANVAS))!)).toEqual([2, 2]);
    // Source untouched.
    expect(Array.from((await yjsRepo.fetchDocData(META))!)).toEqual(Array.from(meta));
  });

  it("leaves out the content of Spaces the source meta does not list", async () => {
    await yjsRepo.upsertDocData(META, metaListing([SID]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));
    // In the source's trash.
    await yjsRepo.upsertDocData(`project-${TEST_PID}/canvas-${TRASHED}`, new Uint8Array([3]));
    await yjsRepo.softDeleteByName(`project-${TEST_PID}/canvas-${TRASHED}`);
    // Created moments ago: its row exists, the stored meta does not list it yet.
    await yjsRepo.upsertDocData(`project-${TEST_PID}/canvas-${UNSTORED}`, new Uint8Array([4]));

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    expect(await liveDuplicateContent()).toEqual([DUP_CANVAS]);
  });

  it("copies a listed Space live even when its source row was already soft-deleted", async () => {
    // Deleted moments ago: its row is soft-deleted, the stored meta still lists it.
    await yjsRepo.upsertDocData(META, metaListing([SID]));
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));
    await yjsRepo.softDeleteByName(CANVAS);

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    expect(Array.from((await yjsRepo.fetchDocData(DUP_CANVAS))!)).toEqual([2, 2]);
  });

  it("copies the meta it chose the content from, even when a store lands in between", async () => {
    // A store of the source meta committing while the copy runs: the trigger
    // rewrites the source meta the moment the first content row is copied,
    // which is the window between reading the meta and writing the copy.
    const meta = metaListing([SID]);
    const later = metaListing([SID, UNSTORED]);
    await yjsRepo.upsertDocData(META, meta);
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));
    await pgClient.unsafe(`
      CREATE FUNCTION test_store_meta_mid_copy() RETURNS trigger AS $$
      BEGIN
        UPDATE yjs_documents SET data = decode('${Buffer.from(later).toString("hex")}', 'hex')
        WHERE name = '${META}';
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_store_meta_mid_copy AFTER INSERT ON yjs_documents
      FOR EACH ROW WHEN (NEW.name = '${DUP_CANVAS}')
      EXECUTE FUNCTION test_store_meta_mid_copy();
    `);
    try {
      await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);
    } finally {
      await pgClient.unsafe(`
        DROP TRIGGER test_store_meta_mid_copy ON yjs_documents;
        DROP FUNCTION test_store_meta_mid_copy();
      `);
    }

    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual(Array.from(meta));
    expect(await liveDuplicateContent()).toEqual([DUP_CANVAS]);
  });

  it("meta DO UPDATE wins over a racing lazy-seed; redelivery is idempotent", async () => {
    const meta = metaListing([SID]);
    await yjsRepo.upsertDocData(META, meta);
    await yjsRepo.upsertDocData(CANVAS, new Uint8Array([2, 2]));
    // Simulate a lazy-seed having already written a DEFAULT meta at the
    // new project id before the duplicate command is consumed.
    await yjsRepo.seedInitialState(DUP_META, new Uint8Array([255]));

    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);

    // The source meta must WIN (DO UPDATE), not the lazy-seeded default.
    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual(Array.from(meta));

    // Redelivery copies nothing new (content DO NOTHING) and re-writes the
    // same source meta — net unchanged.
    await yjsRepo.duplicateByProjectPrefix(TEST_PID, TEST_DUP_PID);
    expect(Array.from((await yjsRepo.fetchDocData(DUP_META))!)).toEqual(Array.from(meta));
    expect(Array.from((await yjsRepo.fetchDocData(DUP_CANVAS))!)).toEqual([2, 2]);
  });
});

describe("cross-DB isolation (canary + misconfig detector)", () => {
  it("a business-tx ROLLBACK does not roll back an already-committed yjs write", async () => {
    await expect(
      coreDb.transaction(async () => {
        // This write goes to the SEPARATE yjs DB, outside the business tx.
        await yjsRepo.upsertDocData(CANVAS, new Uint8Array([42]));
        throw new Error("force business rollback");
      }),
    ).rejects.toThrow("force business rollback");

    // The yjs write survived the business rollback — proves two separate
    // databases (would FAIL under a YJS_DATABASE_URL==DATABASE_URL misconfig).
    expect(Array.from((await yjsRepo.fetchDocData(CANVAS))!)).toEqual([42]);
  });
});
