// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReclaimOperationView } from "@breatic/core";
import { setMaintenanceDependenciesForTest, resetMaintenanceDependenciesForTest } from "@server/modules/maintenance/dependencies.js";
import { runMaintenanceLoopOnce } from "@server/modules/maintenance/maintenance-loop.js";
import { registerWithDedup } from "@domain/asset/asset.repo.js";
import { statusOf } from "@domain/asset/upload-status.service.js";
import { call, resetInternalRateLimit, useInternalApp } from "./internal-api-harness.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { gate, MaintenanceStorage, maintenanceWorld, recordMaintenancePaginationPlans, requestKey, scopeOf, type MaintenanceWorld } from "./maintenance.fixture.js";

const suite = useInternalApp("maintenance-protocol");
const base = "/internal/v1/maintenance/reclaim";
const config = { enabled: true, loopIntervalSeconds: 1, checkIntervalSeconds: 10, batchSize: 100, leaseSeconds: 5, protectionSeconds: 0, previewTtlSeconds: 60, storageTimeoutMs: 1_000 };
let instant: Date;
let storage: MaintenanceStorage;

beforeEach(async () => {
  await suite.sql`TRUNCATE storage_reclaim_attempts,storage_reclaim_controls,storage_reclaim_runs,storage_reclaim_objects,storage_reclaim_operations,storage_reclaim_previews`;
  instant = new Date("2030-01-01T00:00:00.000Z");
  storage = new MaintenanceStorage();
  setMaintenanceDependenciesForTest({ storage, config: { ...config }, now: () => new Date(instant) });
});
afterEach(() => { resetMaintenanceDependenciesForTest(); });

/** Advance the deterministic executor clock without delaying the test. */
function advance(seconds = 11): void { instant = new Date(instant.getTime() + seconds * 1000); }

/** Build a known, explicitly associated upload outcome and storage facts. */
async function world(source = "upload"): Promise<MaintenanceWorld> {
  const fixture = await maintenanceWorld(suite.sql, source);
  await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${fixture.storageKey} WHERE id=${fixture.id}`;
  storage.seed(fixture);
  return fixture;
}

/** Read the original W, initial progress, history and latest physical facts. */
async function view(key: string): Promise<ReclaimOperationView> {
  const response = await call(suite.baseUrl, `${base}/operations/${key}`);
  expect(response.status).toBe(200);
  return response.json as ReclaimOperationView;
}

/** Obtain an eligible preview and its exact immutable approval body. */
async function preview(fixture: MaintenanceWorld): Promise<{ previewId: string; items: ReturnType<typeof scopeOf>[] }> {
  const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
  expect(response.status).toBe(200);
  expect(response.json.items).toEqual([expect.objectContaining({ ...scopeOf(fixture), eligible: true, reason: null })]);
  return { previewId: response.json.previewId as string, items: [scopeOf(fixture)] };
}

/** Approve one precise scope and assert that the immutable receipt was saved. */
async function approve(fixture: MaintenanceWorld): Promise<string> {
  const body = await preview(fixture);
  const key = requestKey();
  const response = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
  expect(response.status).toBe(202);
  expect(response.json).toMatchObject({ key, decision: "accepted", reason: null, requestedBy: "admin_7" });
  return key;
}

/** Submit an independently keyed maintenance switch request. */
async function control(key: string, action: "pause" | "resume", expectedVersion: number, idempotencyKey = requestKey(), admin = "admin_7"): Promise<Awaited<ReturnType<typeof call>>> {
  return call(suite.baseUrl, `${base}/operations/${key}/control`, { body: { action, expectedVersion }, idempotencyKey, admin });
}

describe("reclaim preview safety facts", () => {
  it.each(["unknown", "mixed"])("returns a whole-request not-found for %s identities without malformed empty keys", async (selection) => {
    const fixture = await world();
    const ids = selection === "mixed" ? [fixture.id, randomUUID()] : [randomUUID()];
    const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids } });
    expect(response.status).toBe(404);
    expect(response.json).toEqual({ code: "not_found" });
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM storage_reclaim_previews`;
    expect(count!.n).toBe(0);
    expect(storage.deletes).toEqual([]);
  });

  it("uses an explicit parent upload for a derived cover and preserves the parent's public result", async () => {
    const fixture = await world("cover");
    const originStorageKey = fixture.storageKey;
    fixture.storageKey = originStorageKey.replace(".png", "_cover.jpg");
    await suite.sql`UPDATE storage_reclaim_queue SET storage_key=${fixture.storageKey},origin_storage_key=${originStorageKey} WHERE id=${fixture.id}`;
    const [parent] = await suite.sql<{ id: string }[]>`INSERT INTO studio_assets(studio_id,produced_by_user_id,content_hash,storage_key,file_url,size_bytes,mime_type,kind,source)
      VALUES(${fixture.studioId},${fixture.userId},${randomUUID().replaceAll("-", "").repeat(2)},${`uploads/${randomUUID()}.mp4`},'https://cdn.example.test/parent.mp4',512,'video/mp4','video','upload') RETURNING id`;
    await suite.sql`UPDATE upload_grants SET asset_id=${parent!.id} WHERE id=${fixture.grantId}`;
    storage.seed(fixture);
    const original = await statusOf(fixture.userId, [originStorageKey]);
    expect(original).toEqual([expect.objectContaining({ state: "completed", result: expect.objectContaining({ assetId: parent!.id, kind: "video" }) })]);
    const key = await approve(fixture);
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([fixture.storageKey]);
    expect(storage.objects.has(originStorageKey)).toBe(true);
    expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
    expect(await statusOf(fixture.userId, [originStorageKey])).toEqual(original);
    expect((await view(key)).operation!.firstRun!.state).toBe("completed");
  });

  it("uses an explicit original grant for an upright copy without deleting its adjacent source", async () => {
    const fixture = await world();
    const origin = fixture.storageKey;
    fixture.storageKey = origin.replace(".png", "_upright.png");
    await suite.sql`UPDATE storage_reclaim_queue SET storage_key=${fixture.storageKey},origin_storage_key=${origin} WHERE id=${fixture.id}`;
    storage.seed(fixture);
    await approve(fixture);
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([fixture.storageKey]);
    expect(storage.objects.has(origin)).toBe(true);
    expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
  });

  it("reports the protection window as an admission fact rather than old-writer termination proof", async () => {
    const fixture = await world();
    await suite.sql`UPDATE storage_reclaim_queue SET created_at=${instant} WHERE id=${fixture.id}`;
    await suite.sql`UPDATE upload_grants SET consumed_at=${instant} WHERE id=${fixture.grantId}`;
    setMaintenanceDependenciesForTest({ storage, config: { ...config, protectionSeconds: 3600 }, now: () => new Date(instant) });
    const protectedPreview = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
    expect(protectedPreview.status).toBe(200);
    expect(protectedPreview.json.items[0]).toMatchObject({ eligible: false, reason: "protection_period" });
    advance(3600);
    await preview(fixture);
    expect(storage.deletes).toEqual([]);
  });

  it.each(["deleted", "hash", "key", "studio"])("refuses a consumed grant whose canonical %s no longer establishes the original winner", async (change) => {
    const fixture = await world();
    if (change === "deleted") await suite.sql`UPDATE studio_assets SET deleted_at=now() WHERE id=${fixture.assetId}`;
    if (change === "hash") await suite.sql`UPDATE studio_assets SET content_hash=${"f".repeat(64)} WHERE id=${fixture.assetId}`;
    if (change === "key") await suite.sql`UPDATE studio_assets SET storage_key=${`uploads/${randomUUID()}.png`} WHERE id=${fixture.assetId}`;
    if (change === "studio") {
      const other = await maintenanceWorld(suite.sql);
      await suite.sql`UPDATE upload_grants SET asset_id=${other.assetId} WHERE id=${fixture.grantId}`;
    }
    const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
    expect(response.status).toBe(200);
    expect(response.json.items[0]).toMatchObject({ eligible: false, reason: "canonical_missing" });
    expect(storage.deletes).toEqual([]);
  });

  it.each(["upload", "cover"])("accepts exact consumed canonical origin for %s without suffix expansion", async (source) => {
    const fixture = await world(source);
    await preview(fixture);
    expect(storage.deletes).toEqual([]);
    expect([...storage.objects]).toContain(fixture.keptStorageKey);
  });

  it.each([
    ["candidate_is_kept", "same"],
    ["live_reference", "live"],
    ["kept_missing", "missing"],
    ["origin_not_consumed", "unconsumed"],
    ["canonical_missing", "canonical"],
    ["origin_missing", "origin"],
  ] as const)("defers %s and never issues DELETE", async (reason, scenario) => {
    const fixture = await world();
    if (scenario === "same") await suite.sql`UPDATE storage_reclaim_queue SET kept_storage_key=storage_key WHERE id=${fixture.id}`;
    if (scenario === "live") {
      const other = await maintenanceWorld(suite.sql);
      await suite.sql`UPDATE studio_assets SET storage_key=${fixture.storageKey} WHERE id=${other.assetId}`;
    }
    if (scenario === "missing") storage.objects.delete(fixture.keptStorageKey);
    if (scenario === "unconsumed") await suite.sql`UPDATE upload_grants SET consumed_at=NULL,voided_at=now(),asset_id=NULL WHERE id=${fixture.grantId}`;
    if (scenario === "canonical") await suite.sql`UPDATE upload_grants SET asset_id=NULL WHERE id=${fixture.grantId}`;
    if (scenario === "origin") await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${`uploads/${randomUUID()}.png`} WHERE id=${fixture.id}`;
    const response = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
    expect(response.status).toBe(200);
    expect(response.json.items).toEqual([expect.objectContaining({ id: fixture.id, eligible: false, reason })]);
    expect(storage.deletes).toEqual([]);
  });
});

describe("immutable original decisions", () => {
  it("accepts only the eligible subset from a mixed preview using the backoffice wire field order", async () => {
    const eligible = await world();
    const unconsumed = await world();
    const unresolved = await world("cover");
    await suite.sql`UPDATE upload_grants SET consumed_at=NULL,asset_id=NULL WHERE id=${unconsumed.grantId}`;
    await suite.sql`UPDATE storage_reclaim_queue SET origin_storage_key=${`uploads/${randomUUID()}.mp4`} WHERE id=${unresolved.id}`;
    const previewed = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [eligible.id, unconsumed.id, unresolved.id] } });
    expect(previewed.status).toBe(200);
    expect(previewed.json.items.map((item: { eligible: boolean }) => item.eligible)).toEqual([true, false, false]);
    const items = previewed.json.items.filter((item: { eligible: boolean }) => item.eligible).map((item: { id: string; storageKey: string; keptStorageKey: string }) => ({ id: item.id, storageKey: item.storageKey, keptStorageKey: item.keptStorageKey }));
    const key = requestKey();
    const submitted = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.json.previewId, items }, idempotencyKey: key });
    expect(submitted.status).toBe(202);
    expect(submitted.json.decision).toBe("accepted");
    expect((await view(key)).operation!.scope).toEqual([scopeOf(eligible)]);
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([eligible.storageKey]);
    expect(storage.objects.has(unconsumed.storageKey)).toBe(true);
    expect(storage.objects.has(unresolved.storageKey)).toBe(true);
  });

  it("compares scope identity semantically across JSONB and signed object field order", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const reordered = { items: [{ keptStorageKey: fixture.keptStorageKey, storageKey: fixture.storageKey, id: fixture.id }], previewId: body.previewId };
    const key = requestKey();
    const submitted = await call(suite.baseUrl, `${base}/operations`, { body: reordered, idempotencyKey: key });
    expect(submitted.status).toBe(202);
    expect((await view(key)).operation!.scope).toEqual([scopeOf(fixture)]);
    const replay = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(replay.status).toBe(202);
    expect(replay.json).toEqual(submitted.json);
  });

  it("keeps the queue's existing physical-key uniqueness and refuses an invented second identity", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const inventedId = randomUUID();
    await expect(suite.sql`INSERT INTO storage_reclaim_queue(id,storage_key,content_hash,studio_id,kept_storage_key,source)
      VALUES(${inventedId},${fixture.storageKey},${fixture.contentHash},${fixture.studioId},${fixture.keptStorageKey},'upload')`).rejects.toMatchObject({ code: "23505" });
    const existing = await suite.sql<{ id: string }[]>`SELECT id FROM storage_reclaim_queue WHERE storage_key=${fixture.storageKey}`;
    expect(existing).toEqual([{ id: fixture.id }]);
    const response = await call(suite.baseUrl, `${base}/operations`, { body: { ...body, items: [...body.items, { ...scopeOf(fixture), id: inventedId }] }, idempotencyKey: requestKey() });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ decision: "refused", reason: "preview_mismatch" });
    const [objects] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM storage_reclaim_objects WHERE storage_key=${fixture.storageKey}`;
    expect(objects!.n).toBe(0);
  });

  it("recovers an original request after a successful not-found lookup with the original body and actor", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const key = requestKey();
    const lookup = await call(suite.baseUrl, `${base}/operations/${key}`);
    expect(lookup.status).toBe(404);
    expect(lookup.json).toMatchObject({ code: "not_found" });
    const recovered = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(recovered.status).toBe(202);
    expect(recovered.json).toMatchObject({ key, decision: "accepted", requestedBy: "admin_7" });
    expect((await view(key)).decision).toEqual(recovered.json);
    expect((await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key })).json).toEqual(recovered.json);
  });

  it("authenticates the operation idempotency key before saving any original decision", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const key = requestKey();
    const altered = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key, signedIdempotencyKey: requestKey() });
    expect(altered.status).toBe(401);
    expect(altered.json).toEqual({ code: "unauthorized" });
    expect((await call(suite.baseUrl, `${base}/operations/${key}`)).status).toBe(404);
  });

  it("replays the original accepted W after its preview expires and through lookup", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const key = requestKey();
    const accepted = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(accepted.status).toBe(202);
    advance(120);
    const repeated = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(repeated.status).toBe(202);
    expect(repeated.json).toEqual(accepted.json);
    expect((await view(key)).decision).toEqual(accepted.json);
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM storage_reclaim_operations WHERE key=${key}`;
    expect(count!.n).toBe(1);
  });

  it("persists the first expired-preview refusal and keeps the scope free for a new preview", async () => {
    const fixture = await world();
    const body = await preview(fixture);
    const key = requestKey();
    advance(61);
    const refused = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ key, decision: "refused", reason: "preview_expired" });
    expect((await view(key)).decision).toEqual(refused.json);
    expect((await view(key)).operation).toBeNull();
    const replay = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(replay.json).toEqual(refused.json);
    expect(await approve(fixture)).not.toBe(key);
  });

  it.each(["actor", "body"])("rejects a conflicting %s under an already decided original key", async (change) => {
    const fixture = await world();
    const body = await preview(fixture);
    const key = requestKey();
    const saved = await call(suite.baseUrl, `${base}/operations`, { body, idempotencyKey: key });
    expect(saved.status).toBe(202);
    const conflict = await call(suite.baseUrl, `${base}/operations`, { body: change === "body" ? { ...body, items: [{ ...body.items[0], keptStorageKey: `uploads/${randomUUID()}.png` }] } : body, idempotencyKey: key, admin: change === "actor" ? "admin_8" : "admin_7" });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ code: "idempotency_conflict" });
    expect((await view(key)).decision).toEqual(saved.json);
  });

  it.each(["candidate", "keeper", "addition"])("refuses a %s scope substitution without retiring either key", async (change) => {
    const fixture = await world();
    const other = await world();
    const body = await preview(fixture);
    const items = change === "candidate" ? [scopeOf(other)] : change === "keeper" ? [{ ...scopeOf(fixture), keptStorageKey: other.keptStorageKey }] : [...body.items, scopeOf(other)];
    const refused = await call(suite.baseUrl, `${base}/operations`, { body: { ...body, items }, idempotencyKey: requestKey() });
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ decision: "refused", reason: "preview_mismatch" });
    expect(storage.deletes).toEqual([]);
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM storage_reclaim_objects`;
    expect(count!.n).toBe(0);
  });

  it.each(["enabled", "completed", "paused"])("retains the original association while %s", async (state) => {
    const fixture = await world();
    const original = await approve(fixture);
    if (state !== "enabled") await runMaintenanceLoopOnce();
    if (state === "paused") expect((await control(original, "pause", 1)).json.decision).toBe("saved");
    const candidate = await call(suite.baseUrl, `${base}/candidates?pageSize=100`);
    expect(candidate.status).toBe(200);
    expect(candidate.json.items).toContainEqual(expect.objectContaining({ id: fixture.id, operationKey: original }));
    const nextBody = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [fixture.id] } });
    expect(nextBody.status).toBe(200);
    const repeated = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: nextBody.json.previewId, items: [scopeOf(fixture)] }, idempotencyKey: requestKey() });
    expect(repeated.status).toBe(200);
    expect(repeated.json).toMatchObject({ decision: "refused", reason: "already_approved" });
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM storage_reclaim_objects WHERE storage_key=${fixture.storageKey}`;
    expect(count!.n).toBe(1);
  });
});

describe("independent controls and current switch", () => {
  it("replays an old saved control receipt while lookup returns the newer switch", async () => {
    const original = await approve(await world());
    const pauseKey = requestKey();
    const paused = await control(original, "pause", 1, pauseKey, "admin_8");
    expect(paused.status).toBe(200);
    expect(paused.json).toMatchObject({ key: pauseKey, operationKey: original, decision: "saved", action: "pause", state: "paused", version: 2, requestedBy: "admin_8" });
    const resumed = await control(original, "resume", 2, requestKey(), "admin_9");
    expect(resumed.json).toMatchObject({ decision: "saved", state: "enabled", version: 3 });
    const replay = await control(original, "pause", 1, pauseKey, "admin_8");
    expect(replay.json).toEqual(paused.json);
    const lookup = await call(suite.baseUrl, `${base}/controls/${pauseKey}`);
    expect(lookup.status).toBe(200);
    expect(lookup.json).toMatchObject({ decision: paused.json, maintenance: { state: "enabled", version: 3, changedBy: "admin_9" } });
    expect((await view(original)).decision.requestedBy).toBe("admin_7");
  });

  it("saves a version-conflict refusal and refuses changed actor or action on that control key", async () => {
    const original = await approve(await world());
    const key = requestKey();
    const refused = await control(original, "pause", 2, key);
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ decision: "refused", reason: "version_conflict", version: 1 });
    expect((await control(original, "pause", 2, key)).json).toEqual(refused.json);
    for (const [action, admin] of [["resume", "admin_7"], ["pause", "admin_8"]] as const) {
      const conflict = await control(original, action, 2, key, admin);
      expect(conflict.status).toBe(409);
      expect(conflict.json).toEqual({ code: "idempotency_conflict" });
    }
    expect((await view(original)).operation!.maintenance).toMatchObject({ state: "enabled", version: 1 });
  });

  it("recovers a previously unreceived control with the original key, body and actor", async () => {
    const original = await approve(await world());
    const key = requestKey();
    const absent = await call(suite.baseUrl, `${base}/controls/${key}`);
    expect(absent.status).toBe(404);
    const saved = await control(original, "pause", 1, key, "admin_8");
    expect(saved.json).toMatchObject({ key, requestedBy: "admin_8", version: 2 });
    expect((await control(original, "pause", 1, key, "admin_8")).json).toEqual(saved.json);
    expect((await view(original)).decision.requestedBy).toBe("admin_7");
  });
});

describe("bounded recurring physical maintenance", () => {
  it("executes at most the configured concurrent keys and respects the total batch budget", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => world()));
    const previewed = await call(suite.baseUrl, `${base}/preview`, { body: { ids: fixtures.map((fixture) => fixture.id) } });
    expect(previewed.status).toBe(200);
    const key = requestKey();
    expect((await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.json.previewId, items: fixtures.map(scopeOf) }, idempotencyKey: key })).status).toBe(202);
    setMaintenanceDependenciesForTest({ storage, config: { ...config, batchSize: 3, concurrency: 2 }, now: () => new Date(instant) });
    const latch = gate();
    let active = 0;
    let peak = 0;
    storage.beforeDelete = async () => {
      active++;
      peak = Math.max(peak, active);
      try { await latch.released; }
      finally { active--; }
    };
    const worker = runMaintenanceLoopOnce();
    try {
      await vi.waitFor(() => expect(active).toBe(2), { timeout: 750, interval: 10 });
      expect(storage.deletes).toHaveLength(2);
    } finally {
      latch.release();
      await worker;
    }
    expect(peak).toBe(2);
    expect(storage.deletes).toHaveLength(3);
    expect(new Set(storage.deletes).size).toBe(3);
    expect((await view(key)).operation!.firstRun!.items.filter((item) => item.state === "missing")).toHaveLength(3);
  });

  it("returns bounded history pages that traverse every run exactly once with stable first-run facts", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    await runMaintenanceLoopOnce();
    const first = await view(key);
    for (let number = 2; number <= 25; number++) {
      advance();
      await runMaintenanceLoopOnce();
    }
    const recent = await call(suite.baseUrl, `${base}/operations/${key}`);
    expect(recent.status).toBe(200);
    expect(recent.json.operation.runs).toHaveLength(20);
    expect(recent.json.operation.firstRun).toEqual(first.operation!.firstRun);
    expect(recent.json.operation.runsPage.nextCursor).toBe(recent.json.operation.runs.at(-1).id);
    let cursor: string | null = null;
    const collected: { id: string; number: number }[] = [];
    do {
      const page = await call(suite.baseUrl, `${base}/operations/${key}?runsPageSize=7${cursor ? `&runsCursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.json.decision).toEqual(first.decision);
      expect(page.json.operation.firstRun).toEqual(first.operation!.firstRun);
      expect(page.json.operation.runs.length).toBeLessThanOrEqual(7);
      collected.push(...page.json.operation.runs as { id: string; number: number }[]);
      cursor = page.json.operation.runsPage.nextCursor as string | null;
      expect(collected.length).toBeLessThanOrEqual(25);
    } while (cursor);
    expect(collected.map((run) => run.number)).toEqual(Array.from({ length: 25 }, (_unused, index) => 25 - index));
    expect(new Set(collected.map((run) => run.id)).size).toBe(25);
    expect(collected.at(-1)!.id).toBe(first.operation!.firstRun!.id);
    expect(storage.deletes).toEqual([fixture.storageKey]);
    await recordMaintenancePaginationPlans(suite.sql, key);
  });

  it("traverses every approved key across bounded ticks and revisits cleaned items in the next round", async () => {
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => world()));
    const selected = fixtures.map(scopeOf);
    const previewed = await call(suite.baseUrl, `${base}/preview`, { body: { ids: fixtures.map((fixture) => fixture.id) } });
    expect(previewed.status).toBe(200);
    expect(previewed.json.items.every((item: { eligible: boolean }) => item.eligible)).toBe(true);
    const key = requestKey();
    const approved = await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.json.previewId, items: selected }, idempotencyKey: key });
    expect(approved.status).toBe(202);
    setMaintenanceDependenciesForTest({ storage, config: { ...config, batchSize: 2 }, now: () => new Date(instant) });
    for (let tick = 0; tick < 3; tick++) {
      const before = storage.deletes.length;
      await runMaintenanceLoopOnce();
      expect(storage.deletes.length - before).toBeLessThanOrEqual(2);
    }
    const first = await view(key);
    expect(first.operation!.firstRun!.state).toBe("completed");
    expect(first.operation!.firstRun!.items).toHaveLength(5);
    expect(new Set(storage.deletes)).toEqual(new Set(fixtures.map((fixture) => fixture.storageKey)));
    for (const fixture of fixtures) storage.objects.add(fixture.storageKey);
    advance();
    const offset = storage.deletes.length;
    for (let tick = 0; tick < 3; tick++) {
      const before = storage.deletes.length;
      await runMaintenanceLoopOnce();
      expect(storage.deletes.length - before).toBeLessThanOrEqual(2);
    }
    expect(storage.deletes.slice(offset)).toHaveLength(5);
    expect(new Set(storage.deletes.slice(offset))).toEqual(new Set(fixtures.map((fixture) => fixture.storageKey)));
    const second = await view(key);
    expect(second.operation!.firstRun).toEqual(first.operation!.firstRun);
    expect(second.operation!.runs).toHaveLength(2);
    expect(second.operation!.scope).toEqual(selected);
    for (const fixture of fixtures) expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
  });

  it("shows executor availability separately from the saved owner switch and does no physical work while disabled", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    setMaintenanceDependenciesForTest({ storage, config: { ...config, enabled: false }, now: () => new Date(instant) });
    await runMaintenanceLoopOnce();
    const disabled = await view(key);
    expect(disabled.operation!.maintenance).toMatchObject({ state: "enabled", version: 1, executor: { enabled: false, configured: true, available: false } });
    expect(storage.deletes).toEqual([]);
    setMaintenanceDependenciesForTest({ storage, config: { ...config }, now: () => new Date(instant) });
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([fixture.storageKey]);
  });

  it("rediscovers a late copy on an already cleaned key while preserving the first run and W", async () => {
    const fixture = await world();
    const publicResult = await statusOf(fixture.userId, [fixture.storageKey]);
    expect(publicResult).toEqual([expect.objectContaining({ key: fixture.storageKey, state: "completed", result: expect.objectContaining({ assetId: fixture.assetId }) })]);
    const key = await approve(fixture);
    const accepted = (await view(key)).decision;
    await runMaintenanceLoopOnce();
    const first = await view(key);
    expect(first.operation!.firstRun).toMatchObject({ state: "completed", items: [expect.objectContaining({ state: "missing", storageKey: fixture.storageKey, checkedAt: instant.toISOString() })] });
    expect(first.operation!.latest[0]).toMatchObject({ state: "missing", checkedAt: instant.toISOString() });
    expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
    storage.objects.add(fixture.storageKey);
    advance();
    await runMaintenanceLoopOnce();
    const second = await view(key);
    expect(storage.deletes).toEqual([fixture.storageKey, fixture.storageKey]);
    expect(second.decision).toEqual(accepted);
    expect(second.operation!.firstRun).toEqual(first.operation!.firstRun);
    expect(second.operation!.runs.length).toBe(2);
    expect(second.operation!.latest[0]).toMatchObject({ state: "missing", checkedAt: instant.toISOString() });
    expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
    expect(await statusOf(fixture.userId, [fixture.storageKey])).toEqual(publicResult);
  });

  it("pauses new claims while retaining retirement and resumes the same exact scope", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const original = (await view(key)).decision;
    expect((await control(key, "pause", 1)).json.state).toBe("paused");
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([]);
    const paused = await view(key);
    if (paused.operation!.firstRun) expect(paused.operation!.firstRun.state).toBe("queued");
    expect((await control(key, "resume", 2)).json.state).toBe("enabled");
    await runMaintenanceLoopOnce();
    expect(storage.deletes).toEqual([fixture.storageKey]);
    expect((await view(key)).decision).toEqual(original);
  });

  it("keeps a known missing fact and its timestamp when a later HEAD fails", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    await runMaintenanceLoopOnce();
    const first = await view(key);
    const known = first.operation!.latest[0]!;
    advance();
    storage.headFailure = new Error("Synthetic storage read failure");
    await runMaintenanceLoopOnce();
    const second = await view(key);
    expect(second.operation!.latest[0]).toMatchObject({ state: "missing", checkedAt: known.checkedAt });
    expect(second.operation!.latest[0]!.reason).not.toBeNull();
    expect(second.operation!.firstRun).toEqual(first.operation!.firstRun);
  });

  it("records a definite DELETE failure as failed and first-run resume creates a new attempt", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const original = (await view(key)).decision;
    storage.deleteFailure = new Error("Synthetic definite delete failure");
    await runMaintenanceLoopOnce();
    const failed = await view(key);
    expect(failed.operation!.firstRun).toMatchObject({ state: "failed", items: [expect.objectContaining({ state: "failed" })] });
    expect(failed.operation!.latest[0]).toMatchObject({ state: "present", checkedAt: instant.toISOString(), reason: "storage_error" });
    const failedVersion = failed.operation!.firstRun!.items[0]!.leaseVersion;
    storage.deleteFailure = null;
    const resumeKey = requestKey();
    const resumed = await call(suite.baseUrl, `${base}/operations/${key}/resume`, { body: { expectedVersion: failed.operation!.maintenance.version }, idempotencyKey: resumeKey, admin: "admin_8" });
    expect(resumed.status).toBe(200);
    expect(resumed.json).toMatchObject({ key: resumeKey, operationKey: key, decision: "saved", requestedBy: "admin_8" });
    expect((await call(suite.baseUrl, `${base}/operations/${key}/resume`, { body: { expectedVersion: failed.operation!.maintenance.version }, idempotencyKey: resumeKey, admin: "admin_8" })).json).toEqual(resumed.json);
    await runMaintenanceLoopOnce();
    const completed = await view(key);
    expect(completed.decision).toEqual(original);
    expect(completed.operation!.firstRun).toMatchObject({ state: "completed", items: [expect.objectContaining({ state: "missing" })] });
    expect(completed.operation!.firstRun!.items[0]!.leaseVersion).toBeGreaterThan(failedVersion);
  });

  it("resumes only failed first-run items and preserves already completed first-run facts", async () => {
    const good = await world();
    const failing = await world();
    const previewed = await call(suite.baseUrl, `${base}/preview`, { body: { ids: [good.id, failing.id] } });
    expect(previewed.status).toBe(200);
    const key = requestKey();
    expect((await call(suite.baseUrl, `${base}/operations`, { body: { previewId: previewed.json.previewId, items: [scopeOf(good), scopeOf(failing)] }, idempotencyKey: key })).status).toBe(202);
    storage.beforeDelete = async (target) => { if (target === failing.storageKey) throw new Error("Synthetic selected item failure"); };
    await runMaintenanceLoopOnce();
    const partial = await view(key);
    expect(partial.operation!.firstRun!.state).toBe("partial");
    const completedItem = partial.operation!.firstRun!.items.find((item) => item.id === good.id);
    expect(completedItem!.state).toBe("missing");
    storage.beforeDelete = null;
    advance();
    const receipt = await call(suite.baseUrl, `${base}/operations/${key}/resume`, { body: { expectedVersion: partial.operation!.maintenance.version }, idempotencyKey: requestKey() });
    expect(receipt.json.decision).toBe("saved");
    await runMaintenanceLoopOnce();
    const complete = await view(key);
    expect(complete.operation!.firstRun!.state).toBe("completed");
    expect(complete.operation!.firstRun!.items.find((item) => item.id === good.id)).toEqual(completedItem);
    expect(storage.deletes.filter((target) => target === good.storageKey)).toHaveLength(1);
    expect(storage.deletes.filter((target) => target === failing.storageKey)).toHaveLength(2);
  });

  it("does not let switch resume erase a qualification conflict", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const other = await maintenanceWorld(suite.sql);
    await suite.sql`UPDATE studio_assets SET storage_key=${fixture.storageKey} WHERE id=${other.assetId}`;
    await runMaintenanceLoopOnce();
    const conflicted = await view(key);
    expect(conflicted.operation!.latest[0]).toMatchObject({ state: "conflict" });
    expect(storage.deletes).toEqual([]);
    expect((await control(key, "pause", 1)).json.decision).toBe("saved");
    expect((await control(key, "resume", 2)).json.decision).toBe("saved");
    advance();
    await runMaintenanceLoopOnce();
    expect((await view(key)).operation!.latest[0]).toMatchObject({ state: "conflict" });
    expect(storage.deletes).toEqual([]);
  });

  it("preserves exact delete identity across generated approved keys", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 1, maxLength: 4 }), async (rounds) => {
      await resetInternalRateLimit();
      const fixture = await world();
      const key = await approve(fixture);
      const neighbors = [`${fixture.storageKey}_cover`, `${fixture.storageKey}_upright`, `${fixture.storageKey}.preview.webp`, `${fixture.storageKey}/child`];
      for (const neighbor of neighbors) storage.objects.add(neighbor);
      const offset = storage.deletes.length;
      for (const _round of rounds) {
        storage.objects.add(fixture.storageKey);
        await runMaintenanceLoopOnce();
        advance();
      }
      expect(storage.deletes.slice(offset).filter((item) => item === fixture.storageKey)).toHaveLength(rounds.length);
      for (const neighbor of neighbors) expect(storage.objects.has(neighbor)).toBe(true);
      expect((await view(key)).operation!.scope).toEqual([scopeOf(fixture)]);
      expect(storage.objects.has(fixture.keptStorageKey)).toBe(true);
      await control(key, "pause", 1);
    }), { numRuns: 5, seed: 1791 });
  });

  it("keeps original W and monotone switch versions for generated control sequences", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("pause" as const, "resume" as const), { minLength: 1, maxLength: 6 }), async (actions) => {
      await resetInternalRateLimit();
      const key = await approve(await world());
      const original = (await view(key)).decision;
      let state = "enabled";
      let version = 1;
      for (const action of actions) {
        const nextState = action === "pause" ? "paused" : "enabled";
        const expectedVersion = version + Number(nextState !== state);
        const controlKey = requestKey();
        const response = await control(key, action, version, controlKey);
        expect(response.json).toMatchObject({ key: controlKey, decision: "saved", state: nextState, version: expectedVersion });
        expect((await control(key, action, version, controlKey)).json).toEqual(response.json);
        const current = await view(key);
        expect(current.decision).toEqual(original);
        expect(current.operation!.maintenance).toMatchObject({ state: nextState, version: expectedVersion });
        state = nextState;
        version = expectedVersion;
      }
      const current = await view(key);
      expect(current.operation!.scope).toHaveLength(1);
    }), { numRuns: 5, seed: 30 });
  });
});

describe("registration and retirement share an observed SQL lock", () => {
  it.each(["registration", "retirement"] as const)("serializes %s first under the exact same physical-key lock", async (first) => {
    const fixture = await world();
    const other = await maintenanceWorld(suite.sql);
    const key = await approve(fixture);
    const latch = gate();
    const qualification = gate();
    let retirement: Promise<unknown> | undefined;
    if (first === "retirement") {
      let firstKeptHead = true;
      storage.beforeHead = async (target) => {
        if (target === fixture.keptStorageKey && firstKeptHead) {
          firstKeptHead = false;
          qualification.enter();
          await qualification.released;
        }
      };
      retirement = runMaintenanceLoopOnce();
      await qualification.entered;
    }
    const holder = suite.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fixture.storageKey},1791))`;
      latch.enter();
      await latch.released;
    });
    await latch.entered;
    const input = { studioId: other.studioId, producedByUserId: other.userId, contentHash: other.contentHash.replace(/^./, other.contentHash[0] === "0" ? "1" : "0"), storageKey: fixture.storageKey, fileUrl: `https://cdn.example.test/${fixture.storageKey}`, sizeBytes: 128, mimeType: "image/png", kind: "image" as const, source: "upload" as const };
    let registration: Promise<Awaited<ReturnType<typeof registerWithDedup>>> | undefined;
    try {
      if (first === "registration") registration = registerWithDedup(input);
      else qualification.release();
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"]);
      if (first === "registration") retirement = runMaintenanceLoopOnce();
      else registration = registerWithDedup(input);
      // The second observed waiter proves the opposing operation really reached
      // the shared lock while the first party was still parked behind our gate.
      await waitUntilBlockedOn(suite.sql, ["pg_advisory_xact_lock"], 2);
    } finally {
      qualification.release();
      latch.release();
      await holder;
    }
    const [registered, reclaimed] = await Promise.allSettled([registration!, retirement!]);
    expect(reclaimed.status).toBe("fulfilled");
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM studio_assets WHERE storage_key=${fixture.storageKey} AND deleted_at IS NULL`;
    if (first === "registration") {
      expect(registered.status).toBe("fulfilled");
      expect(count!.n).toBe(1);
      expect(storage.deletes).toEqual([]);
      expect((await view(key)).operation!.latest[0]).toMatchObject({ state: "conflict", reason: "live_reference" });
    } else {
      expect(registered.status).toBe("rejected");
      expect(count!.n).toBe(0);
      expect(storage.deletes).toEqual([fixture.storageKey]);
      expect((await view(key)).operation!.latest[0]).toMatchObject({ state: "missing" });
    }
  });

  it("returns the original canonical row after retirement for a late same-grant registration", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    await runMaintenanceLoopOnce();
    const late = await registerWithDedup({ studioId: fixture.studioId, producedByUserId: fixture.userId, contentHash: fixture.contentHash, storageKey: fixture.storageKey, fileUrl: `https://cdn.example.test/${fixture.storageKey}`, sizeBytes: 128, mimeType: "image/png", kind: "image", source: "upload" });
    expect(late).toMatchObject({ deduped: true, asset: { id: fixture.assetId, storageKey: fixture.keptStorageKey } });
    const [count] = await suite.sql<{ n: number }[]>`SELECT count(*)::int n FROM studio_assets WHERE storage_key=${fixture.storageKey} AND deleted_at IS NULL`;
    expect(count!.n).toBe(0);
    expect((await view(key)).operation!.firstRun!.state).toBe("completed");
  });
});

describe("lease takeover and persistent pause boundaries", () => {
  it.each(["TimeoutError", "AbortError", "RequestTimeout", "NetworkingError"])("keeps %s DELETE responses unknown until direct HEAD proves absence", async (name) => {
    const fixture = await world();
    const key = await approve(fixture);
    const error = new Error("Synthetic request completion unknown");
    error.name = name;
    storage.deleteFailure = error;
    await runMaintenanceLoopOnce();
    const unknown = await view(key);
    expect(unknown.operation!.firstRun).toMatchObject({ state: "running", items: [expect.objectContaining({ state: "unknown", reason: "delete_unknown" })] });
    expect(unknown.operation!.latest[0]).toMatchObject({ state: "present", reason: "delete_unknown" });
    expect((await control(key, "pause", 1)).json.decision).toBe("saved");
    storage.objects.delete(fixture.storageKey);
    advance(6);
    await runMaintenanceLoopOnce();
    const checked = await view(key);
    expect(checked.operation!.firstRun!.state).toBe("completed");
    expect(checked.operation!.latest[0]).toMatchObject({ state: "missing" });
    expect(storage.deletes).toEqual([fixture.storageKey]);
  });

  it("refuses a second physical claim while the first holder's lease remains valid", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const latch = gate();
    storage.beforeDelete = async () => { latch.enter(); await latch.released; };
    const active = runMaintenanceLoopOnce();
    try {
      await latch.entered;
      await runMaintenanceLoopOnce();
      expect(storage.deletes).toEqual([fixture.storageKey]);
      expect((await view(key)).operation!.firstRun!.items[0]!.leaseVersion).toBe(1);
      const [lease] = await suite.sql<{ lease_version: number; in_flight: boolean }[]>`SELECT lease_version,in_flight FROM storage_reclaim_objects WHERE storage_key=${fixture.storageKey}`;
      expect(lease).toMatchObject({ lease_version: 1, in_flight: true });
    } finally {
      latch.release();
      await active;
    }
  });

  it("archives a former lease's late failure without replacing the takeover's missing fact", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const latch = gate();
    let firstDelete = true;
    storage.beforeDelete = async (target) => {
      if (target === fixture.storageKey && firstDelete) {
        firstDelete = false;
        latch.enter();
        await latch.released;
        throw new Error("Synthetic old-holder failure after takeover");
      }
    };
    const oldHolder = runMaintenanceLoopOnce();
    try {
      await latch.entered;
      advance(6);
      await runMaintenanceLoopOnce();
      const takeover = await view(key);
      expect(takeover.operation!.latest[0]).toMatchObject({ state: "missing", leaseVersion: 2, checkedAt: instant.toISOString() });
      latch.release();
      await oldHolder;
      const afterOldFailure = await view(key);
      expect(afterOldFailure.operation!.latest).toEqual(takeover.operation!.latest);
      expect(afterOldFailure.operation!.firstRun).toEqual(takeover.operation!.firstRun);
      const attempts = await suite.sql<{ lease_version: number; result: { state: string } }[]>`SELECT a.lease_version,a.result FROM storage_reclaim_attempts a JOIN storage_reclaim_objects o ON o.id=a.object_id WHERE o.storage_key=${fixture.storageKey}`;
      expect(attempts).toContainEqual(expect.objectContaining({ lease_version: 1, result: expect.objectContaining({ state: "failed" }) }));
      expect(attempts).toContainEqual(expect.objectContaining({ lease_version: 2, result: expect.objectContaining({ state: "missing" }) }));
      const [object] = await suite.sql<{ lease_version: number; retired_at: Date | null }[]>`SELECT lease_version,retired_at FROM storage_reclaim_objects WHERE storage_key=${fixture.storageKey}`;
      expect(object!.lease_version).toBe(2);
      expect(object!.retired_at).not.toBeNull();
    } finally {
      latch.release();
      await oldHolder;
    }
  });

  it("checks persistent pause after an in-flight HEAD and does not issue a new DELETE", async () => {
    const fixture = await world();
    const key = await approve(fixture);
    const latch = gate();
    let firstHead = true;
    storage.beforeHead = async (target) => {
      if (target === fixture.storageKey && firstHead) {
        firstHead = false;
        latch.enter();
        await latch.released;
      }
    };
    const worker = runMaintenanceLoopOnce();
    try {
      await latch.entered;
      const paused = await control(key, "pause", 1);
      expect(paused.json).toMatchObject({ decision: "saved", state: "paused", version: 2 });
      latch.release();
      await worker;
      expect(storage.deletes).toEqual([]);
      expect(storage.objects.has(fixture.storageKey)).toBe(true);
      expect((await view(key)).operation!.maintenance.state).toBe("paused");
    } finally {
      latch.release();
      await worker;
    }
  });

  it.each(["present", "missing"] as const)("allows paused HEAD-only takeover for an unresolved issued DELETE when the object is %s", async (fact) => {
    const fixture = await world();
    const key = await approve(fixture);
    const latch = gate();
    let firstDelete = true;
    storage.beforeDelete = async (target) => {
      if (target === fixture.storageKey && firstDelete) {
        firstDelete = false;
        if (fact === "missing") storage.objects.delete(target);
        latch.enter();
        await latch.released;
      }
    };
    const issued = runMaintenanceLoopOnce();
    try {
      await latch.entered;
      expect((await control(key, "pause", 1)).json.decision).toBe("saved");
      advance(6);
      const headCount = storage.heads.length;
      await runMaintenanceLoopOnce();
      expect(storage.deletes).toEqual([fixture.storageKey]);
      expect(storage.heads.slice(headCount)).toContain(fixture.storageKey);
      const recovered = await view(key);
      expect(recovered.operation!.maintenance.state).toBe("paused");
      if (fact === "missing") {
        expect(recovered.operation!.firstRun!.state).toBe("completed");
        expect(recovered.operation!.latest[0]).toMatchObject({ state: "missing" });
      } else {
        expect(recovered.operation!.firstRun!.state).toBe("running");
        expect(recovered.operation!.firstRun!.items[0]).toMatchObject({ state: "unknown" });
      }
    } finally {
      latch.release();
      await issued;
    }
  });
});
