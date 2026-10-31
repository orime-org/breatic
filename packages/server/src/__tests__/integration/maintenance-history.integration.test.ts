// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Core from "@breatic/core";

const historyProbe = vi.hoisted(() => ({ recording: false, calls: [] as string[] }));
vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof Core>();
  const maintenanceRepo = new Proxy(actual.maintenanceRepo, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        if (historyProbe.recording) historyProbe.calls.push(String(property));
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  return { ...actual, maintenanceRepo };
});

import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest } from "@server/modules/maintenance/dependencies.js";
import { runMaintenanceLoopOnce } from "@server/modules/maintenance/maintenance-loop.js";
import { call, useInternalApp } from "./internal-api-harness.js";
import { MaintenanceStorage, maintenanceWorld, requestKey, scopeOf } from "./maintenance.fixture.js";

const suite = useInternalApp("maintenance-history-probe");
const base = "/internal/v1/maintenance/reclaim";
const config = { enabled: true, loopIntervalSeconds: 1, checkIntervalSeconds: 10, batchSize: 2, leaseSeconds: 5, protectionSeconds: 0, previewTtlSeconds: 60, storageTimeoutMs: 1000 };
let instant: Date;
let storage: MaintenanceStorage;
beforeEach(async () => {
  historyProbe.recording = false;
  historyProbe.calls = [];
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews`;
  instant = new Date("2030-01-01T00:00:00.000Z");
  storage = new MaintenanceStorage();
  setMaintenanceDependenciesForTest({ storage, config, now: () => new Date(instant) });
});
afterEach(() => {
  historyProbe.recording = false;
  resetMaintenanceDependenciesForTest();
});

describe("bounded executor history reads", () => {
  it("uses first/latest/exact run queries while recurring physical work never reads a history page", async () => {
    const fixture = await maintenanceWorld(suite.sql);
    await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${fixture.storageKey} WHERE id=${fixture.id}`;
    storage.seed(fixture);
    const preview = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
    expect(preview.status).toBe(200);
    const key = requestKey();
    const approved = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: preview.json.previewId, items: [scopeOf(fixture)] }, idempotencyKey: key });
    expect(approved.status).toBe(202);
    for (let number = 1; number <= 3; number++) {
      await runMaintenanceLoopOnce();
      instant = new Date(instant.getTime() + 11_000);
    }
    storage.objects.add(fixture.storageKey);
    historyProbe.calls = [];
    historyProbe.recording = true;
    try { await runMaintenanceLoopOnce(); }
    finally { historyProbe.recording = false; }
    expect(historyProbe.calls).toContain("latestRun");
    expect(historyProbe.calls).toContain("findRun");
    expect(historyProbe.calls).not.toContain("listRuns");
    expect(historyProbe.calls).not.toContain("listRunPage");
    const view = await call(suite.baseUrl, `${base}/operations/${key}`);
    expect(view.status).toBe(200);
    expect(view.json.operation.firstRun.number).toBe(1);
    expect(view.json.operation.runs.map((run: { number: number }) => run.number)).toEqual([4, 3, 2, 1]);
    expect(storage.deletes).toEqual([fixture.storageKey, fixture.storageKey]);
  });
});
