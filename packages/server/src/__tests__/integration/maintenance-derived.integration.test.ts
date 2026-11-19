// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The reclaim consumer's `derived` rows (S6e E4-1, E4-8, E4-9; inner#1306 test plan §90; frames-split design §7.15
 * 回收队列、顺序门槛、仲裁).
 *
 * A `derived` row names one presentation object with no kept key, content hash, source or Studio. Its preconditions
 * at preview, approval and execution are: no live asset row references the key (`live_reference`), the protection
 * period counted from the row's `created_at` (`protection_period`), and no live presentation pin references the key
 * (`pinned`). The upload grant, canonical and kept-key head checks belong to `dedup_loser` rows only and are skipped.
 * The pin check is repeated before the delete, so a pin acquired after approval still saves the object; the scope,
 * preview and run snapshots carry `keptStorageKey: null`. The `dedup_loser` path is unchanged (the other maintenance
 * suites).
 */
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReclaimOperationView } from "@breatic/core";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest, type MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";
import { runMaintenanceLoopOnce } from "@server/modules/maintenance/maintenance-loop.js";
import { call, resetInternalRateLimit, useInternalApp } from "./internal-api-harness.js";
import { MaintenanceStorage, maintenanceWorld, requestKey } from "./maintenance.fixture.js";

const suite = useInternalApp("maintenance-derived");
const base = "/internal/v1/maintenance/reclaim";
const T = "c".repeat(64);
let instant: Date;
let storage: MaintenanceStorage;
let protectionSeconds: number;

beforeEach(async () => {
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews,storage_reclaim_queue`;
  instant = new Date("2030-01-01T00:00:00.000Z");
  storage = new MaintenanceStorage();
  protectionSeconds = 0;
  setMaintenanceDependenciesForTest(dependencies());
  await resetInternalRateLimit();
});
afterEach(async () => {
  resetMaintenanceDependenciesForTest();
  await suite.sql`TRUNCATE storage_reclaim_queue`;
});

/** Production-valid leases with a controlled clock and protection period. @returns The dependencies. */
function dependencies(): MaintenanceDependencies {
  return { storage, config: { ...getMaintenanceConfig(), enabled: true, batchSize: 20, concurrency: 1, protectionSeconds, checkIntervalSeconds: 10 }, now: () => new Date(instant) };
}

interface Derived { id: string; storageKey: string }

/**
 * Queue one derived presentation object, present in storage, registered a day before the clock.
 * @param createdAt - When it was registered.
 * @returns It.
 */
async function derived(createdAt = new Date(instant.getTime() - 86_400_000)): Promise<Derived> {
  const storageKey = `video/derived/${randomUUID()}.mp4.video-source-ledger.${T}.json`;
  const [row] = await suite.sql<{ id: string }[]>`INSERT INTO storage_reclaim_queue(storage_key,kind,created_at) VALUES(${storageKey},'derived',${createdAt}) RETURNING id`;
  storage.objects.add(storageKey);
  return { id: row!.id, storageKey };
}

/**
 * Pin a key the way the pin service records it.
 * @param storageKey - The key.
 * @param released - Whether the pin is already released.
 * @returns The pin id.
 */
async function pin(storageKey: string, released = false): Promise<string> {
  const [row] = await suite.sql<{ id: string }[]>`INSERT INTO presentation_pins(holder_kind,holder_id,tool_input_id,deleted_at)
    VALUES('execution',${randomUUID()},${T},${released ? new Date() : null}) RETURNING id`;
  await suite.sql`INSERT INTO presentation_pin_objects(pin_id,storage_key) VALUES(${row!.id},${storageKey})`;
  return row!.id;
}

/**
 * Preview rows through the signed endpoint.
 * @param ids - Queue ids.
 * @returns The answer.
 */
async function preview(ids: string[]): Promise<{ previewId: string; items: { id: string; storageKey: string; keptStorageKey: string | null; eligible: boolean; reason: string | null }[] }> {
  const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids } });
  expect(response.status).toBe(200);
  return response.json as never;
}

/**
 * Preview and approve eligible derived rows.
 * @param rows - The rows.
 * @returns The operation key.
 */
async function approve(rows: Derived[]): Promise<string> {
  const previewed = await preview(rows.map((row) => row.id));
  expect(previewed.items.map((item) => [item.eligible, item.reason])).toEqual(rows.map(() => [true, null]));
  const key = requestKey();
  const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.previewId, items: rows.map((row) => ({ id: row.id, storageKey: row.storageKey, keptStorageKey: null })) }, idempotencyKey: key });
  expect(submitted.status).toBe(202);
  expect(submitted.json).toMatchObject({ key, decision: "accepted" });
  return key;
}

/**
 * The operation view.
 * @param key - The operation key.
 * @returns It.
 */
async function view(key: string): Promise<ReclaimOperationView> {
  const response = await call(suite.baseUrl, `${base}/operations/${key}`);
  expect(response.status).toBe(200);
  return response.json as ReclaimOperationView;
}

describe("derived rows at preview and approval (design §7.15; §90 E4-9)", () => {
  it("MD01 an unpinned derived row past protection is eligible with no kept key, and no kept object is checked", async () => {
    const row = await derived();
    const previewed = await preview([row.id]);
    expect(previewed.items).toEqual([{ id: row.id, storageKey: row.storageKey, keptStorageKey: null, eligible: true, reason: null }]);
    expect(storage.heads.filter((key) => key !== row.storageKey)).toEqual([]);
  });

  it("MD02 a derived key referenced by a live pin is not eligible: pinned", async () => {
    const row = await derived(); await pin(row.storageKey);
    expect((await preview([row.id])).items).toEqual([expect.objectContaining({ id: row.id, eligible: false, reason: "pinned" })]);
  });

  it("MD03 a released pin does not protect the key", async () => {
    const row = await derived(); await pin(row.storageKey, true);
    expect((await preview([row.id])).items).toEqual([expect.objectContaining({ id: row.id, eligible: true, reason: null })]);
  });

  it("MD04 a derived key with a live asset row is not eligible: live_reference", async () => {
    const row = await derived();
    const world = await maintenanceWorld(suite.sql);
    await suite.sql`UPDATE studio_assets SET storage_key=${row.storageKey} WHERE id=${world.assetId}`;
    expect((await preview([row.id])).items).toEqual([expect.objectContaining({ id: row.id, eligible: false, reason: "live_reference" })]);
  });

  it("MD05 the protection period counts from the derived row's created_at", async () => {
    protectionSeconds = 3600; setMaintenanceDependenciesForTest(dependencies());
    const fresh = await derived(new Date(instant.getTime() - 60_000));
    const old = await derived(new Date(instant.getTime() - 7_200_000));
    const items = (await preview([fresh.id, old.id])).items;
    expect(items.map((item) => [item.id, item.eligible, item.reason])).toEqual([[fresh.id, false, "protection_period"], [old.id, true, null]]);
  });

  it("MD06 the candidate list shows a derived row's kind and its absent kept key", async () => {
    const row = await derived();
    const listed = await call(suite.baseUrl, `${base}/candidates?pageSize=100`);
    expect(listed.status).toBe(200);
    expect((listed.json as { items: unknown[] }).items).toContainEqual(expect.objectContaining({ id: row.id, storageKey: row.storageKey, keptStorageKey: null, kind: "derived" }));
  });

  it("MD07 approval refuses a derived row that became pinned after its preview", async () => {
    const row = await derived();
    const previewed = await preview([row.id]);
    await pin(row.storageKey);
    const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.previewId, items: [{ id: row.id, storageKey: row.storageKey, keptStorageKey: null }] }, idempotencyKey: requestKey() });
    expect(submitted.status).toBe(200);
    expect(submitted.json).toMatchObject({ decision: "refused", reason: "pinned" });
  });
});

describe("derived rows at execution: the pin check is repeated before the delete (design §7.15 仲裁)", () => {
  it("MD08 an approved unpinned derived key is deleted and the run records it missing, with a null kept key in the scope", async () => {
    const row = await derived();
    const key = await approve([row]);
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([row.storageKey]);
    const operation = (await view(key)).operation!;
    expect(operation.scope).toEqual([{ id: row.id, storageKey: row.storageKey, keptStorageKey: null }]);
    expect(operation.firstRun!.items).toEqual([expect.objectContaining({ id: row.id, state: "missing" })]);
  });

  it("MD09 a pin acquired after approval keeps the object: the item is deferred as pinned and nothing is deleted", async () => {
    const row = await derived();
    const key = await approve([row]);
    await pin(row.storageKey);
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([]);
    expect(storage.objects.has(row.storageKey)).toBe(true);
    expect((await view(key)).operation!.firstRun!.items).toEqual([expect.objectContaining({ id: row.id, state: "deferred", reason: "pinned" })]);
  });

  it("MD10 whatever pins exist, a derived key is deleted only when no live pin references it (property)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("none", "live", "released"), { minLength: 1, maxLength: 4 }), async (states) => {
      await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews,storage_reclaim_queue`;
      await resetInternalRateLimit();
      storage.deletes.length = 0;
      const rows = await Promise.all(states.map(() => derived()));
      const previewed = await preview(rows.map((row) => row.id));
      const eligible = rows.filter((_row, i) => previewed.items[i]!.eligible);
      expect(eligible).toHaveLength(rows.length);
      const key = requestKey();
      const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.previewId, items: rows.map((row) => ({ id: row.id, storageKey: row.storageKey, keptStorageKey: null })) }, idempotencyKey: key });
      expect(submitted.status).toBe(202);
      for (const [i, state] of states.entries()) if (state !== "none") await pin(rows[i]!.storageKey, state === "released");
      for (let pass = 0; pass < 2; pass += 1) await runMaintenanceLoopOnce();
      const expected = rows.filter((_row, i) => states[i] !== "live").map((row) => row.storageKey).sort();
      expect([...storage.deletes].sort()).toEqual(expected);
    }), { seed: 1306, numRuns: 12 });
  });
});
