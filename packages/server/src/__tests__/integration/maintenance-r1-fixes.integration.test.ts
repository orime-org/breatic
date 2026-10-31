// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReclaimDecision, ReclaimOperationView } from "@breatic/core";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest, type MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";
import { runMaintenanceLoopOnce } from "@server/modules/maintenance/maintenance-loop.js";
import { call, resetInternalRateLimit, useInternalApp } from "./internal-api-harness.js";
import { gate, MaintenanceStorage, maintenanceWorld, requestKey, scopeOf, type MaintenanceWorld } from "./maintenance.fixture.js";

const suite = useInternalApp("maintenance-r1-fixes");
const base = "/internal/v1/maintenance/reclaim";
let instant: Date;
let storage: MaintenanceStorage;

beforeEach(async () => {
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews,storage_reclaim_queue`;
  instant = new Date("2030-01-01T00:00:00.000Z");
  storage = new MaintenanceStorage();
  setMaintenanceDependenciesForTest(dependencies(1));
});
afterEach(async () => {
  resetMaintenanceDependenciesForTest();
  await suite.sql`TRUNCATE storage_reclaim_queue`;
});

/** Keep production-valid leases/deadlines while controlling only the work bound and clock. */
function dependencies(batchSize: number): MaintenanceDependencies {
  return { storage, config: { ...getMaintenanceConfig(), enabled: true, batchSize, concurrency: 1, protectionSeconds: 0, checkIntervalSeconds: 10 }, now: () => new Date(instant) };
}

/** Advance deterministic scheduling while every issued lease remains a real production-valid duration. */
function advance(seconds = 1): void { instant = new Date(instant.getTime() + seconds * 1000); }

/** Build the exact original upload association with available canonical bytes. */
async function world(): Promise<MaintenanceWorld> {
  const fixture = await maintenanceWorld(suite.sql);
  await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${fixture.storageKey} WHERE id=${fixture.id}`;
  storage.seed(fixture);
  return fixture;
}

/** Read the actual signed HTTP view without projecting progress in the fixture. */
async function view(key: string): Promise<ReclaimOperationView> {
  const response = await call(suite.baseUrl, `${base}/operations/${key}`);
  expect(response.status).toBe(200);
  return response.json as ReclaimOperationView;
}

/** Approve an original immutable scope through the real preview and submission endpoints. */
async function approve(worlds: MaintenanceWorld[]): Promise<{ key: string; decision: ReclaimDecision; scope: ReturnType<typeof scopeOf>[] }> {
  await resetInternalRateLimit();
  const previewed = await call(suite.baseUrl, `${base}/preview`, { body: { ids: worlds.map((item) => item.id) } });
  expect(previewed.status).toBe(200);
  expect(previewed.json.items.map((item: { eligible: boolean }) => item.eligible)).toEqual(worlds.map(() => true));
  const scope = worlds.map(scopeOf);
  const key = requestKey();
  const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.json.previewId, items: scope }, idempotencyKey: key });
  expect(submitted.status).toBe(202);
  expect(submitted.json).toMatchObject({ key, decision: "accepted", requestedBy: "admin_7" });
  return { key, decision: submitted.json as ReclaimDecision, scope };
}

/** Apply an independently keyed switch change through signed HTTP. */
async function control(key: string, action: "pause" | "resume", expectedVersion: number): Promise<void> {
  const response = await call(suite.baseUrl, `${base}/operations/${key}/control`, { body: { action, expectedVersion }, idempotencyKey: requestKey() });
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({ decision: "saved", action, state: action === "pause" ? "paused" : "enabled" });
}

const prefixCases = [
  { batchSize: 1, prefixCount: 1 },
  { batchSize: 1, prefixCount: 3 },
  { batchSize: 20, prefixCount: 20 },
  { batchSize: 20, prefixCount: 22 },
] as const;

describe("claimable operations do not hide behind unclaimable due prefixes", () => {
  it("resumes the unfinished original first run before an already completed later run", async () => {
    const candidates = [await world(), await world()].sort((left, right) => left.storageKey.localeCompare(right.storageKey));
    const [complete, failing] = candidates;
    const original = await approve(candidates);
    storage.beforeDelete = async (key) => { if (key === failing!.storageKey) throw new Error("Fixture definite first-run failure"); };
    await runMaintenanceLoopOnce();
    await runMaintenanceLoopOnce();
    const failed = await view(original.key);
    expect(failed.operation!.firstRun!.state).toBe("partial");
    expect(failed.operation!.firstRun!.items.find((item) => item.id === complete!.id)!.state).toBe("missing");
    storage.beforeDelete = null;
    advance(11);
    await runMaintenanceLoopOnce();
    await runMaintenanceLoopOnce();
    const later = await view(original.key);
    expect(later.operation!.firstRun!.state).toBe("partial");
    expect(later.operation!.runs[0]).toMatchObject({ number: 2, state: "completed" });
    const receipt = await call(suite.baseUrl, `${base}/operations/${original.key}/resume`, { body: { expectedVersion: later.operation!.maintenance.version }, idempotencyKey: requestKey() });
    expect(receipt.status).toBe(200);
    expect(receipt.json.decision).toBe("saved");
    await runMaintenanceLoopOnce();
    const resumed = await view(original.key);
    expect(resumed.decision).toEqual(original.decision);
    expect(resumed.operation!.scope).toEqual(original.scope);
    expect(resumed.operation!.firstRun).toMatchObject({ id: failed.operation!.firstRun!.id, state: "completed" });
    expect(resumed.operation!.runs).toHaveLength(2);
    expect(resumed.operation!.runs[0]).toEqual(later.operation!.runs[0]);
    expect(storage.deletes).toEqual([complete!.storageKey, failing!.storageKey, failing!.storageKey]);
  });

  describe.each(["paused", "leased", "completed-sibling-leased"] as const)("%s prefix", (kind) => {
    it.each(prefixCases)("advances enabled work with batch $batchSize behind $prefixCount consecutive operations", async ({ batchSize, prefixCount }) => {
      expect(getMaintenanceConfig().batchSize).toBe(20);
      const parked = new Map<string, ReturnType<typeof gate>>();
      const entered = new Set<string>();
      const holders: Promise<void>[] = [];
      const originals: Awaited<ReturnType<typeof approve>>[] = [];
      storage.beforeDelete = async (key) => {
        const latch = parked.get(key);
        if (!latch) return;
        entered.add(key);
        latch.enter();
        await latch.released;
      };
      try {
        for (let index = 0; index < prefixCount; index++) {
          const candidates = kind === "leased" ? [await world()] : [await world(), await world()];
          const original = await approve(candidates);
          originals.push(original);
          const prep = dependencies(prefixCount + 1);
          if (kind !== "leased") {
            const before = storage.deletes.length;
            // An observed graceful stop leaves a genuine first run with one
            // completed item and one queued item; no scheduling SQL is forged.
            await runMaintenanceLoopOnce(prep, () => storage.deletes.length > before);
            const partial = await view(original.key);
            expect(partial.operation!.firstRun!.items.filter((item) => item.state === "missing")).toHaveLength(1);
            expect(partial.operation!.firstRun!.items.filter((item) => item.state === "queued")).toHaveLength(1);
          }
          if (kind === "paused") await control(original.key, "pause", 1);
          else {
            const pending = candidates.find((item) => !storage.deletes.includes(item.storageKey))!;
            const latch = gate();
            parked.set(pending.storageKey, latch);
            holders.push(runMaintenanceLoopOnce(prep, () => entered.has(pending.storageKey)));
            await latch.entered;
          }
          advance();
        }
        const healthy = [await world(), await world()];
        const enabled = await approve(healthy);
        setMaintenanceDependenciesForTest(dependencies(batchSize));
        const before = storage.deletes.length;
        for (let tick = 0; tick < 3; tick++) {
          await runMaintenanceLoopOnce();
          advance();
        }
        const progressed = await view(enabled.key);
        expect(progressed.operation!.firstRun?.state).toBe("completed");
        expect(progressed.decision).toEqual(enabled.decision);
        expect(progressed.operation!.scope).toEqual(enabled.scope);
        expect(new Set(storage.deletes.slice(before))).toEqual(new Set(healthy.map((item) => item.storageKey)));
        expect(storage.deletes.slice(before)).toHaveLength(2);
        const original = await view(originals[0]!.key);
        expect(original.decision).toEqual(originals[0]!.decision);
        expect(original.operation!.scope).toEqual(originals[0]!.scope);
        if (kind === "paused") expect(original.operation!.maintenance.state).toBe("paused");
        for (const item of healthy) expect(storage.objects.has(item.keptStorageKey)).toBe(true);
      } finally {
        for (const latch of parked.values()) latch.release();
        await Promise.all(holders);
      }
    });
  });

  it.each(["present", "missing"] as const)("retains paused HEAD-only recovery for an expired unknown DELETE with %s bytes while enabled work progresses", async (fact) => {
    const originalWorld = await world();
    const original = await approve([originalWorld]);
    const error = new Error("Fixture unknown DELETE result");
    error.name = "TimeoutError";
    storage.deleteFailure = error;
    await runMaintenanceLoopOnce();
    await control(original.key, "pause", 1);
    storage.deleteFailure = null;
    if (fact === "missing") storage.objects.delete(originalWorld.storageKey);
    advance(getMaintenanceConfig().leaseSeconds + 1);
    const healthyWorld = await world();
    const healthy = await approve([healthyWorld]);
    const beforeHeads = storage.heads.length;
    await runMaintenanceLoopOnce();
    expect(storage.heads.slice(beforeHeads)).toContain(originalWorld.storageKey);
    expect(storage.deletes.filter((key) => key === originalWorld.storageKey)).toHaveLength(1);
    const paused = await view(original.key);
    expect(paused.operation!.maintenance.state).toBe("paused");
    expect(paused.decision).toEqual(original.decision);
    expect(paused.operation!.scope).toEqual(original.scope);
    if (fact === "missing") expect(paused.operation!.firstRun!.state).toBe("completed");
    else expect(paused.operation!.firstRun!.items[0]!.state).toBe("unknown");
    await runMaintenanceLoopOnce();
    expect((await view(healthy.key)).operation!.firstRun?.state).toBe("completed");
    if (fact === "present") {
      await control(original.key, "resume", 2);
      advance(getMaintenanceConfig().leaseSeconds + 1);
      await runMaintenanceLoopOnce();
      expect(storage.deletes.filter((key) => key === originalWorld.storageKey)).toHaveLength(2);
      expect((await view(original.key)).operation!.firstRun!.state).toBe("completed");
    }
  });
});
