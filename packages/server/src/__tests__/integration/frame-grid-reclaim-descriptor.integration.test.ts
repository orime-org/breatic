// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Before a `derived` object is reclaimed, the current R2 descriptor of its canonical key is checked (inner#1306 test plan
 * §66 P03; frames-split design §7.15 「派生对象登记回收时同时写入它的canonical key……`qualification.ts`除核对钉住表，还按这个key
 * 读当前R2描述对象，被它引用的返回`descriptor_reference`」, §10.12 qualification.ts row).
 *
 * The presentation DO publishes P outside the SQL pin transaction, so between publishing and the worker's `Mv` a new
 * bundle's objects may be referenced by the descriptor while no pin row names them yet. A `derived` row carries its
 * canonical key in `kept_storage_key`; qualification reads `<canonical>.video-presentation.v1.json` and refuses an object
 * the descriptor references with `descriptor_reference`, at preview and again before the delete.
 *
 * Proposed API (the design does not name it): the maintenance storage port gains `read(key)`, the stored object's text or
 * null when it is absent.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest, type MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";
import { runMaintenanceLoopOnce } from "@server/modules/maintenance/maintenance-loop.js";
import { call, resetInternalRateLimit, useInternalApp } from "./internal-api-harness.js";
import { MaintenanceStorage, requestKey } from "./maintenance.fixture.js";
import { presentedSource } from "./presentation-fixtures.js";

/** The test storage with readable object bodies, for the descriptor. */
class ReadableStorage extends MaintenanceStorage {
  readonly bodies = new Map<string, string>();
  readonly reads: string[] = [];

  /**
   * The stored text of a key.
   * @param key - The key.
   * @returns Its text, or null when absent.
   */
  async read(key: string): Promise<string | null> {
    this.reads.push(key);
    return this.bodies.get(key) ?? null;
  }
}

const suite = useInternalApp("frame-grid-reclaim-descriptor");
const base = "/internal/v1/maintenance/reclaim";
let instant: Date;
let storage: ReadableStorage;

beforeEach(async () => {
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews,storage_reclaim_queue`;
  instant = new Date("2030-01-01T00:00:00.000Z");
  storage = new ReadableStorage();
  setMaintenanceDependenciesForTest(dependencies());
  await resetInternalRateLimit();
});
afterEach(async () => {
  resetMaintenanceDependenciesForTest();
  await suite.sql`TRUNCATE storage_reclaim_queue`;
});

/** Leases with a controlled clock and no protection period. @returns The dependencies. */
function dependencies(): MaintenanceDependencies {
  return { storage, config: { ...getMaintenanceConfig(), enabled: true, batchSize: 20, concurrency: 1, protectionSeconds: 0, checkIntervalSeconds: 10 }, now: () => new Date(instant) };
}

/**
 * A canonical key whose current descriptor's playback file is `played`, and a derived row for `queued`.
 * @param referenced - Whether the queued object is the one the descriptor plays.
 * @returns The queue row.
 */
async function world(referenced: boolean): Promise<{ id: string; storageKey: string; canonical: string }> {
  const canonical = `video/grid-reclaim/${randomUUID()}.mp4`;
  const played = `${canonical}.play-${randomUUID()}.mp4`;
  const storageKey = referenced ? played : `${canonical}.play-${randomUUID()}.mp4`;
  const presented = await presentedSource(randomBytes(32).toString("hex"), canonical, (key) => `https://assets.example.test/${key}`);
  const bundle = presented.bundle as { playback: { carrier: Record<string, unknown> } };
  bundle.playback.carrier = { ...bundle.playback.carrier, storageKey: played, url: `https://assets.example.test/${played}` };
  storage.bodies.set(`${canonical}.video-presentation.v1.json`, JSON.stringify(bundle));
  // The canonical object is stored: the derived row's kept key names it.
  storage.objects.add(storageKey); storage.objects.add(canonical);
  const [row] = await suite.sql<{ id: string }[]>`INSERT INTO storage_reclaim_queue(storage_key,kind,kept_storage_key,created_at)
    VALUES(${storageKey},'derived',${canonical},${new Date(instant.getTime() - 86_400_000)}) RETURNING id`;
  return { id: row!.id, storageKey, canonical };
}

/**
 * Preview rows through the signed endpoint.
 * @param ids - Queue ids.
 * @returns The answer.
 */
async function preview(ids: string[]): Promise<{ previewId: string; items: { id: string; eligible: boolean; reason: string | null }[] }> {
  const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids } });
  expect(response.status).toBe(200);
  return response.json as never;
}

describe("the current descriptor protects what it references (§66 P03; design §7.15)", () => {
  it("P03: an unpinned derived object the current descriptor plays is not eligible: descriptor_reference", async () => {
    const row = await world(true);
    expect((await preview([row.id])).items).toEqual([expect.objectContaining({ id: row.id, eligible: false, reason: "descriptor_reference" })]);
    expect(storage.reads).toContain(`${row.canonical}.video-presentation.v1.json`);
  });

  it("P03: an object the descriptor started to reference after approval is kept: the delete is deferred as descriptor_reference", async () => {
    const row = await world(false);
    const previewed = await preview([row.id]);
    expect(previewed.items).toEqual([expect.objectContaining({ id: row.id, eligible: true, reason: null })]);
    const key = requestKey();
    const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.previewId, items: [{ id: row.id, storageKey: row.storageKey, keptStorageKey: row.canonical }] }, idempotencyKey: key });
    expect(submitted.status).toBe(202);
    // The DO publishes a version playing this object before any pin names it.
    const descriptor = JSON.parse(storage.bodies.get(`${row.canonical}.video-presentation.v1.json`)!) as { playback: { carrier: Record<string, unknown> } };
    descriptor.playback.carrier = { ...descriptor.playback.carrier, storageKey: row.storageKey };
    storage.bodies.set(`${row.canonical}.video-presentation.v1.json`, JSON.stringify(descriptor));
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([]);
    expect(storage.objects.has(row.storageKey)).toBe(true);
  });
});
