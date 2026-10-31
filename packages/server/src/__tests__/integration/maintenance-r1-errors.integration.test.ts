// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { initLogger, logger } from "@breatic/core";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest } from "@server/modules/maintenance/dependencies.js";
import { call, useInternalApp } from "./internal-api-harness.js";
import { MaintenanceStorage, maintenanceWorld, requestKey, scopeOf, type MaintenanceWorld } from "./maintenance.fixture.js";

const suite = useInternalApp("maintenance-r1-errors");
const base = "/internal/v1/maintenance/reclaim";
const serviceName = "maintenance-r1-errors";
let storage: MaintenanceStorage;
let logsRoot: string;
let errorSpy: MockInstance;

beforeEach(async () => {
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews,storage_reclaim_queue`;
  storage = new MaintenanceStorage();
  setMaintenanceDependenciesForTest({ storage, config: { ...getMaintenanceConfig(), enabled: true, protectionSeconds: 0 }, now: () => new Date("2030-01-01T00:00:00.000Z") });
  logsRoot = mkdtempSync(join(tmpdir(), "jobs30-r1-fixes-errors-"));
  initLogger(serviceName, { logsRoot, debug: false, console: "none" });
  // initLogger replaces the lazy default Proxy with this concrete instance.
  const concrete = logger;
  errorSpy = vi.spyOn(concrete, "error");
  const positive = new Error("jobs30-r1-fixes-positive-control");
  logger.error({ err: positive }, "maintenance_r1_positive_control");
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect((errorSpy.mock.calls[0]![0] as { err: unknown }).err).toBe(positive);
  expect(errorRows()).toEqual([expect.objectContaining({ msg: "maintenance_r1_positive_control", err: expect.objectContaining({ message: positive.message }) })]);
  errorSpy.mockClear();
});
afterEach(async () => {
  errorSpy?.mockRestore();
  resetMaintenanceDependenciesForTest();
  rmSync(logsRoot, { recursive: true, force: true });
  await suite.sql`TRUNCATE storage_reclaim_queue`;
});

/** Read the real synchronous file sink, retaining only error-level records. */
function errorRows(): Record<string, unknown>[] {
  return readdirSync(join(logsRoot, serviceName))
    .flatMap((file) => readFileSync(join(logsRoot, serviceName, file), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.level === 50);
}

/** Create exact candidate and consumed-original facts with available kept bytes. */
async function world(): Promise<MaintenanceWorld> {
  const fixture = await maintenanceWorld(suite.sql);
  await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${fixture.storageKey} WHERE id=${fixture.id}`;
  storage.seed(fixture);
  return fixture;
}

/** Exercise the valid case of distinct studio rows naming the same physical keeper. */
async function candidates(shared: boolean): Promise<MaintenanceWorld[]> {
  const first = await world();
  if (!shared) return [first];
  const second = await world();
  await suite.sql`UPDATE studio_assets SET storage_key=${first.keptStorageKey},content_hash=${first.contentHash} WHERE id=${second.assetId}`;
  await suite.sql`UPDATE storage_reclaim_queue SET kept_storage_key=${first.keptStorageKey},content_hash=${first.contentHash} WHERE id=${second.id}`;
  second.keptStorageKey = first.keptStorageKey;
  second.contentHash = first.contentHash;
  return [first, second];
}

/** Get an eligible preview before introducing a submit-stage storage response. */
async function approvalBody(items: MaintenanceWorld[]): Promise<{ previewId: string; items: ReturnType<typeof scopeOf>[] }> {
  const preview = await call(suite.baseUrl, `${base}/preview`, { body: { ids: items.map((item) => item.id) } });
  expect(preview.status).toBe(200);
  expect(preview.json.items.map((item: { eligible: boolean }) => item.eligible)).toEqual(items.map(() => true));
  return { previewId: preview.json.previewId as string, items: items.map(scopeOf) };
}

describe("kept-object application error evidence", () => {
  it.each([
    { stage: "preview", shared: false },
    { stage: "preview", shared: true },
    { stage: "submit", shared: false },
    { stage: "submit", shared: true },
  ] as const)("records the original $stage error and exact shared=$shared context while retaining the finite reason", async ({ stage, shared }) => {
    const items = await candidates(shared);
    const body = stage === "submit" ? await approvalBody(items) : null;
    const key = stage === "submit" ? requestKey() : null;
    const failure = new Error(`jobs30-r1-fixes-${stage}-sdk-cause`, { cause: new Error("fixture-original-sdk-cause") });
    storage.headFailure = failure;
    const response = stage === "preview"
      ? await call(suite.baseUrl, `${base}/preview`, { body: { ids: items.map((item) => item.id) } })
      : await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key! });
    expect(response.status).toBe(200);
    if (stage === "preview") {
      expect(response.json.items).toEqual(items.map((item) => expect.objectContaining({ id: item.id, eligible: false, reason: "storage_error" })));
    } else {
      expect(response.json).toMatchObject({ key, decision: "refused", reason: "storage_error", requestedBy: "admin_7" });
    }
    expect(JSON.stringify(response.json)).not.toContain(failure.message);
    const expectedLogs = stage === "preview" ? items.length : 1;
    expect(errorSpy).toHaveBeenCalledTimes(expectedLogs);
    const evidence = errorSpy.mock.calls.map((args) => {
      expect(args[1]).toBe("maintenance_kept_head_failed");
      const context = args[0] as Record<string, unknown>;
      expect(context.err).toBe(failure);
      expect(context).toMatchObject({ stage, requestedBy: "admin_7", operationKey: key, previewId: body?.previewId ?? null, keptStorageKey: items[0]!.keptStorageKey });
      return context;
    });
    if (stage === "preview") {
      expect(evidence.map((context) => context.candidateIds)).toEqual(items.map((item) => [item.id]));
      expect(evidence.map((context) => context.storageKeys)).toEqual(items.map((item) => [item.storageKey]));
    } else {
      expect(new Set(evidence[0]!.candidateIds as string[])).toEqual(new Set(items.map((item) => item.id)));
      expect(new Set(evidence[0]!.storageKeys as string[])).toEqual(new Set(items.map((item) => item.storageKey)));
      expect(evidence[0]!.candidateIds).toHaveLength(items.length);
      const heads = storage.heads.length;
      const repeated = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key! });
      expect(repeated.json).toEqual(response.json);
      expect(storage.heads).toHaveLength(heads);
      expect(errorSpy).toHaveBeenCalledTimes(expectedLogs);
    }
    const written = errorRows().filter((row) => row.msg === "maintenance_kept_head_failed");
    writeFileSync(join(tmpdir(), `jobs30-r1-fixes-f4-sink-${stage}-${shared}.json`), JSON.stringify(written, null, 2));
    expect(written).toHaveLength(expectedLogs);
    for (const record of written) expect(record).toMatchObject({
      stage, requestedBy: "admin_7", err: expect.objectContaining({
        message: expect.stringContaining(failure.message),
        stack: expect.stringContaining(failure.message),
        cause: expect.objectContaining({ message: "fixture-original-sdk-cause" }),
      }),
    });
    for (const record of written) expect((record.err as { stack: string }).stack).toContain("fixture-original-sdk-cause");
  });

  it.each([
    { stage: "preview", fact: "present" },
    { stage: "preview", fact: "missing" },
    { stage: "submit", fact: "present" },
    { stage: "submit", fact: "missing" },
  ] as const)("does not create an error log for a nonthrowing $stage HEAD=$fact", async ({ stage, fact }) => {
    const item = await world();
    const body = stage === "submit" ? await approvalBody([item]) : null;
    if (fact === "missing") storage.objects.delete(item.keptStorageKey);
    const response = stage === "preview"
      ? await call(suite.baseUrl, `${base}/preview`, { body: { ids: [item.id] } })
      : await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: requestKey() });
    expect(response.status).toBe(stage === "submit" && fact === "present" ? 202 : 200);
    if (stage === "preview") expect(response.json.items[0]).toMatchObject({ eligible: fact === "present", reason: fact === "present" ? null : "kept_missing" });
    else expect(response.json).toMatchObject({ decision: fact === "present" ? "accepted" : "refused", reason: fact === "present" ? null : "kept_missing" });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(errorRows().filter((row) => row.msg === "maintenance_kept_head_failed")).toEqual([]);
  });
});
