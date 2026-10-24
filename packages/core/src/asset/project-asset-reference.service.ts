// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectAssetPage, ProjectAssetReferenceEntity, ProjectRegisteredAsset } from "@breatic/shared";
import { t } from "@breatic/shared";
import { AppError, ForbiddenError, NotFoundError } from "@core/app-errors.js";
import * as assetRepo from "@core/asset/asset.repo.js";
import { decodeActivityCursor, encodeActivityCursor } from "@core/activity/project-activities.repo.js";
import { loadProjectRole } from "@core/auth/projectAuth.service.js";
import { getTimelineConfig } from "@core/config/timeline.js";
import { db, type DbTx } from "@core/db/client.js";
import { findLiveOwnerStudioId } from "@core/project/projects.repo.js";

/** Registered identities to associate after the Project has accepted their use. */
export interface RecordProjectAssetReferencesInput {
  projectId: string;
  assetIds: readonly string[];
  displayNames?: Readonly<Record<string, string>>;
}

/** A current member reading one Project's registered media. */
export interface ResolveProjectAssetInput { projectId: string; assetId: string; userId: string }

/** A keyset read of one Project's registered videos. */
export interface ListProjectVideosInput { projectId: string; userId: string; cursor?: string; limit?: number }

/**
 * Persist accepted Project-to-asset relationships in the caller's transaction.
 * @param input - The accepted registered identities and optional verified names.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns The durable live references.
 * @throws {NotFoundError} When the Project, Studio or a scoped live asset is absent.
 * @throws {Error} When the database transaction fails.
 */
export async function recordProjectAssetReferences(input: RecordProjectAssetReferencesInput, tx?: DbTx): Promise<ProjectAssetReferenceEntity[]> {
  const assetIds = [...new Set(input.assetIds.map((id) => id.toLowerCase()))].sort();
  if (assetIds.length === 0) return [];
  const displayNames = Object.fromEntries(Object.entries(input.displayNames ?? {}).map(([id, name]) => [id.toLowerCase(), name]));
  if (tx !== undefined) return recordInTransaction(input.projectId, assetIds, displayNames, tx);
  return db.transaction((transaction) => recordInTransaction(input.projectId, assetIds, displayNames, transaction));
}

/**
 * Validate the whole batch before writing any Project association.
 * @param projectId - The accepting Project.
 * @param assetIds - Unique registered identities in stable order.
 * @param displayNames - Optional verified names keyed by canonical identity.
 * @param tx - The caller's actual business transaction.
 * @returns The committed relationship candidates.
 * @throws {NotFoundError} When any candidate falls outside the live owning scope.
 * @throws {Error} When a database query fails.
 */
async function recordInTransaction(projectId: string, assetIds: readonly string[], displayNames: Readonly<Record<string, string>>, tx: DbTx): Promise<ProjectAssetReferenceEntity[]> {
  const studioId = await findLiveOwnerStudioId(projectId, tx);
  if (studioId === undefined) throw new NotFoundError(t("server.error.not_found"));
  const assets = await assetRepo.findLiveManyInStudio(studioId, assetIds, tx);
  if (assets.length !== assetIds.length) throw new NotFoundError(t("server.error.not_found"));
  return assetRepo.ensureProjectReferences(projectId, assetIds, displayNames, tx);
}

/**
 * Resolve the current Project member without requiring Studio membership.
 * @param projectId - The Project whose media is being read.
 * @param userId - The authenticated current member.
 * @returns The Project's live owning Studio.
 * @throws {ForbiddenError} When current membership or the owning scope is absent.
 * @throws {Error} When the authorization read fails.
 */
async function studioForMember(projectId: string, userId: string): Promise<string> {
  const role = await loadProjectRole(userId, projectId);
  if (role === null) throw new ForbiddenError(t("server.error.forbidden"));
  const studioId = await findLiveOwnerStudioId(projectId);
  if (studioId === undefined) throw new ForbiddenError(t("server.error.forbidden"));
  return studioId;
}

/**
 * Resolve a canonical live asset through the current Project membership.
 * @param input - The current member and requested Project asset.
 * @returns The registered media projection.
 * @throws {ForbiddenError} When current Project access is absent.
 * @throws {NotFoundError} When the live scoped relationship is unavailable.
 * @throws {Error} When a database query fails.
 */
export async function resolveProjectAsset(input: ResolveProjectAssetInput): Promise<ProjectRegisteredAsset> {
  const studioId = await studioForMember(input.projectId, input.userId);
  const [row] = await assetRepo.readProjectMedia({ projectId: input.projectId, studioId, assetId: input.assetId, limit: 1 });
  if (row === undefined) throw new NotFoundError(t("server.error.not_found"));
  return row.media;
}

/**
 * Read one canonical Project-video page at PostgreSQL cursor precision.
 * @param input - The current member, Project and page boundary.
 * @returns The current page and next cursor.
 * @throws {ForbiddenError} When current Project access is absent.
 * @throws {AppError} When the supplied cursor or limit is malformed.
 * @throws {Error} When a database query fails.
 */
export async function listProjectVideos(input: ListProjectVideosInput): Promise<ProjectAssetPage> {
  const studioId = await studioForMember(input.projectId, input.userId);
  const limits = getTimelineConfig().assets;
  const requested = input.limit ?? limits.page_size;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new AppError(400, t("server.error.validation"));
  const limit = Math.min(requested, limits.page_max);
  const cursor = input.cursor === undefined ? undefined : decodeActivityCursor(input.cursor);
  if (cursor === null) throw new AppError(400, t("server.error.validation"));
  const rows = await assetRepo.readProjectMedia({ projectId: input.projectId, studioId, cursor, limit: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => row.media),
    nextCursor: rows.length > limit && last !== undefined ? encodeActivityCursor(last.cursorAt, last.media.projectReferenceId) : null,
  };
}
