// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getTimelineConfig } from "@core/config/timeline.js";
import { inspectRegisteredProjectMedia, ProjectMediaScopeUnavailableError, referenceRegisteredProjectMediaDetailed } from "@core/asset/project-asset-reference.service.js";
import type { RegisteredProjectMediaInspection } from "@core/asset/project-asset-reference.service.js";

/** Explicit provenance failures retained in the private maintenance report. */
export type ProjectMediaBackfillReason = "insufficient_media_provenance" | "invalid_document" | "missing_generation_task" | "project_unavailable";

/** One bounded scanner row, retaining its source identity and resume position. */
export interface ProjectMediaBackfillCandidate {
  id: string;
  cursor: string;
  projectId: string | null;
  assetIds?: readonly string[];
  urls?: readonly string[];
  displayNames?: Readonly<Record<string, string>>;
  reason?: ProjectMediaBackfillReason;
}

/** A source adapter reads through its table's existing repository owner. */
export interface ProjectMediaBackfillSource {
  name: string;
  readPage: (cursor: string | null, limit: number) => Promise<readonly ProjectMediaBackfillCandidate[]>;
}

/** The last successfully reported candidate is a safe, idempotent resume point. */
export interface ProjectMediaBackfillPosition {
  pass: "initial" | "verification";
  source: string;
  cursor: string;
}

/** Per-row facts use canonical asset identities and actual insert results. */
export interface ProjectMediaBackfillRow extends ProjectMediaBackfillPosition {
  type: "candidate";
  mode: "report" | "apply";
  rowId: string;
  projectId: string | null;
  resolved: { kind: "assetId" | "url"; reference: string; assetId: string }[];
  unavailable: { kind: "assetId" | "url"; reference: string; reason: "external" | "unregistered" | "foreign_studio" }[];
  existingAssetIds: string[];
  insertedAssetIds: string[];
  reason: ProjectMediaBackfillReason | null;
}

/** Totals cover this invocation's emitted rows for one source and pass. */
export interface ProjectMediaBackfillSummary {
  type: "source_complete";
  mode: "report" | "apply";
  pass: "initial" | "verification";
  source: string;
  candidates: number;
  resolvedAssets: number;
  existingAssets: number;
  insertedAssets: number;
  unavailableReferences: number;
  reasons: Partial<Record<ProjectMediaBackfillReason, number>>;
}

/** Each emitted candidate is durable before the next candidate is processed. */
export type ProjectMediaBackfillRecord = ProjectMediaBackfillRow | ProjectMediaBackfillSummary;

/** Explicit maintenance input, with no application or persistent cache state. */
export interface RunProjectMediaBackfillInput {
  mode: "report" | "apply";
  sources: readonly ProjectMediaBackfillSource[];
  emit: (record: ProjectMediaBackfillRecord) => Promise<void>;
  resume?: ProjectMediaBackfillPosition;
}

/**
 * Inspect or accept historical media with bounded pages and a final rescan.
 * @param input - The explicitly chosen mode, scanner adapters and report sink.
 * @returns After each selected source and verification pass has completed.
 * @throws {Error} When scanning, canonical association or durable reporting fails.
 */
export async function runProjectMediaBackfill(input: RunProjectMediaBackfillInput): Promise<void> {
  const passes = ["initial", "verification"] as const;
  const startPass = input.resume === undefined ? 0 : passes.indexOf(input.resume.pass);
  const startSource = input.resume === undefined ? 0 : input.sources.findIndex((source) => source.name === input.resume?.source);
  if (startPass < 0 || startSource < 0) throw new Error("Unknown Project media backfill resume source or pass");
  const limit = getTimelineConfig().assets.backfill_batch_size;
  for (let passIndex = startPass; passIndex < passes.length; passIndex++) {
    const pass = passes[passIndex]!;
    for (let sourceIndex = passIndex === startPass ? startSource : 0; sourceIndex < input.sources.length; sourceIndex++) {
      const source = input.sources[sourceIndex]!;
      let cursor = passIndex === startPass && sourceIndex === startSource ? input.resume?.cursor ?? null : null;
      const summary: ProjectMediaBackfillSummary = {
        type: "source_complete", mode: input.mode, pass, source: source.name,
        candidates: 0, resolvedAssets: 0, existingAssets: 0, insertedAssets: 0, unavailableReferences: 0, reasons: {},
      };
      while (true) {
        const page = await source.readPage(cursor, limit);
        if (page.length === 0) break;
        for (const candidate of page) {
          const record = await processCandidate(candidate, input.mode, pass, source.name);
          await input.emit(record);
          cursor = candidate.cursor;
          countCandidate(summary, record);
        }
      }
      await input.emit(summary);
    }
  }
}

/**
 * Resolve one explicit provenance row through the canonical media service.
 * @param candidate - The original source row and immutable resume position.
 * @param mode - The operator's inspection or association mode.
 * @param pass - The current initial or verification scan.
 * @param source - The repository adapter identifying this provenance.
 * @returns Report facts, preserving unavailable input identities.
 * @throws {Error} When a canonical read or association fails unexpectedly.
 */
async function processCandidate(candidate: ProjectMediaBackfillCandidate, mode: "report" | "apply", pass: ProjectMediaBackfillPosition["pass"], source: string): Promise<ProjectMediaBackfillRow> {
  const record: ProjectMediaBackfillRow = {
    type: "candidate", mode, pass, source, rowId: candidate.id, cursor: candidate.cursor, projectId: candidate.projectId,
    resolved: [], unavailable: [], existingAssetIds: [], insertedAssetIds: [], reason: candidate.reason ?? null,
  };
  if (record.reason !== null) return record;
  if (candidate.projectId === null) return { ...record, reason: "insufficient_media_provenance" };
  const input = { projectId: candidate.projectId, assetIds: candidate.assetIds, urls: candidate.urls };
  try {
    const result: RegisteredProjectMediaInspection & { insertedAssetIds?: string[] } = mode === "report"
      ? await inspectRegisteredProjectMedia(input)
      : await referenceRegisteredProjectMediaDetailed({ ...input, displayNames: candidate.displayNames });
    const inserted = result.insertedAssetIds ?? [];
    record.resolved = result.resolution.resolved.map((item) => ({ kind: item.kind, reference: item.reference, assetId: item.asset.id }));
    record.unavailable = result.resolution.unavailable.map((item) => ({ ...item }));
    record.insertedAssetIds = [...inserted];
    const insertedIds = new Set(inserted);
    record.existingAssetIds = [...new Set(result.references.map((item) => item.assetId))].filter((id) => !insertedIds.has(id)).sort();
    return record;
  } catch (error) {
    if (!(error instanceof ProjectMediaScopeUnavailableError)) throw error;
    return { ...record, reason: "project_unavailable" };
  }
}

/**
 * Accumulate facts only after the candidate record was successfully emitted.
 * @param summary - Totals for this invocation's current source and pass.
 * @param record - The durably emitted row.
 * @throws {never} Never.
 */
function countCandidate(summary: ProjectMediaBackfillSummary, record: ProjectMediaBackfillRow): void {
  summary.candidates++;
  summary.resolvedAssets += new Set(record.resolved.map((item) => item.assetId)).size;
  summary.existingAssets += record.existingAssetIds.length;
  summary.insertedAssets += record.insertedAssetIds.length;
  summary.unavailableReferences += record.unavailable.length;
  if (record.reason !== null) summary.reasons[record.reason] = (summary.reasons[record.reason] ?? 0) + 1;
}
