// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ProjectAssetPage, ProjectAssetReferenceEntity, ProjectRegisteredAsset, StudioAssetEntity, TimelineClientLimits } from "@breatic/shared";
import { t } from "@breatic/shared";
import { z } from "zod";
import { AppError, ForbiddenError, NotFoundError } from "@core/app-errors.js";
import * as assetRepo from "@core/asset/asset.repo.js";
import { decodeActivityCursor, encodeActivityCursor } from "@core/activity/project-activities.repo.js";
import { loadProjectRole } from "@core/auth/projectAuth.service.js";
import { getTimelineConfig } from "@core/config/timeline.js";
import { db, type DbTx } from "@core/db/client.js";
import { findLiveOwnerStudioId } from "@core/project/projects.repo.js";
import { getStorageAdapter } from "@core/infra/storage/index.js";

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

/** Explicit media identities captured from an accepted Space or provider result. */
export interface ReferenceRegisteredProjectMediaInput { projectId: string; assetIds?: readonly string[]; urls?: readonly string[] }

/** Classification preserves input identities while returning only canonical rows. */
export interface RegisteredProjectMediaResolution {
  resolved: { kind: "assetId" | "url"; reference: string; asset: StudioAssetEntity }[];
  unavailable: { kind: "assetId" | "url"; reference: string; reason: "external" | "unregistered" | "foreign_studio" }[];
}

/** A read-only classification and the batch's existing Project relationships. */
export interface RegisteredProjectMediaInspection {
  resolution: RegisteredProjectMediaResolution;
  references: ProjectAssetReferenceEntity[];
}

/** Actual relationship insertions reported by a committed acceptance attempt. */
export interface RegisteredProjectMediaAcceptance extends RegisteredProjectMediaInspection {
  insertedAssetIds: string[];
}

/**
 * Inspect registered identities and their current Project relationships.
 * @param input - The Project and its explicitly identified media.
 * @param tx - An enclosing read transaction, when supplied.
 * @returns Read-only classifications and existing relationships.
 * @throws {Error} When the live scope or database read is unavailable.
 */
export async function inspectRegisteredProjectMedia(input: ReferenceRegisteredProjectMediaInput, tx?: DbTx): Promise<RegisteredProjectMediaInspection> {
  const references = await normalizeMediaReferences(input);
  if (tx !== undefined) return inspectMediaInTransaction(input.projectId, references, tx);
  return db.transaction((transaction) => inspectMediaInTransaction(input.projectId, references, transaction));
}

/**
 * Accept registered identities and return the actual inserted relationships.
 * @param input - The accepting Project, media identities and verified names.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns Canonical classifications and the actual insertion identities.
 * @throws {Error} When the owning scope or association transaction fails.
 */
export async function referenceRegisteredProjectMediaDetailed(input: ReferenceRegisteredProjectMediaInput & { displayNames?: Readonly<Record<string, string>> }, tx?: DbTx): Promise<RegisteredProjectMediaAcceptance> {
  const references = await normalizeMediaReferences(input);
  const displayNames = Object.fromEntries(Object.entries(input.displayNames ?? {}).map(([id, name]) => [id.toLowerCase(), name]));
  if (tx !== undefined) return acceptMediaInTransaction(input.projectId, references, displayNames, tx);
  return db.transaction((transaction) => acceptMediaInTransaction(input.projectId, references, displayNames, transaction));
}

/** A declared identity whose storage classification needs no database access. */
type MediaReference = { kind: "assetId"; reference: string } | { kind: "url"; reference: string; storageKey: string | null };

const assetIdentitySchema = z.uuid();

/**
 * Accept registered media and classify unavailable identities without rewriting content.
 * @param input - The accepting Project and semantic media references.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns Canonical registered rows and unavailable classifications.
 * @throws {Error} When the owning scope or valid-reference acceptance fails.
 */
export async function referenceRegisteredProjectMedia(input: ReferenceRegisteredProjectMediaInput, tx?: DbTx): Promise<RegisteredProjectMediaResolution> {
  return (await referenceRegisteredProjectMediaDetailed(input, tx)).resolution;
}

/**
 * Capture stable semantic identities and resolve storage URL keys before SQL.
 * @param input - The explicitly identified media accepted by the caller.
 * @returns Deduplicated references in the existing kind and identity order.
 * @throws {Error} When storage configuration cannot be read.
 */
async function normalizeMediaReferences(input: ReferenceRegisteredProjectMediaInput): Promise<MediaReference[]> {
  const assetIds = [...new Set((input.assetIds ?? []).map((id) => id.toLowerCase()))].sort();
  const urls = [...new Set(input.urls ?? [])].sort();
  const adapter = urls.length === 0 ? undefined : await getStorageAdapter();
  return [
    ...assetIds.map((reference): MediaReference => ({ kind: "assetId", reference })),
    ...urls.map((reference): MediaReference => ({ kind: "url", reference, storageKey: adapter?.keyFromUrl(reference) ?? null })),
  ];
}

/**
 * Classify one captured reference set and accept its valid canonical identities.
 * @param projectId - The Project accepting these semantic references.
 * @param references - Stable input identities and precomputed storage keys.
 * @param displayNames - Verified original names for newly accepted identities.
 * @param tx - The actual association transaction.
 * @returns Resolved rows only after their associations have been accepted.
 * @throws {NotFoundError} When the Project's live owning scope is absent.
 * @throws {Error} When reading or accepting valid references fails.
 */
async function acceptMediaInTransaction(projectId: string, references: readonly MediaReference[], displayNames: Readonly<Record<string, string>>, tx: DbTx): Promise<RegisteredProjectMediaAcceptance> {
  const resolution = await classifyMediaInTransaction(projectId, references, tx);
  const accepted = [...new Set(resolution.resolved.map((item) => item.asset.id))].sort();
  const result = await recordDetailedInTransaction(projectId, accepted, displayNames, tx);
  return { resolution, ...result };
}

/**
 * Inspect one captured reference set without accepting or changing any identity.
 * @param projectId - The Project whose existing relationships are inspected.
 * @param references - Stable semantic identities and precomputed storage keys.
 * @param tx - The transaction providing the inspection snapshot.
 * @returns Canonical classifications and this batch's existing relationships.
 * @throws {NotFoundError} When the live owning scope is absent.
 * @throws {Error} When reading registered identities or relationships fails.
 */
async function inspectMediaInTransaction(projectId: string, references: readonly MediaReference[], tx: DbTx): Promise<RegisteredProjectMediaInspection> {
  const resolution = await classifyMediaInTransaction(projectId, references, tx);
  const assetIds = [...new Set(resolution.resolved.map((item) => item.asset.id))].sort();
  return { resolution, references: await assetRepo.findLiveProjectReferences(projectId, assetIds, tx) };
}

/**
 * Classify explicit media using the live Project and registered storage ledger.
 * @param projectId - The Project identifying the owning Studio.
 * @param references - Captured identities in stable order.
 * @param tx - The actual transaction used for these database reads.
 * @returns Canonical assets and the existing unavailable classifications.
 * @throws {NotFoundError} When the live owning scope is absent.
 * @throws {Error} When reading the owning scope or asset ledger fails.
 */
async function classifyMediaInTransaction(projectId: string, references: readonly MediaReference[], tx: DbTx): Promise<RegisteredProjectMediaResolution> {
  const studioId = await findLiveOwnerStudioId(projectId, tx);
  if (studioId === undefined) throw new NotFoundError(t("server.error.not_found"));
  const ids = references.filter((item) => item.kind === "assetId" && assetIdentitySchema.safeParse(item.reference).success).map((item) => item.reference);
  const keys = references.flatMap((item) => item.kind === "url" && item.storageKey !== null ? [item.storageKey] : []);
  const assets = await assetRepo.findLiveMediaIdentities(ids, keys, tx);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const byKey = new Map(assets.map((asset) => [asset.storageKey, asset]));
  const result: RegisteredProjectMediaResolution = { resolved: [], unavailable: [] };
  for (const item of references) {
    const identity = { kind: item.kind, reference: item.reference };
    if (item.kind === "url" && item.storageKey === null) {
      result.unavailable.push({ ...identity, reason: "external" });
      continue;
    }
    const asset = item.kind === "assetId" ? byId.get(item.reference) : byKey.get(item.storageKey ?? "");
    if (asset === undefined) result.unavailable.push({ ...identity, reason: "unregistered" });
    else if (asset.studioId !== studioId) result.unavailable.push({ ...identity, reason: "foreign_studio" });
    else result.resolved.push({ ...identity, asset });
  }
  return result;
}

/**
 * Copy known live asset relationships inside the Project's business transaction.
 * @param sourceProjectId - The authorized source Project.
 * @param targetProjectId - The new Project in the same Studio.
 * @param tx - The caller's actual Project-copy transaction.
 * @returns Independent target references, retaining any existing target identities.
 * @throws {Error} When the owning scope or association transaction fails.
 */
export async function copyProjectAssetReferences(sourceProjectId: string, targetProjectId: string, tx: DbTx): Promise<ProjectAssetReferenceEntity[]> {
  const sourceStudioId = await findLiveOwnerStudioId(sourceProjectId, tx);
  const targetStudioId = await findLiveOwnerStudioId(targetProjectId, tx);
  if (sourceStudioId === undefined || targetStudioId === undefined || sourceStudioId !== targetStudioId) throw new NotFoundError(t("server.error.not_found"));
  const references = await assetRepo.readLiveProjectReferences(sourceProjectId, sourceStudioId, tx);
  const names = Object.fromEntries(references.flatMap((item) => item.displayName === null ? [] : [[item.assetId, item.displayName]]));
  return recordInTransaction(targetProjectId, references.map((item) => item.assetId), names, tx);
}

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
  return (await recordDetailedInTransaction(projectId, assetIds, displayNames, tx)).references;
}

/**
 * Validate every canonical candidate and report actual association inserts.
 * @param projectId - The accepting Project.
 * @param assetIds - Unique registered identities in stable order.
 * @param displayNames - Optional verified names keyed by canonical identity.
 * @param tx - The caller's actual business transaction.
 * @returns The live relationships and identities inserted by this attempt.
 * @throws {NotFoundError} When any candidate falls outside the live owning scope.
 * @throws {Error} When a database query fails.
 */
async function recordDetailedInTransaction(projectId: string, assetIds: readonly string[], displayNames: Readonly<Record<string, string>>, tx: DbTx): Promise<assetRepo.ProjectReferenceAcceptance> {
  const studioId = await findLiveOwnerStudioId(projectId, tx);
  if (studioId === undefined) throw new NotFoundError(t("server.error.not_found"));
  const assets = await assetRepo.findLiveManyInStudio(studioId, assetIds, tx);
  if (assets.length !== assetIds.length) throw new NotFoundError(t("server.error.not_found"));
  return assetRepo.ensureProjectReferencesDetailed(projectId, assetIds, displayNames, tx);
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
 * Read the public Timeline configuration after checking current Project access.
 * @param projectId - The Project being opened.
 * @param userId - The authenticated current member.
 * @returns Only the creation defaults and Project media limits.
 * @throws {ForbiddenError} When current Project access is absent.
 * @throws {Error} When configuration or authorization cannot be read.
 */
export async function getTimelineLimits(projectId: string, userId: string): Promise<TimelineClientLimits> {
  await studioForMember(projectId, userId);
  const config = getTimelineConfig();
  return {
    defaults: { width: config.defaults.width, height: config.defaults.height, fps: { ...config.defaults.fps } },
    assets: { pageSize: config.assets.page_size, pageMax: config.assets.page_max },
  };
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
