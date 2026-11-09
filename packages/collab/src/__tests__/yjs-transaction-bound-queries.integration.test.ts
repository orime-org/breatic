// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Queries issued through `yjsDb` while a Yjs transaction is open in the same
 * async flow run on that transaction's connection (inner#1917), as `db` does
 * for the product database.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { createTestDb, env, initCore, yjsDb, yjsDocuments } from "@breatic/core";

const names = new Set<string>();
let inspection: ReturnType<typeof createTestDb>;

beforeAll(() => {
  initCore(process.env);
  inspection = createTestDb(inject("YJS_DATABASE_URL"));
});

afterEach(async () => {
  if (names.size > 0) await inspection.db.delete(yjsDocuments).where(inArray(yjsDocuments.name, [...names]));
  names.clear();
});

afterAll(async () => {
  await inspection.client.end();
});

/**
 * A fresh document name, removed after the test.
 * @returns The name.
 */
function docName(): string {
  const name = `project-${randomUUID()}/meta`;
  names.add(name);
  return name;
}

/**
 * Write a document row through `yjsDb` itself, never through a `tx` argument.
 * @param name - The document name.
 */
async function insertThroughYjsDb(name: string): Promise<void> {
  await yjsDb.insert(yjsDocuments).values({ name, data: Buffer.from([1]) });
}

/**
 * Whether a separate client sees the committed row.
 * @param name - The document name.
 * @returns True when the row is committed.
 */
async function committed(name: string): Promise<boolean> {
  const rows = await inspection.db.select({ name: yjsDocuments.name }).from(yjsDocuments).where(eq(yjsDocuments.name, name));
  return rows.length > 0;
}

describe("Yjs transaction-bound queries (inner#1917)", () => {
  it("runs a yjsDb query inside a Yjs transaction on that transaction", async () => {
    const written = docName();
    await expect(yjsDb.transaction(async () => {
      await insertThroughYjsDb(written);
      const seen = await yjsDb.select({ name: yjsDocuments.name }).from(yjsDocuments).where(eq(yjsDocuments.name, written));
      expect(seen).toHaveLength(1);
      throw new Error("roll back");
    })).rejects.toThrow("roll back");
    expect(await committed(written)).toBe(false);
  });

  it("runs a nested Yjs transaction as a savepoint", async () => {
    const outer = docName();
    const inner = docName();
    await yjsDb.transaction(async () => {
      await insertThroughYjsDb(outer);
      await expect(yjsDb.transaction(async () => {
        expect(await yjsDb.select({ name: yjsDocuments.name }).from(yjsDocuments).where(eq(yjsDocuments.name, outer))).toHaveLength(1);
        await insertThroughYjsDb(inner);
        await insertThroughYjsDb(inner);
      })).rejects.toThrow();
    });
    expect(await committed(outer)).toBe(true);
    expect(await committed(inner)).toBe(false);
  });

  it("rolls back what a nested Yjs transaction and its parent wrote when the parent fails", async () => {
    const outer = docName();
    const inner = docName();
    await expect(yjsDb.transaction(async () => {
      await insertThroughYjsDb(outer);
      await yjsDb.transaction(() => insertThroughYjsDb(inner));
      throw new Error("parent fails");
    })).rejects.toThrow("parent fails");
    expect(await committed(outer)).toBe(false);
    expect(await committed(inner)).toBe(false);
  });

  it("sends work that outlives its Yjs transaction to the pool", async () => {
    const late = docName();
    let later: Promise<void> | undefined;
    await yjsDb.transaction(async () => {
      later = new Promise((resolve) => setTimeout(resolve, 50))
        .then(() => yjsDb.transaction(() => insertThroughYjsDb(late)));
    });
    await later;
    expect(await committed(late)).toBe(true);
  });

  it("keeps work that outlives nested Yjs transactions on the nearest parent that is still open", async () => {
    const outer = docName();
    const late = docName();
    let seen = 0;
    await expect(yjsDb.transaction(async () => {
      await insertThroughYjsDb(outer);
      let later: Promise<void> | undefined;
      await yjsDb.transaction(() => yjsDb.transaction(async () => {
        later = new Promise((resolve) => setTimeout(resolve, 50)).then(async () => {
          seen = (await yjsDb.select({ name: yjsDocuments.name }).from(yjsDocuments).where(eq(yjsDocuments.name, outer))).length;
          await insertThroughYjsDb(late);
        });
      }));
      await later;
      throw new Error("parent fails");
    })).rejects.toThrow("parent fails");
    expect(seen).toBe(1);
    expect(await committed(late)).toBe(false);
  });

  it("finishes twice as many Yjs transactions at once as the pool has connections", async () => {
    const count = env.YJS_DB_POOL_SIZE * 2;
    const written = Array.from({ length: count }, () => docName());
    await Promise.all(written.map((name) => yjsDb.transaction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await insertThroughYjsDb(name);
    })));
    expect(await Promise.all(written.map(committed))).toEqual(written.map(() => true));
  }, 15_000);
});
