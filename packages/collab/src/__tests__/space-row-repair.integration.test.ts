// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The Space-row repair's apply statement against a real yjs database
 * (inner#1140). The script under `scripts/` is plain JavaScript run by tsx
 * outside any package, so this suite imports its plan module by path and runs
 * the very statement the script sends.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, inject } from "vitest";
import { eq, like } from "drizzle-orm";

import { initCore, yjsDocuments, createTestDb } from "@breatic/core";
import * as yjsRepo from "@collab/services/yjs-documents.repo.js";

initCore(process.env);

/** What the suite reads from the plan module. */
interface RepairPlan {
  APPLY_SQL: string;
  STALE_AFTER_MS: number;
}

const PID = "abababab-abab-4aba-8aba-abababababab";
const ROW = `project-${PID}/canvas-cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd`;
const HOUR_MS = 60 * 60 * 1000;

let plan: RepairPlan;
let pgClient: ReturnType<typeof createTestDb>["client"];
let yjsTestDb: ReturnType<typeof createTestDb>["db"];

/**
 * Set a row's `updated_at` to some time ago.
 * @param name - The row.
 * @param agoMs - How long ago.
 */
async function touchedAgo(name: string, agoMs: number): Promise<void> {
  await yjsTestDb
    .update(yjsDocuments)
    .set({ updatedAt: new Date(Date.now() - agoMs) })
    .where(eq(yjsDocuments.name, name));
}

/**
 * Run the apply statement on one row.
 * @param name - The row.
 * @returns How many rows it soft-deleted.
 */
async function apply(name: string): Promise<number> {
  const result = await pgClient.unsafe(plan.APPLY_SQL, [name, plan.STALE_AFTER_MS]);
  return result.count;
}

beforeAll(async () => {
  ({ db: yjsTestDb, client: pgClient } = createTestDb(inject("YJS_DATABASE_URL")));
  const url = new URL("../../../../scripts/repair-space-rows-plan.mjs", import.meta.url).href;
  plan = (await import(url)) as RepairPlan;
});

afterAll(async () => {
  await yjsTestDb.delete(yjsDocuments).where(like(yjsDocuments.name, `project-${PID}/%`));
  await pgClient.end();
});

beforeEach(async () => {
  await yjsTestDb.delete(yjsDocuments).where(like(yjsDocuments.name, `project-${PID}/%`));
  await yjsRepo.upsertDocData(ROW, new Uint8Array([1]));
});

describe("the Space-row repair's apply statement", () => {
  it("soft-deletes a live row nobody touched for longer than the stale age", async () => {
    await touchedAgo(ROW, 2 * HOUR_MS);

    expect(await apply(ROW)).toBe(1);
    expect(await yjsRepo.fetchDocData(ROW)).toBeNull();
  });

  it("leaves a row edited or restored after the report was made", async () => {
    // Stale when the report listed it; a store then moved updated_at.
    await touchedAgo(ROW, 2 * HOUR_MS);
    await yjsRepo.upsertDocData(ROW, new Uint8Array([2]));

    expect(await apply(ROW)).toBe(0);
    expect(Array.from((await yjsRepo.fetchDocData(ROW))!)).toEqual([2]);
  });

  it("leaves a row touched just inside the stale age", async () => {
    await touchedAgo(ROW, plan.STALE_AFTER_MS - 60_000);

    expect(await apply(ROW)).toBe(0);
  });

  it("leaves a row that is already soft-deleted", async () => {
    await touchedAgo(ROW, 2 * HOUR_MS);
    await yjsRepo.softDeleteByName(ROW);

    expect(await apply(ROW)).toBe(0);
  });
});
