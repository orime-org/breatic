// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ProjectAssetReferenceEntity, StudioAssetEntity } from "@breatic/shared";
import { AppError, ForbiddenError, NotFoundError } from "@core/app-errors.js";
import { getTimelineConfig } from "@core/config/timeline.js";
import type * as TimelineConfigModule from "@core/config/timeline.js";
import { inspectRegisteredProjectMedia, ProjectMediaScopeUnavailableError, referenceRegisteredProjectMediaDetailed } from "@core/asset/project-asset-reference.service.js";
import type * as ReferenceServiceModule from "@core/asset/project-asset-reference.service.js";
import type { RegisteredProjectMediaInspection, RegisteredProjectMediaResolution } from "@core/asset/project-asset-reference.service.js";
import {
  runProjectMediaBackfill,
  type ProjectMediaBackfillCandidate,
  type ProjectMediaBackfillPosition,
  type ProjectMediaBackfillRecord,
  type ProjectMediaBackfillRow,
  type ProjectMediaBackfillSource,
  type ProjectMediaBackfillSummary,
  type RunProjectMediaBackfillInput,
} from "@core/asset/project-media-backfill.js";

vi.mock("@core/config/timeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TimelineConfigModule>()), getTimelineConfig: vi.fn(),
}));
vi.mock("@core/asset/project-asset-reference.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ReferenceServiceModule>()),
  inspectRegisteredProjectMedia: vi.fn(), referenceRegisteredProjectMediaDetailed: vi.fn(),
}));

type Mode = RunProjectMediaBackfillInput["mode"];
type Pass = ProjectMediaBackfillPosition["pass"];
const MODES: readonly Mode[] = ["report", "apply"];
const PROJECT = "30000000-0000-4000-8000-000000000001";
const STUDIO = "20000000-0000-4000-8000-000000000001";
const ASSET: StudioAssetEntity = {
  id: "10000000-0000-4000-8000-000000000001", studioId: STUDIO,
  contentHash: "registered-hash-1", storageKey: "media/one.mp4", fileUrl: "https://cdn.example/one.mp4",
  sizeBytes: 2048, mimeType: "video/mp4", kind: "video", source: "upload",
  producedByUserId: "40000000-0000-4000-8000-000000000001", generationTaskId: null,
  width: 1280, height: 720, durationSeconds: 2, createdAt: new Date(0), deletedAt: null,
};
const OTHER_ASSET: StudioAssetEntity = { ...ASSET, id: "10000000-0000-4000-8000-000000000002", storageKey: "media/two.mp4", fileUrl: "https://cdn.example/two.mp4" };
const CONFIG = { defaults: { width: 1920, height: 1080, fps: { num: 24, den: 1 } }, assets: { page_size: 50, page_max: 100, backfill_batch_size: 2 } };

/**
 * Preserve candidate and classification fixtures as read-only boundary inputs.
 * @param value - A fixture whose original identities must survive the run.
 * @returns The same recursively frozen fixture.
 * @throws {never} Never.
 */
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Construct an existing relationship using the canonical registered identity.
 * @param asset - The actual ledger row returned by the service boundary.
 * @returns Its Project relationship.
 * @throws {never} Never.
 */
function reference(asset: StudioAssetEntity): ProjectAssetReferenceEntity {
  return { id: asset.id.replace(/^1/, "5"), projectId: PROJECT, assetId: asset.id, displayName: "Original video.mp4", createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null };
}

/**
 * Construct one stable provenance row with a verbatim opaque cursor.
 * @param id - The original source row identity.
 * @param overrides - The specific boundary exercised by a test.
 * @returns The scanner's unchanged candidate contract.
 * @throws {never} Never.
 */
function candidate(id: string, overrides: Partial<ProjectMediaBackfillCandidate> = {}): ProjectMediaBackfillCandidate {
  return { id, cursor: "cursor:" + id, projectId: PROJECT, assetIds: [ASSET.id], ...overrides };
}

/**
 * Return bounded stable pages through the injected repository-owned adapter.
 * @param name - The source name appearing in checkpoints and summaries.
 * @param rows - Stable scanner candidates in cursor order.
 * @returns A source whose calls expose the requested cursor and page bound.
 * @throws {Error} When a test requests an unknown resume cursor.
 */
function source(name: string, rows: readonly ProjectMediaBackfillCandidate[]): ProjectMediaBackfillSource {
  return {
    name,
    readPage: vi.fn(async (cursor: string | null, limit: number) => {
      const index = cursor === null ? -1 : rows.findIndex((row) => row.cursor === cursor);
      if (cursor !== null && index === -1) throw new Error("Unknown fixture cursor: " + cursor);
      return rows.slice(index + 1, index + 1 + limit);
    }),
  };
}

/**
 * Keep each emitted object so later mutation cannot rewrite prior row facts.
 * @returns A report sink and its original recorded objects.
 * @throws {never} Never.
 */
function sink(): { records: ProjectMediaBackfillRecord[]; emit: RunProjectMediaBackfillInput["emit"] } {
  const records: ProjectMediaBackfillRecord[] = [];
  return { records, emit: vi.fn(async (record) => { records.push(record); }) };
}

/**
 * Read just candidate records from the real runner output.
 * @param records - Objects emitted through the reporting boundary.
 * @returns Every candidate in emission order.
 * @throws {never} Never.
 */
function candidates(records: readonly ProjectMediaBackfillRecord[]): ProjectMediaBackfillRow[] {
  return records.filter((record): record is ProjectMediaBackfillRow => record.type === "candidate");
}

/**
 * Read per-source completion records without inventing a global unique total.
 * @param records - Objects emitted through the reporting boundary.
 * @returns Every source and pass completion in emission order.
 * @throws {never} Never.
 */
function summaries(records: readonly ProjectMediaBackfillRecord[]): ProjectMediaBackfillSummary[] {
  return records.filter((record): record is ProjectMediaBackfillSummary => record.type === "source_complete");
}

/**
 * Specify one source's totals for its actually emitted candidate subset.
 * @param name - The source name selected for this invocation.
 * @param pass - Its actual scan pass.
 * @param count - Rows in this invocation using the default existing asset fixture.
 * @param mode - The requested maintenance mode.
 * @returns The independently specified complete summary.
 * @throws {never} Never.
 */
function summary(name: string, pass: Pass, count: number, mode: Mode = "report"): ProjectMediaBackfillSummary {
  return { type: "source_complete", mode, pass, source: name, candidates: count, resolvedAssets: count, existingAssets: count, insertedAssets: 0, unavailableReferences: 0, reasons: {} };
}

/**
 * Specify an unchanged candidate's report identity and canonical classification.
 * @param row - The original source row.
 * @param name - The adapter that read it.
 * @param pass - The actual pass in which it was emitted.
 * @param mode - The requested maintenance mode.
 * @returns The complete expected default row.
 * @throws {never} Never.
 */
function defaultRow(row: ProjectMediaBackfillCandidate, name: string, pass: Pass, mode: Mode = "report"): ProjectMediaBackfillRow {
  return { type: "candidate", mode, pass, source: name, cursor: row.cursor, rowId: row.id, projectId: row.projectId, resolved: [{ kind: "assetId", reference: ASSET.id, assetId: ASSET.id }], unavailable: [], existingAssetIds: [ASSET.id], insertedAssetIds: [], reason: null };
}

/**
 * Hold an asynchronous reporting boundary until the test permits advancement.
 * @returns Its pending promise and explicit settlement functions.
 * @throws {never} Never.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(getTimelineConfig).mockReset().mockReturnValue(CONFIG);
  const inspection: RegisteredProjectMediaInspection = { resolution: { resolved: [{ kind: "assetId", reference: ASSET.id, asset: ASSET }], unavailable: [] }, references: [reference(ASSET)] };
  vi.mocked(inspectRegisteredProjectMedia).mockReset().mockResolvedValue(inspection);
  vi.mocked(referenceRegisteredProjectMediaDetailed).mockReset().mockResolvedValue({ ...inspection, insertedAssetIds: [] });
});

describe("Project media backfill scanning and mode boundaries", () => {
  it("uses the configured page bound, advances from each last row and rescans from null", async () => {
    const rows = [1, 2, 3, 4, 5].map((id) => candidate(String(id)));
    const scanner = source("grants", rows);
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: report.emit });
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 2], ["cursor:2", 2], ["cursor:4", 2], ["cursor:5", 2], [null, 2], ["cursor:2", 2], ["cursor:4", 2], ["cursor:5", 2]]);
    expect(candidates(report.records)).toEqual(["initial", "verification"].flatMap((pass) => rows.map((row) => defaultRow(row, "grants", pass as Pass))));
    expect(summaries(report.records)).toEqual([summary("grants", "initial", 5), summary("grants", "verification", 5)]);
  });

  it("reads a changed configuration bound on the next invocation", async () => {
    vi.mocked(getTimelineConfig).mockReturnValue({ ...CONFIG, assets: { ...CONFIG.assets, backfill_batch_size: 7 } });
    const scanner = source("history", [candidate("history-1")]);
    await runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: sink().emit });
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 7], ["cursor:history-1", 7], [null, 7], ["cursor:history-1", 7]]);
  });

  it("emits explicit zero summaries for each empty source in both passes", async () => {
    const first = source("grants", []);
    const second = source("spaces", []);
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [first, second], emit: report.emit });
    expect(report.records).toEqual([summary("grants", "initial", 0), summary("spaces", "initial", 0), summary("grants", "verification", 0), summary("spaces", "verification", 0)]);
    expect(vi.mocked(first.readPage).mock.calls).toEqual([[null, 2], [null, 2]]);
    expect(vi.mocked(second.readPage).mock.calls).toEqual([[null, 2], [null, 2]]);
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
  });

  it("finishes the initial sources in order before starting the verification sources", async () => {
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [source("grants", [candidate("g")]), source("history", [candidate("h")])], emit: report.emit });
    expect(report.records.map((row) => [row.pass, row.source, row.type])).toEqual([
      ["initial", "grants", "candidate"], ["initial", "grants", "source_complete"], ["initial", "history", "candidate"], ["initial", "history", "source_complete"],
      ["verification", "grants", "candidate"], ["verification", "grants", "source_complete"], ["verification", "history", "candidate"], ["verification", "history", "source_complete"],
    ]);
  });

  it("finds candidates appended after the initial source scan during verification", async () => {
    const rows = [candidate("original")];
    const report = sink();
    const emit = vi.fn(async (record: ProjectMediaBackfillRecord) => {
      await report.emit(record);
      if (record.type === "source_complete" && record.pass === "initial") rows.push(candidate("arrived-during-scan"));
    });
    await runProjectMediaBackfill({ mode: "report", sources: [source("spaces", rows)], emit });
    expect(candidates(report.records).map((row) => [row.pass, row.rowId])).toEqual([["initial", "original"], ["verification", "original"], ["verification", "arrived-during-scan"]]);
    expect(summaries(report.records)).toEqual([summary("spaces", "initial", 1), summary("spaces", "verification", 2)]);
  });

  it("accepts a newly visible smaller-cursor row when verification restarts from null", async () => {
    const original = candidate("later-cursor", { cursor: "2026-10-25 03:10:21.123456+00|0002" });
    const newlyVisible = candidate("earlier-cursor", { cursor: "2026-10-25 03:10:21.123455+00|0001", assetIds: [OTHER_ASSET.id] });
    const rows = [original];
    const scanner = source("history", rows);
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockImplementation(async (input) => {
      const asset = input.assetIds?.includes(OTHER_ASSET.id) ? OTHER_ASSET : ASSET;
      return { resolution: { resolved: [{ kind: "assetId", reference: asset.id, asset }], unavailable: [] }, references: [reference(asset)], insertedAssetIds: asset.id === OTHER_ASSET.id ? [asset.id] : [] };
    });
    const report = sink();
    await runProjectMediaBackfill({ mode: "apply", sources: [scanner], emit: async (record) => {
      await report.emit(record);
      if (record.type === "source_complete" && record.pass === "initial") rows.unshift(newlyVisible);
    } });
    expect(candidates(report.records).map((row) => [row.pass, row.rowId, row.cursor])).toEqual([
      ["initial", original.id, original.cursor],
      ["verification", newlyVisible.id, newlyVisible.cursor],
      ["verification", original.id, original.cursor],
    ]);
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 2], [original.cursor, 2], [null, 2], [original.cursor, 2]]);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(3);
    expect(candidates(report.records)[1]?.insertedAssetIds).toEqual([OTHER_ASSET.id]);
    expect(summaries(report.records)).toEqual([summary("history", "initial", 1, "apply"), { ...summary("history", "verification", 2, "apply"), existingAssets: 1, insertedAssets: 1 }]);
  });

  it("report preserves every classification identity and uses existing relationships only", async () => {
    const resolved: RegisteredProjectMediaResolution["resolved"] = [
      { kind: "url", reference: "https://cdn.example/one-alias.mp4", asset: ASSET },
      { kind: "assetId", reference: ASSET.id, asset: ASSET },
      { kind: "assetId", reference: OTHER_ASSET.id, asset: OTHER_ASSET },
    ];
    const unavailable: RegisteredProjectMediaResolution["unavailable"] = [
      { kind: "url", reference: "https://external.example/video.mp4", reason: "external" },
      { kind: "assetId", reference: "missing-original-identity", reason: "unregistered" },
      { kind: "url", reference: "https://cdn.example/foreign.mp4", reason: "foreign_studio" },
    ];
    vi.mocked(inspectRegisteredProjectMedia).mockResolvedValue(freezeDeep({ resolution: { resolved, unavailable }, references: [reference(ASSET)] }));
    const row = candidate("explicit-identity", { cursor: "2026-10-25 03:10:21.123456+00|original-row", assetIds: [OTHER_ASSET.id, ASSET.id, ASSET.id], urls: resolved.filter((item) => item.kind === "url").map((item) => item.reference), displayNames: { [ASSET.id]: "Original source filename.mp4" } });
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [source("history", [row])], emit: report.emit });
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(2);
    expect(vi.mocked(inspectRegisteredProjectMedia).mock.calls[0]?.[0]).toMatchObject({ projectId: PROJECT, assetIds: row.assetIds, urls: row.urls });
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
    expect(candidates(report.records)).toHaveLength(2);
    expect(summaries(report.records)).toHaveLength(2);
    for (const emitted of candidates(report.records)) expect(emitted).toEqual({ ...defaultRow(row, "history", emitted.pass), resolved: resolved.map((item) => ({ kind: item.kind, reference: item.reference, assetId: item.asset.id })), unavailable, existingAssetIds: [ASSET.id] });
    for (const emitted of summaries(report.records)) expect(emitted).toEqual({ ...summary("history", emitted.pass, 1), resolvedAssets: 2, unavailableReferences: 3 });
  });

  it("apply records actual insert identities and excludes them from the existing count", async () => {
    const resolution: RegisteredProjectMediaResolution = { resolved: [{ kind: "assetId", reference: ASSET.id, asset: ASSET }, { kind: "url", reference: OTHER_ASSET.fileUrl, asset: OTHER_ASSET }], unavailable: [] };
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockResolvedValue(freezeDeep({ resolution, references: [reference(ASSET), reference(OTHER_ASSET)], insertedAssetIds: [OTHER_ASSET.id] }));
    const row = candidate("registered", { urls: [OTHER_ASSET.fileUrl], displayNames: { [OTHER_ASSET.id]: "Verified original name.mp4" } });
    const report = sink();
    await runProjectMediaBackfill({ mode: "apply", sources: [source("grants", [row])], emit: report.emit });
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(2);
    expect(candidates(report.records)).toHaveLength(2);
    expect(summaries(report.records)).toHaveLength(2);
    expect(vi.mocked(referenceRegisteredProjectMediaDetailed).mock.calls[0]?.[0]).toMatchObject({ projectId: PROJECT, assetIds: row.assetIds, urls: row.urls, displayNames: row.displayNames });
    for (const emitted of candidates(report.records)) {
      expect(emitted.insertedAssetIds).toEqual([OTHER_ASSET.id]);
      expect(emitted.existingAssetIds).toEqual([ASSET.id]);
    }
    for (const emitted of summaries(report.records)) expect(emitted).toEqual({ ...summary("grants", emitted.pass, 1, "apply"), resolvedAssets: 2, insertedAssets: 1 });
  });

  it("counts repeated assets per candidate and keeps each source total separate", async () => {
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [source("grants", [candidate("g1"), candidate("g2")]), source("history", [candidate("h1")])], emit: report.emit });
    expect(summaries(report.records)).toEqual([summary("grants", "initial", 2), summary("history", "initial", 1), summary("grants", "verification", 2), summary("history", "verification", 1)]);
    expect(report.records.filter((record) => record.type !== "candidate" && record.type !== "source_complete")).toEqual([]);
  });

  it.each(MODES)("preserves frozen source rows and original report objects in %s mode", async (mode) => {
    const rows = freezeDeep([candidate("first", { assetIds: [ASSET.id, ASSET.id], urls: [ASSET.fileUrl], displayNames: { [ASSET.id]: "Original name.mp4" } }), candidate("second")]);
    const before = structuredClone(rows);
    const report = sink();
    const firstSnapshots: ProjectMediaBackfillRecord[] = [];
    await runProjectMediaBackfill({ mode, sources: freezeDeep([source("grants", rows)]), emit: async (record) => { firstSnapshots.push(structuredClone(record)); await report.emit(record); } });
    expect(rows).toEqual(before);
    expect(report.records).toEqual(firstSnapshots);
    expect(candidates(report.records).map((row) => row.rowId)).toEqual(["first", "second", "first", "second"]);
  });
});

describe("Project media backfill provenance and error boundaries", () => {
  it.each(MODES.flatMap((mode) => (["insufficient_media_provenance", "invalid_document", "missing_generation_task", "project_unavailable"] as const).map((reason) => ({ mode, reason }))))("reports explicit $reason in $mode without resolving media", async ({ mode, reason }) => {
    const row = candidate("unusable", { reason });
    const report = sink();
    await runProjectMediaBackfill({ mode, sources: [source("spaces", [row])], emit: report.emit });
    expect(candidates(report.records)).toHaveLength(2);
    expect(summaries(report.records)).toHaveLength(2);
    for (const emitted of candidates(report.records)) expect(emitted).toEqual({ ...defaultRow(row, "spaces", emitted.pass, mode), resolved: [], unavailable: [], existingAssetIds: [], reason });
    for (const emitted of summaries(report.records)) expect(emitted).toEqual({ ...summary("spaces", emitted.pass, 1, mode), resolvedAssets: 0, existingAssets: 0, reasons: { [reason]: 1 } });
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
  });

  it.each(MODES)("reports missing Project provenance in %s mode", async (mode) => {
    const row = candidate("unattributed", { projectId: null, assetIds: [ASSET.id] });
    const report = sink();
    await runProjectMediaBackfill({ mode, sources: [source("history", [row])], emit: report.emit });
    expect(candidates(report.records)).toHaveLength(2);
    expect(summaries(report.records)).toHaveLength(2);
    for (const emitted of candidates(report.records)) expect(emitted).toEqual({ ...defaultRow(row, "history", emitted.pass, mode), projectId: null, resolved: [], unavailable: [], existingAssetIds: [], reason: "insufficient_media_provenance" });
    for (const emitted of summaries(report.records)) expect(emitted.reasons).toEqual({ insufficient_media_provenance: 1 });
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
  });

  it("retains the scanner's explicit reason when Project provenance is also absent", async () => {
    const row = candidate("invalid-space", { projectId: null, reason: "invalid_document" });
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [source("spaces", [row])], emit: report.emit });
    expect(candidates(report.records).map((item) => item.reason)).toEqual(["invalid_document", "invalid_document"]);
  });

  it.each(MODES)("maps a real missing Project error to project_unavailable in %s mode", async (mode) => {
    const error = new ProjectMediaScopeUnavailableError("The Project or owning Studio is no longer live");
    vi.mocked(inspectRegisteredProjectMedia).mockRejectedValue(error);
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockRejectedValue(error);
    const report = sink();
    await runProjectMediaBackfill({ mode, sources: [source("grants", [candidate("missing-project")])], emit: report.emit });
    expect(summaries(report.records)).toHaveLength(2);
    expect(candidates(report.records).map((row) => ({ reason: row.reason, resolved: row.resolved, unavailable: row.unavailable, existing: row.existingAssetIds, inserted: row.insertedAssetIds }))).toEqual(Array.from({ length: 2 }, () => ({ reason: "project_unavailable", resolved: [], unavailable: [], existing: [], inserted: [] })));
    for (const emitted of summaries(report.records)) expect(emitted).toEqual({ ...summary("grants", emitted.pass, 1, mode), resolvedAssets: 0, existingAssets: 0, reasons: { project_unavailable: 1 } });
  });

  it.each(MODES)("propagates a missing accepted asset in %s mode and stops before later candidates", async (mode) => {
    const error = new NotFoundError("A registered asset disappeared before association acceptance");
    vi.mocked(inspectRegisteredProjectMedia).mockRejectedValueOnce(error);
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockRejectedValueOnce(error);
    const scanner = source("grants", [candidate("failed-acceptance"), candidate("unreached")]);
    const next = source("history", [candidate("next-source")]);
    const report = sink();
    await expect(runProjectMediaBackfill({ mode, sources: [scanner, next], emit: report.emit })).rejects.toBe(error);
    expect(report.records).toEqual([]);
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 2]]);
    expect(next.readPage).toHaveBeenCalledTimes(0);
    expect(mode === "report" ? inspectRegisteredProjectMedia : referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(1);
  });

  it.each(MODES.flatMap((mode) => [new Error("Database connection failed"), new AppError(500, "Transaction aborted"), new AppError(404, "A different boundary failed"), new ForbiddenError("Unexpected service refusal")].map((error) => ({ mode, error }))))("propagates $error.name from the $mode service boundary", async ({ mode, error }) => {
    const scanner = source("grants", [candidate("accepted"), candidate("failed"), candidate("unreached")]);
    const next = source("history", [candidate("next-source")]);
    vi.mocked(inspectRegisteredProjectMedia).mockRejectedValueOnce(error);
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockRejectedValueOnce(error);
    const report = sink();
    await expect(runProjectMediaBackfill({ mode, sources: [scanner, next], emit: report.emit })).rejects.toBe(error);
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 2]]);
    expect(next.readPage).toHaveBeenCalledTimes(0);
    expect(report.records).toEqual([]);
    expect(mode === "report" ? inspectRegisteredProjectMedia : referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(1);
  });

  it("retains only durable earlier rows when a later association fails", async () => {
    const error = new Error("Second association transaction failed");
    vi.mocked(referenceRegisteredProjectMediaDetailed).mockResolvedValueOnce({ resolution: { resolved: [{ kind: "assetId", reference: ASSET.id, asset: ASSET }], unavailable: [] }, references: [reference(ASSET)], insertedAssetIds: [] }).mockRejectedValueOnce(error);
    const rows = [candidate("safe"), candidate("failed"), candidate("unreached")];
    const scanner = source("grants", rows);
    const report = sink();
    await expect(runProjectMediaBackfill({ mode: "apply", sources: [scanner], emit: report.emit })).rejects.toBe(error);
    expect(report.records).toEqual([defaultRow(rows[0] as ProjectMediaBackfillCandidate, "grants", "initial", "apply")]);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(2);
    expect(scanner.readPage).toHaveBeenCalledTimes(1);
  });

  it.each([new Error("Scanner failed"), new NotFoundError("Scanner source unavailable")])("propagates readPage errors of type %s", async (error) => {
    const scanner = source("spaces", []);
    vi.mocked(scanner.readPage).mockRejectedValueOnce(error);
    const report = sink();
    await expect(runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: report.emit })).rejects.toBe(error);
    expect(report.records).toEqual([]);
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
    expect(scanner.readPage).toHaveBeenCalledTimes(1);
  });

  it("keeps the last emitted cursor when fetching the following page fails", async () => {
    const row = candidate("safe-page");
    const scanner = source("history", [row]);
    const error = new Error("Next page query failed");
    vi.mocked(scanner.readPage).mockResolvedValueOnce([row]).mockRejectedValueOnce(error);
    const report = sink();
    await expect(runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: report.emit })).rejects.toBe(error);
    expect(report.records).toEqual([defaultRow(row, "history", "initial")]);
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([[null, 2], [row.cursor, 2]]);
  });

  it.each([new Error("Durable report write failed"), new NotFoundError("Report destination unavailable")])("propagates candidate emit errors of type %s and stops advancement", async (error) => {
    const scanner = source("grants", [candidate("first"), candidate("unreached")]);
    const emit = vi.fn(async (_record: ProjectMediaBackfillRecord): Promise<void> => { throw error; });
    await expect(runProjectMediaBackfill({ mode: "apply", sources: [scanner], emit })).rejects.toBe(error);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(1);
    expect(scanner.readPage).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("stops before the next source when its completion report fails", async () => {
    const first = source("grants", [candidate("g1")]);
    const second = source("history", [candidate("h1")]);
    const error = new Error("Summary report could not be written");
    const report = sink();
    const emit = vi.fn(async (record: ProjectMediaBackfillRecord) => { if (record.type === "source_complete") throw error; await report.emit(record); });
    await expect(runProjectMediaBackfill({ mode: "report", sources: [first, second], emit })).rejects.toBe(error);
    expect(report.records).toEqual([defaultRow(candidate("g1"), "grants", "initial")]);
    expect(second.readPage).toHaveBeenCalledTimes(0);
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(1);
  });

  it("awaits durable candidate emission before accepting the next row or page", async () => {
    const gate = deferred<void>();
    const report = sink();
    const scanner = source("grants", [candidate("first"), candidate("second")]);
    const emit = vi.fn(async (record: ProjectMediaBackfillRecord) => {
      if (record.type === "candidate" && record.pass === "initial" && record.rowId === "first") await gate.promise;
      await report.emit(record);
    });
    const outcome = runProjectMediaBackfill({ mode: "apply", sources: [scanner], emit }).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    try {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
      expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(1);
      expect(scanner.readPage).toHaveBeenCalledTimes(1);
      expect(report.records).toEqual([]);
    } finally { gate.resolve(); }
    expect(await outcome).toEqual({ ok: true });
    expect(candidates(report.records).map((row) => [row.pass, row.rowId])).toEqual([["initial", "first"], ["initial", "second"], ["verification", "first"], ["verification", "second"]]);
  });
});

describe("Project media backfill resume positions", () => {
  it("resumes within an initial source then verifies every source from its beginning", async () => {
    const first = source("grants", [candidate("g1")]);
    const middle = source("history", [candidate("h1"), candidate("h2")]);
    const last = source("spaces", []);
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [first, middle, last], emit: report.emit, resume: { pass: "initial", source: "history", cursor: "cursor:h1" } });
    expect(candidates(report.records).map((row) => [row.pass, row.source, row.rowId])).toEqual([["initial", "history", "h2"], ["verification", "grants", "g1"], ["verification", "history", "h1"], ["verification", "history", "h2"]]);
    expect(summaries(report.records)).toEqual([summary("history", "initial", 1), summary("spaces", "initial", 0), summary("grants", "verification", 1), summary("history", "verification", 2), summary("spaces", "verification", 0)]);
    expect(vi.mocked(first.readPage).mock.calls).toEqual([[null, 2], ["cursor:g1", 2]]);
    expect(vi.mocked(middle.readPage).mock.calls).toEqual([["cursor:h1", 2], ["cursor:h2", 2], [null, 2], ["cursor:h2", 2]]);
  });

  it("resumes a verification source while skipping the initial pass and prior verification sources", async () => {
    const first = source("grants", [candidate("g1")]);
    const middle = source("history", [candidate("h1"), candidate("h2")]);
    const last = source("spaces", [candidate("s1")]);
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [first, middle, last], emit: report.emit, resume: { pass: "verification", source: "history", cursor: "cursor:h1" } });
    expect(first.readPage).toHaveBeenCalledTimes(0);
    expect(candidates(report.records).map((row) => [row.pass, row.source, row.rowId])).toEqual([["verification", "history", "h2"], ["verification", "spaces", "s1"]]);
    expect(summaries(report.records)).toEqual([summary("history", "verification", 1), summary("spaces", "verification", 1)]);
    expect(vi.mocked(middle.readPage).mock.calls).toEqual([["cursor:h1", 2], ["cursor:h2", 2]]);
    expect(vi.mocked(last.readPage).mock.calls).toEqual([[null, 2], ["cursor:s1", 2]]);
  });

  it("emits a zero suffix summary when the resume cursor is the final source row", async () => {
    const scanner = source("grants", [candidate("g1")]);
    const report = sink();
    await runProjectMediaBackfill({ mode: "apply", sources: [scanner], emit: report.emit, resume: { pass: "verification", source: "grants", cursor: "cursor:g1" } });
    expect(report.records).toEqual([summary("grants", "verification", 0, "apply")]);
    expect(vi.mocked(scanner.readPage).mock.calls).toEqual([["cursor:g1", 2]]);
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
  });

  it.each([
    { pass: "initial", source: "unknown-source", cursor: "last-safe" },
    { pass: "verification", source: "unknown-source", cursor: "last-safe" },
    { pass: "later-pass", source: "grants", cursor: "last-safe" },
    { pass: "", source: "grants", cursor: "last-safe" },
  ])("rejects an unknown resume source or pass before reading ($pass, $source)", async (resume) => {
    const scanner = source("grants", []);
    const report = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: report.emit });
    expect(report.records).toEqual([summary("grants", "initial", 0), summary("grants", "verification", 0)]);
    vi.mocked(scanner.readPage).mockClear();
    const invalidReport = sink();
    await expect(runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: invalidReport.emit, resume: resume as ProjectMediaBackfillPosition })).rejects.toBeInstanceOf(Error);
    expect(scanner.readPage).toHaveBeenCalledTimes(0);
    expect(invalidReport.records).toEqual([]);
  });

  it("retries the failed emitted row from the last durable checkpoint on a resumed invocation", async () => {
    const rows = [candidate("safe"), candidate("retry")];
    const scanner = source("grants", rows);
    const report = sink();
    const error = new Error("Second candidate report failed");
    const emit = vi.fn(async (record: ProjectMediaBackfillRecord) => { if (record.type === "candidate" && record.rowId === "retry") throw error; await report.emit(record); });
    await expect(runProjectMediaBackfill({ mode: "report", sources: [scanner], emit })).rejects.toBe(error);
    const checkpoint = candidates(report.records)[0];
    expect(checkpoint).toEqual(defaultRow(rows[0] as ProjectMediaBackfillCandidate, "grants", "initial"));
    const resumed = sink();
    await runProjectMediaBackfill({ mode: "report", sources: [scanner], emit: resumed.emit, resume: checkpoint });
    expect(candidates(resumed.records).map((row) => [row.pass, row.rowId])).toEqual([["initial", "retry"], ["verification", "safe"], ["verification", "retry"]]);
    expect(summaries(resumed.records)).toEqual([summary("grants", "initial", 1), summary("grants", "verification", 2)]);
  });
});

/** A controlled registered or unavailable identity at the service boundary. */
interface IdentityFixture { kind: "assetId" | "url"; reference: string; asset: StudioAssetEntity | null; reason?: "external" | "unregistered" | "foreign_studio" }
const IDENTITIES: readonly IdentityFixture[] = [
  { kind: "assetId", reference: ASSET.id, asset: ASSET },
  { kind: "url", reference: ASSET.fileUrl, asset: ASSET },
  { kind: "url", reference: "https://cdn.example/alias-one.mp4", asset: ASSET },
  { kind: "assetId", reference: OTHER_ASSET.id, asset: OTHER_ASSET },
  { kind: "url", reference: OTHER_ASSET.fileUrl, asset: OTHER_ASSET },
  { kind: "url", reference: "https://external.example/video.mp4", asset: null, reason: "external" },
  { kind: "assetId", reference: "10000000-0000-4000-8000-000000000099", asset: null, reason: "unregistered" },
  { kind: "url", reference: "https://cdn.example/unregistered.mp4", asset: null, reason: "unregistered" },
  { kind: "assetId", reference: "10000000-0000-4000-8000-000000000088", asset: null, reason: "foreign_studio" },
  { kind: "url", reference: "https://cdn.example/foreign.mp4", asset: null, reason: "foreign_studio" },
];

/**
 * Model the service's already-normalized classifications for controlled inputs.
 * @param tokens - Original identities, including repeated IDs and alias URLs.
 * @returns Canonical service output preserving each distinct declared identity.
 * @throws {never} Never.
 */
function classification(tokens: readonly IdentityFixture[]): RegisteredProjectMediaResolution {
  const identities = [...new Map(tokens.map((token) => [token.kind + ":" + token.reference, token])).values()];
  return {
    resolved: identities.flatMap((token) => token.asset === null ? [] : [{ kind: token.kind, reference: token.reference, asset: token.asset }]),
    unavailable: identities.flatMap((token) => token.asset !== null ? [] : [{ kind: token.kind, reference: token.reference, reason: token.reason ?? "unregistered" }]),
  };
}

describe("Project media backfill counting invariants", () => {
  it("counts canonical assets once per row while preserving distinct unavailable identities", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: IDENTITIES.length - 1 }), { minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 3 }), async (indices, existingMask) => {
      const tokens = indices.map((index) => IDENTITIES[index] as IdentityFixture);
      const resolution = classification(tokens);
      const uniqueAssets = [...new Map(resolution.resolved.map((item) => [item.asset.id, item.asset])).values()];
      const references = uniqueAssets.filter((asset) => (existingMask & (asset.id === ASSET.id ? 1 : 2)) !== 0).map(reference);
      vi.mocked(inspectRegisteredProjectMedia).mockResolvedValue(freezeDeep({ resolution, references }));
      const row = freezeDeep(candidate("generated", { assetIds: tokens.filter((token) => token.kind === "assetId").map((token) => token.reference), urls: tokens.filter((token) => token.kind === "url").map((token) => token.reference) }));
      const original = structuredClone(row);
      const report = sink();
      await runProjectMediaBackfill({ mode: "report", sources: [source("grants", [row])], emit: report.emit });
      expect(candidates(report.records)).toHaveLength(2);
      expect(summaries(report.records)).toHaveLength(2);
      for (const emitted of candidates(report.records)) {
        expect(emitted.resolved).toEqual(resolution.resolved.map((item) => ({ kind: item.kind, reference: item.reference, assetId: item.asset.id })));
        expect(emitted.unavailable).toEqual(resolution.unavailable);
        expect([...emitted.existingAssetIds].sort()).toEqual(references.map((item) => item.assetId).sort());
        expect(emitted.insertedAssetIds).toEqual([]);
      }
      for (const emitted of summaries(report.records)) expect(emitted).toEqual({ ...summary("grants", emitted.pass, 1), resolvedAssets: uniqueAssets.length, existingAssets: references.length, unavailableReferences: resolution.unavailable.length });
      expect(row).toEqual(original);
    }));
    expect(referenceRegisteredProjectMediaDetailed).toHaveBeenCalledTimes(0);
  });

  it("reports actual insertions idempotently across verification and repeated apply runs", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 0, max: IDENTITIES.length - 1 }), { minLength: 1, maxLength: 40 }), fc.boolean(), async (indices, alreadyHasFirst) => {
      const tokens = indices.map((index) => IDENTITIES[index] as IdentityFixture);
      const resolution = classification(tokens);
      const uniqueAssets = [...new Map(resolution.resolved.map((item) => [item.asset.id, item.asset])).values()];
      const accepted = new Set(alreadyHasFirst ? [ASSET.id] : []);
      const originallyExisting = uniqueAssets.filter((asset) => accepted.has(asset.id)).length;
      vi.mocked(referenceRegisteredProjectMediaDetailed).mockImplementation(async () => {
        const insertedAssetIds = uniqueAssets.filter((asset) => !accepted.has(asset.id)).map((asset) => asset.id);
        for (const id of insertedAssetIds) accepted.add(id);
        return freezeDeep({ resolution, references: uniqueAssets.map(reference), insertedAssetIds });
      });
      const row = freezeDeep(candidate("generated", { assetIds: tokens.filter((token) => token.kind === "assetId").map((token) => token.reference), urls: tokens.filter((token) => token.kind === "url").map((token) => token.reference) }));
      const initial = sink();
      const repeated = sink();
      const scanners = [source("grants", [row])];
      await runProjectMediaBackfill({ mode: "apply", sources: scanners, emit: initial.emit });
      await runProjectMediaBackfill({ mode: "apply", sources: scanners, emit: repeated.emit });
      expect(candidates(repeated.records)).toHaveLength(2);
      expect(summaries(repeated.records)).toHaveLength(2);
      expect(summaries(initial.records)).toEqual([
        { ...summary("grants", "initial", 1, "apply"), resolvedAssets: uniqueAssets.length, existingAssets: originallyExisting, insertedAssets: uniqueAssets.length - originallyExisting, unavailableReferences: resolution.unavailable.length },
        { ...summary("grants", "verification", 1, "apply"), resolvedAssets: uniqueAssets.length, existingAssets: uniqueAssets.length, unavailableReferences: resolution.unavailable.length },
      ]);
      for (const emitted of summaries(repeated.records)) expect(emitted).toEqual({ ...summary("grants", emitted.pass, 1, "apply"), resolvedAssets: uniqueAssets.length, existingAssets: uniqueAssets.length, unavailableReferences: resolution.unavailable.length });
      for (const emitted of candidates(repeated.records)) expect(emitted.insertedAssetIds).toEqual([]);
    }));
    expect(inspectRegisteredProjectMedia).toHaveBeenCalledTimes(0);
  });
});
