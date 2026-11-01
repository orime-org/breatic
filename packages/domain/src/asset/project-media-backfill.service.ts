// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { assetRepo, projectActivitiesRepo, type ProjectMediaBackfillCandidate, type ProjectMediaBackfillSource } from "@breatic/core";
import type { NodeHistoryEntity, TaskEntity } from "@breatic/shared";
import * as grants from "@domain/asset/upload-grant.repo.js";
import * as history from "@domain/node-history/node-history.repo.js";
import * as tasks from "@domain/task/task.repo.js";

const MEDIA_TASK_TYPES = new Set(["image", "video", "audio", "tts", "three_d"]);
const MEDIA_ACTIVITY_KINDS = new Set(["image", "video", "audio"]);

/**
 * Expose bounded historical business provenance through the existing owners.
 * @returns Consumed grants, successful history, media activity and task assets.
 * @throws {Error} When a source scan or task-provenance lookup fails.
 */
export function createBusinessProjectMediaBackfillSources(): readonly ProjectMediaBackfillSource[] {
  return [
    { name: "consumed_grants", readPage: readConsumedGrants },
    { name: "node_history", readPage: readHistory },
    { name: "media_activities", readPage: readMediaActivities },
    { name: "generation_assets", readPage: readGenerationAssets },
  ];
}

/**
 * Keep consumed grant attribution bound to its originally registered asset.
 * @param cursor - The last emitted grant identity.
 * @param limit - The configured batch bound.
 * @returns Explicit grant provenance, including classified incomplete rows.
 * @throws {Error} When the grant repository read fails.
 */
async function readConsumedGrants(cursor: string | null, limit: number): Promise<ProjectMediaBackfillCandidate[]> {
  const rows = await grants.scanConsumedMediaGrants(cursor, limit);
  return rows.map((row) => {
    const identity = { id: row.id, cursor: row.id, projectId: row.projectId };
    if (row.projectId === null || row.assetId === null) return { ...identity, reason: "insufficient_media_provenance" };
    return { ...identity, assetIds: [row.assetId], displayNames: row.filename === null ? {} : { [row.assetId]: row.filename } };
  });
}

/**
 * Read a successful-history page and batch the task evidence needed by it.
 * @param cursor - The last emitted history identity.
 * @param limit - The configured batch bound.
 * @returns Explicit media history or a reason for insufficient evidence.
 * @throws {Error} When a history or task repository read fails.
 */
async function readHistory(cursor: string | null, limit: number): Promise<ProjectMediaBackfillCandidate[]> {
  const rows = await history.scanSuccessfulMediaHistory(cursor, limit);
  const taskIds = [...new Set(rows.flatMap((row) => row.entryType === "generation" && row.taskId !== null ? [row.taskId] : []))].sort();
  const evidence = taskIds.length === 0 ? [] : await tasks.findLiveTasksByIds(taskIds);
  const byId = new Map(evidence.map((task) => [task.id, task]));
  return rows.map((row) => classifyHistory(row, row.taskId === null ? undefined : byId.get(row.taskId)));
}

/**
 * Distinguish media outputs from text using actual writer facts.
 * @param row - The retained successful history record.
 * @param task - The live producing task, when still available.
 * @returns Only declared media fields, preserving the original Project.
 * @throws {never} Never.
 */
function classifyHistory(row: NodeHistoryEntity, task: TaskEntity | undefined): ProjectMediaBackfillCandidate {
  const identity = { id: row.id, cursor: row.id, projectId: row.projectId };
  if (row.content === null || row.content.length === 0 || row.entryType === "snapshot") return { ...identity, reason: "insufficient_media_provenance" };
  if (row.entryType === "generation" && !/^(?:image|video|audio|model)\//i.test(row.mimeType ?? "")) {
    if (task === undefined) return { ...identity, reason: "missing_generation_task" };
    if (task.projectId !== row.projectId || !MEDIA_TASK_TYPES.has(task.taskType)) return { ...identity, reason: "insufficient_media_provenance" };
  }
  return { ...identity, urls: [row.content, ...(row.thumbnailUrl === null || row.thumbnailUrl.length === 0 ? [] : [row.thumbnailUrl])] };
}

/**
 * Read only explicitly typed media addresses from retained activity payloads.
 * @param cursor - The last emitted activity identity.
 * @param limit - The configured batch bound.
 * @returns Media provenance and classified legacy payloads.
 * @throws {Error} When the activity repository read fails.
 */
async function readMediaActivities(cursor: string | null, limit: number): Promise<ProjectMediaBackfillCandidate[]> {
  const rows = await projectActivitiesRepo.scanMediaBackfill(cursor, limit);
  return rows.map((row) => {
    const identity = { id: row.id, cursor: row.id, projectId: row.projectId };
    const { kind, fileUrl, thumbnailUrl } = row.payload;
    if ((row.type !== "asset:uploaded" && row.type !== "generation:succeeded") || typeof kind !== "string" || !MEDIA_ACTIVITY_KINDS.has(kind) || typeof fileUrl !== "string" || fileUrl.length === 0) {
      return { ...identity, reason: "insufficient_media_provenance" };
    }
    return { ...identity, urls: [fileUrl, ...(typeof thumbnailUrl === "string" && thumbnailUrl.length > 0 ? [thumbnailUrl] : [])] };
  });
}

/**
 * Attribute registered generation assets through their live producing tasks.
 * @param cursor - The last emitted canonical asset identity.
 * @param limit - The configured batch bound.
 * @returns Task-attributed assets and explicit missing provenance reasons.
 * @throws {Error} When an asset or task repository read fails.
 */
async function readGenerationAssets(cursor: string | null, limit: number): Promise<ProjectMediaBackfillCandidate[]> {
  const rows = await assetRepo.scanGenerationMediaAssets(cursor, limit);
  const taskIds = [...new Set(rows.flatMap((row) => row.generationTaskId === null ? [] : [row.generationTaskId]))].sort();
  const evidence = taskIds.length === 0 ? [] : await tasks.findLiveTasksByIds(taskIds);
  const byId = new Map(evidence.map((task) => [task.id, task]));
  return rows.map((row) => {
    const task = row.generationTaskId === null ? undefined : byId.get(row.generationTaskId);
    const identity = { id: row.id, cursor: row.id, projectId: task?.projectId ?? null };
    if (task === undefined) return { ...identity, reason: "missing_generation_task" };
    if (task.projectId === null) return { ...identity, reason: "insufficient_media_provenance" };
    return { ...identity, assetIds: [row.id] };
  });
}
