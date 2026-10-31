// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { assetRepo, projectActivitiesRepo, type ProjectMediaBackfillCandidate, type ProjectMediaBackfillSource } from "@breatic/core";
import type * as CoreModule from "@breatic/core";
import type { NodeHistoryEntity, ProjectActivityEntry, StudioAssetEntity, TaskEntity } from "@breatic/shared";
import * as grants from "../upload-grant.repo.js";
import type { UploadGrant } from "../upload-grant.repo.js";
import * as history from "../../node-history/node-history.repo.js";
import * as tasks from "../../task/task.repo.js";
import { createBusinessProjectMediaBackfillSources } from "../project-media-backfill.service.js";

vi.mock("@breatic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    assetRepo: { ...actual.assetRepo, scanGenerationMediaAssets: vi.fn() },
    projectActivitiesRepo: { ...actual.projectActivitiesRepo, scanMediaBackfill: vi.fn() },
  };
});
vi.mock("../upload-grant.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof grants>()), scanConsumedMediaGrants: vi.fn(),
}));
vi.mock("../../node-history/node-history.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof history>()), scanSuccessfulMediaHistory: vi.fn(),
}));
vi.mock("../../task/task.repo.js", async (importOriginal) => ({
  ...(await importOriginal<typeof tasks>()), findLiveTasksByIds: vi.fn(),
}));

const PROJECT = "10000000-0000-4000-8000-000000000001";
const OTHER_PROJECT = "10000000-0000-4000-8000-000000000002";
const ASSET = "20000000-0000-4000-8000-000000000001";
const OTHER_ASSET = "20000000-0000-4000-8000-000000000002";
const TASK = "30000000-0000-4000-8000-000000000001";
const OTHER_TASK = "30000000-0000-4000-8000-000000000002";
const ROW = "40000000-0000-4000-8000-000000000001";
const OTHER_ROW = "40000000-0000-4000-8000-000000000002";
const WHEN = new Date("2026-01-01T00:00:00.000Z");
const URL = "https://cdn.example/registered-video.mp4";
const COVER = "https://cdn.example/registered-cover.jpg";

/** Construct the consumed ledger's explicit identity and Project provenance. */
function grant(overrides: Partial<UploadGrant> = {}): UploadGrant {
  return { id: ROW, userId: "producer", studioId: "studio", storageKey: "unrelated-storage-key", declaredSize: 12,
    consumedAt: WHEN, voidedAt: null, assetId: ASSET, failureReason: null, expiresAt: WHEN, nodeId: null,
    projectId: PROJECT, spaceId: null, source: null, toolName: null, derived: null, filename: "Launch.mp4",
    assetSource: "upload", generationTaskId: null, analyticsConsent: null, createdAt: WHEN, ...overrides };
}

/** Construct one actual history writer's successful row. */
function historyRow(overrides: Partial<NodeHistoryEntity> = {}): NodeHistoryEntity {
  return { id: ROW, projectId: PROJECT, nodeId: "node", userId: "producer", operatorName: null,
    entryType: "generation", status: "success", content: URL, thumbnailUrl: COVER, errorMessage: null,
    taskId: TASK, metadata: {}, mediaWidth: null, mediaHeight: null, duration: null, mimeType: null, size: null, createdAt: WHEN, ...overrides };
}

/** Construct a live task with its own Project and actual task type. */
function task(overrides: Partial<TaskEntity> = {}): TaskEntity {
  return { id: TASK, userId: "producer", projectId: PROJECT, spaceId: "space", taskType: "video", mode: "append",
    model: null, status: "completed", params: {}, result: null, errorMessage: null, arqJobId: null,
    startedAt: WHEN, completedAt: WHEN, creditsUsed: 0, durationMs: null, source: "task",
    providerResultUrl: "https://provider.example/temporary.mp4", providerTaskId: null,
    billedAt: null, billedCredits: null, deletedAt: null, createdAt: WHEN, updatedAt: WHEN, ...overrides };
}

/** Construct canonical ledger metadata without inferring its Project from producer data. */
function asset(overrides: Partial<StudioAssetEntity> = {}): StudioAssetEntity {
  return { id: ASSET, studioId: "studio", contentHash: "same-content-hash", storageKey: "registered-storage-key", fileUrl: URL,
    sizeBytes: 12, mimeType: "video/mp4", kind: "video", source: "ai", producedByUserId: "producer",
    generationTaskId: TASK, width: null, height: null, durationSeconds: null, createdAt: WHEN, deletedAt: null, ...overrides };
}

/** Construct a typed activity retaining legacy payload data for classification. */
function activity(overrides: Partial<ProjectActivityEntry> = {}): ProjectActivityEntry {
  return { id: ROW, projectId: PROJECT, actorUserId: "producer", actorName: null, type: "asset:uploaded",
    spaceId: null, nodeId: null, taskId: null, payload: { kind: "video", fileUrl: URL, thumbnailUrl: COVER },
    restored: false, createdAt: WHEN.getTime(), ...overrides };
}

/** Retrieve a required business adapter by its stable maintenance-report name. */
function source(name: string): ProjectMediaBackfillSource {
  const found = createBusinessProjectMediaBackfillSources().find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing source ${name}`);
  return found;
}

/** Read the one candidate supplied by a test's single source row. */
async function candidate(name: string): Promise<ProjectMediaBackfillCandidate> {
  const rows = await source(name).readPage(null, 17);
  expect(rows).toHaveLength(1);
  const first = rows[0];
  if (first === undefined) throw new Error("The source did not retain its input row");
  return first;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(grants.scanConsumedMediaGrants).mockResolvedValue([]);
  vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([]);
  vi.mocked(projectActivitiesRepo.scanMediaBackfill).mockResolvedValue([]);
  vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([]);
  vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([]);
});

describe("business backfill source boundaries", () => {
  it("exposes the four independently owned provenance sources in stable order", () => {
    expect(createBusinessProjectMediaBackfillSources().map((item) => item.name)).toEqual(["consumed_grants", "node_history", "media_activities", "generation_assets"]);
  });
  it.each(["consumed_grants", "node_history", "media_activities", "generation_assets"])("passes the exact cursor and batch limit to %s's owner", async (name) => {
    const scanner = name === "consumed_grants" ? vi.mocked(grants.scanConsumedMediaGrants)
      : name === "node_history" ? vi.mocked(history.scanSuccessfulMediaHistory)
        : name === "media_activities" ? vi.mocked(projectActivitiesRepo.scanMediaBackfill) : vi.mocked(assetRepo.scanGenerationMediaAssets);
    expect(await source(name).readPage("opaque-owner-cursor", 23)).toEqual([]);
    expect(scanner).toHaveBeenCalledExactlyOnceWith("opaque-owner-cursor", 23);
  });
  it.each(["consumed_grants", "node_history", "media_activities", "generation_assets"])("preserves %s scanner failures as the original Error", async (name) => {
    const error = new Error(`Scanner failed: ${name}`);
    const scanner = name === "consumed_grants" ? vi.mocked(grants.scanConsumedMediaGrants)
      : name === "node_history" ? vi.mocked(history.scanSuccessfulMediaHistory)
        : name === "media_activities" ? vi.mocked(projectActivitiesRepo.scanMediaBackfill) : vi.mocked(assetRepo.scanGenerationMediaAssets);
    scanner.mockRejectedValueOnce(error);
    await expect(source(name).readPage(null, 23)).rejects.toBe(error);
  });
});

describe("consumed upload-grant provenance", () => {
  it("uses the grant's fixed asset identity and filename despite unrelated storage or producer values", async () => {
    vi.mocked(grants.scanConsumedMediaGrants).mockResolvedValue([grant({ storageKey: OTHER_ASSET, userId: OTHER_PROJECT })]);
    const row = await candidate("consumed_grants");
    expect(row).toMatchObject({ id: ROW, cursor: ROW, projectId: PROJECT, assetIds: [ASSET], displayNames: { [ASSET]: "Launch.mp4" } });
    expect(row.urls ?? []).toEqual([]);
    expect(row.reason).toBeUndefined();
    expect(tasks.findLiveTasksByIds).not.toHaveBeenCalled();
  });
  it("retains a canonical asset without manufacturing a missing filename", async () => {
    vi.mocked(grants.scanConsumedMediaGrants).mockResolvedValue([grant({ filename: null })]);
    const row = await candidate("consumed_grants");
    expect(row.assetIds).toEqual([ASSET]);
    expect(row.displayNames ?? {}).toEqual({});
  });
  it.each([{ projectId: null }, { assetId: null }, { projectId: null, assetId: null }])("reports insufficient grant provenance for %j", async (missing) => {
    vi.mocked(grants.scanConsumedMediaGrants).mockResolvedValue([grant(missing)]);
    const row = await candidate("consumed_grants");
    expect(row).toMatchObject({ id: ROW, cursor: ROW, projectId: missing.projectId === null ? null : PROJECT, reason: "insufficient_media_provenance" });
    expect(row.assetIds ?? []).toEqual([]);
    expect(row.urls ?? []).toEqual([]);
  });
});

describe("successful node-history provenance", () => {
  it("accepts an explicit upload and its cover without requiring generation-task evidence", async () => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ entryType: "upload", taskId: null })]);
    const row = await candidate("node_history");
    expect(row).toMatchObject({ id: ROW, cursor: ROW, projectId: PROJECT, urls: [URL, COVER] });
    expect(row.reason).toBeUndefined();
  });
  it("keeps a proven history reference when no thumbnail was recorded", async () => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ entryType: "upload", taskId: null, thumbnailUrl: null })]);
    expect(await candidate("node_history")).toMatchObject({ urls: [URL] });
  });
  it.each([null, ""])("reports an upload with unusable content %j", async (content) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ entryType: "upload", content })]);
    expect(await candidate("node_history")).toMatchObject({ reason: "insufficient_media_provenance" });
  });
  it.each(["image/png", "VIDEO/MP4", "audio/mpeg", "model/gltf-binary"])("accepts actual media MIME %s when the task no longer exists", async (mimeType) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ mimeType })]);
    const row = await candidate("node_history");
    expect(row).toMatchObject({ projectId: PROJECT, urls: [URL, COVER] });
    expect(row.reason).toBeUndefined();
  });
  it.each(["image", "video", "audio", "tts", "three_d"])("uses a same-Project live %s task as media evidence", async (taskType) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow()]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task({ taskType })]);
    const row = await candidate("node_history");
    expect(row.urls).toEqual([URL, COVER]);
    expect(row.reason).toBeUndefined();
  });
  it("keeps text-generation URLs unclassified when the task type and MIME do not establish media", async () => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ mimeType: "text/plain" })]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task({ taskType: "text" })]);
    const row = await candidate("node_history");
    expect(row.reason).toBe("insufficient_media_provenance");
    expect(row.urls ?? []).toEqual([]);
  });
  it.each([null, TASK])("reports missing generation-task evidence for task %j", async (taskId) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ taskId })]);
    expect(await candidate("node_history")).toMatchObject({ reason: "missing_generation_task" });
  });
  it.each([OTHER_PROJECT, null])("refuses a task belonging to Project %j as evidence for this history row", async (projectId) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow()]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task({ projectId })]);
    const row = await candidate("node_history");
    expect(row).toMatchObject({ projectId: PROJECT, reason: "insufficient_media_provenance" });
    expect(row.urls ?? []).toEqual([]);
  });
  it("retains MIME-proven media even when a surviving task belongs to a different Project", async () => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ mimeType: "image/png" })]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task({ projectId: OTHER_PROJECT })]);
    const row = await candidate("node_history");
    expect(row.urls).toEqual([URL, COVER]);
    expect(row.reason).toBeUndefined();
  });
  it("keeps snapshot text URL-like content out of media references for arbitrary text", async () => {
    await fc.assert(fc.asyncProperty(fc.webUrl(), async (content) => {
      vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ entryType: "snapshot", content, mimeType: "video/mp4" })]);
      vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task()]);
      const row = await candidate("node_history");
      expect(row).toMatchObject({ id: ROW, cursor: ROW, projectId: PROJECT, reason: "insufficient_media_provenance" });
      expect(row.urls ?? []).toEqual([]);
    }));
  });
  it.each([null, ""])("keeps a generation with empty content %j unclassified despite media evidence", async (content) => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow({ content, mimeType: "video/mp4" })]);
    const row = await candidate("node_history");
    expect(row.reason).toBe("insufficient_media_provenance");
    expect(row.urls ?? []).toEqual([]);
  });
  it("looks up each page's distinct generation task identities in one bounded batch", async () => {
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([
      historyRow(), historyRow({ id: OTHER_ROW }), historyRow({ id: "40000000-0000-4000-8000-000000000003", taskId: OTHER_TASK }), historyRow({ id: "40000000-0000-4000-8000-000000000004", entryType: "upload", taskId: null }),
    ]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task(), task({ id: OTHER_TASK })]);
    const rows = await source("node_history").readPage("history-cursor", 29);
    expect(rows).toHaveLength(4);
    expect(tasks.findLiveTasksByIds).toHaveBeenCalledTimes(1);
    const ids = vi.mocked(tasks.findLiveTasksByIds).mock.calls[0]?.[0] ?? [];
    expect([...ids].sort()).toEqual([TASK, OTHER_TASK]);
    expect(history.scanSuccessfulMediaHistory).toHaveBeenCalledExactlyOnceWith("history-cursor", 29);
  });
  it("preserves task lookup errors instead of reporting missing provenance", async () => {
    const error = new Error("Task database unavailable");
    vi.mocked(history.scanSuccessfulMediaHistory).mockResolvedValue([historyRow()]);
    vi.mocked(tasks.findLiveTasksByIds).mockRejectedValueOnce(error);
    await expect(source("node_history").readPage(null, 17)).rejects.toBe(error);
  });
});

describe("explicit media activity provenance", () => {
  it.each(["asset:uploaded", "generation:succeeded"] as const)("accepts %s only with explicit renderable media fields", async (type) => {
    vi.mocked(projectActivitiesRepo.scanMediaBackfill).mockResolvedValue([activity({ type })]);
    const row = await candidate("media_activities");
    expect(row).toMatchObject({ id: ROW, cursor: ROW, projectId: PROJECT, urls: [URL, COVER] });
    expect(row.reason).toBeUndefined();
  });
  it.each(["image", "video", "audio"])("accepts declared activity kind %s", async (kind) => {
    vi.mocked(projectActivitiesRepo.scanMediaBackfill).mockResolvedValue([activity({ payload: { kind, fileUrl: URL } })]);
    expect(await candidate("media_activities")).toMatchObject({ urls: [URL] });
  });
  it.each([{ fileUrl: URL }, { kind: "video" }, { kind: "video", fileUrl: "" }, { kind: "document", fileUrl: URL }, { kind: "3d", fileUrl: URL }])("reports legacy activity payload %j as insufficient", async (payload) => {
    vi.mocked(projectActivitiesRepo.scanMediaBackfill).mockResolvedValue([activity({ payload })]);
    const row = await candidate("media_activities");
    expect(row.reason).toBe("insufficient_media_provenance");
    expect(row.urls ?? []).toEqual([]);
  });
  it("does not interpret a non-media activity's arbitrary URL-like payload", async () => {
    vi.mocked(projectActivitiesRepo.scanMediaBackfill).mockResolvedValue([activity({ type: "space:renamed" })]);
    const row = await candidate("media_activities");
    expect(row.reason).toBe("insufficient_media_provenance");
    expect(row.urls ?? []).toEqual([]);
  });
});

describe("canonical asset generation-task provenance", () => {
  it.each(["ai", "upload", "cover", "project_cover", "studio_avatar", "agent"] as const)("uses a live task's Project for canonical asset source %s", async (origin) => {
    vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([asset({ source: origin })]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task()]);
    const row = await candidate("generation_assets");
    expect(row).toMatchObject({ id: ASSET, cursor: ASSET, projectId: PROJECT, assetIds: [ASSET] });
    expect(row.urls ?? []).toEqual([]);
    expect(row.reason).toBeUndefined();
  });
  it("reports a missing live task without guessing Project from the producer, key or hash", async () => {
    vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([asset({ producedByUserId: PROJECT, storageKey: PROJECT, contentHash: PROJECT })]);
    const row = await candidate("generation_assets");
    expect(row).toMatchObject({ id: ASSET, cursor: ASSET, projectId: null, reason: "missing_generation_task" });
    expect(row.assetIds ?? []).toEqual([]);
  });
  it("reports a live task without a Project as insufficient provenance", async () => {
    vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([asset()]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task({ projectId: null })]);
    expect(await candidate("generation_assets")).toMatchObject({ id: ASSET, cursor: ASSET, projectId: null, reason: "insufficient_media_provenance" });
  });
  it("resolves all distinct generation-task identities in one bounded page lookup", async () => {
    vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([
      asset(), asset({ id: OTHER_ASSET }), asset({ id: "20000000-0000-4000-8000-000000000003", generationTaskId: OTHER_TASK }),
    ]);
    vi.mocked(tasks.findLiveTasksByIds).mockResolvedValue([task(), task({ id: OTHER_TASK, projectId: OTHER_PROJECT })]);
    const rows = await source("generation_assets").readPage("asset-cursor", 31);
    expect(rows.map((row) => ({ id: row.id, projectId: row.projectId, assetIds: row.assetIds }))).toEqual([
      { id: ASSET, projectId: PROJECT, assetIds: [ASSET] }, { id: OTHER_ASSET, projectId: PROJECT, assetIds: [OTHER_ASSET] },
      { id: "20000000-0000-4000-8000-000000000003", projectId: OTHER_PROJECT, assetIds: ["20000000-0000-4000-8000-000000000003"] },
    ]);
    expect(tasks.findLiveTasksByIds).toHaveBeenCalledTimes(1);
    expect([...(vi.mocked(tasks.findLiveTasksByIds).mock.calls[0]?.[0] ?? [])].sort()).toEqual([TASK, OTHER_TASK]);
    expect(assetRepo.scanGenerationMediaAssets).toHaveBeenCalledExactlyOnceWith("asset-cursor", 31);
  });
  it("preserves task lookup failures as the original error", async () => {
    const error = new Error("Task batch read failed");
    vi.mocked(assetRepo.scanGenerationMediaAssets).mockResolvedValue([asset()]);
    vi.mocked(tasks.findLiveTasksByIds).mockRejectedValueOnce(error);
    await expect(source("generation_assets").readPage(null, 17)).rejects.toBe(error);
  });
});
