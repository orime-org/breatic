// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Asset service — attribution + registration orchestration for the
 * asset layer (spec 2026-07-04-asset-layer-v1).
 *
 * Attribution rule (user 2026-07-04, final): an asset produced in a
 * project belongs to a studio decided by the PROJECT's owning studio
 * type — a PERSONAL-studio project attributes to the ACTING USER's own
 * personal studio (each collaborator keeps their own), while a TEAM
 * (public) studio project attributes to that team studio regardless of
 * who acted. Dedup then happens within that owner studio.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, projects, studios, NotFoundError } from "@breatic/core";
import {
  registerWithDedup,
  type RegisterAssetInput,
} from "@domain/asset/asset.repo.js";
import type { StudioAssetEntity } from "@breatic/shared";

/**
 * Resolve which studio owns an asset produced by `actingUserId` in
 * `projectId`. Personal-studio project → the acting user's own personal
 * studio; team-studio project → the project's (team) studio.
 * @param projectId - Project the asset was produced in.
 * @param actingUserId - User who uploaded / triggered the generation.
 * @returns The owner studio id.
 * @throws {NotFoundError} If the project (or the acting user's personal
 *   studio) does not exist.
 */
export async function resolveOwnerStudioId(
  projectId: string,
  actingUserId: string,
): Promise<string> {
  const proj = await db
    .select({ studioId: projects.studioId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!proj[0]) throw new NotFoundError(`Project ${projectId} not found`);
  const projectStudioId = proj[0].studioId;

  const st = await db
    .select({ type: studios.type })
    .from(studios)
    .where(eq(studios.id, projectStudioId))
    .limit(1);
  if (st[0]?.type !== "personal") {
    // Team (public) studio project: the studio owns the asset.
    return projectStudioId;
  }

  // Personal-studio project: the acting user's OWN personal studio owns
  // the asset (a collaborator keeps their own output).
  const own = await db
    .select({ id: studios.id })
    .from(studios)
    .where(
      and(
        eq(studios.createdByUserId, actingUserId),
        eq(studios.type, "personal"),
        isNull(studios.deletedAt),
      ),
    )
    .limit(1);
  if (!own[0]) {
    throw new NotFoundError(
      `Acting user ${actingUserId} has no personal studio`,
    );
  }
  return own[0].id;
}

/**
 * Register an asset against its resolved owner studio, with
 * within-studio dedup. Callers (server upload handshake, worker
 * generation Stage 4) pass the project + acting user; attribution is
 * resolved here.
 * @param input - Project + acting user + physical asset fields.
 * @param input.projectId - Project the asset was produced in.
 * @param input.actingUserId - User who uploaded / triggered generation.
 * @param input.contentHash - sha256 hex (dedup key, never in the URL).
 * @param input.storageKey - Random storage key.
 * @param input.fileUrl - Public URL embedded in Yjs.
 * @param input.sizeBytes - Byte size (from storage head()).
 * @param input.mimeType - MIME type.
 * @param input.kind - image | video | audio | document | file.
 * @param input.source - 'ai' | 'upload'.
 * @param input.generationTaskId - Producing task (AI only), for cost link.
 * @returns The asset entity plus whether it was a dedup hit.
 * @throws {NotFoundError} If the project / personal studio is missing.
 */
export async function register(input: {
  projectId: string;
  actingUserId: string;
  contentHash: string;
  storageKey: string;
  fileUrl: string;
  sizeBytes: number;
  mimeType: string;
  kind: StudioAssetEntity["kind"];
  source: StudioAssetEntity["source"];
  generationTaskId?: string;
}): Promise<{ asset: StudioAssetEntity; deduped: boolean }> {
  const studioId = await resolveOwnerStudioId(
    input.projectId,
    input.actingUserId,
  );
  const repoInput: RegisterAssetInput = {
    studioId,
    contentHash: input.contentHash,
    storageKey: input.storageKey,
    fileUrl: input.fileUrl,
    sizeBytes: input.sizeBytes,
    mimeType: input.mimeType,
    kind: input.kind,
    source: input.source,
    ...(input.generationTaskId !== undefined && {
      generationTaskId: input.generationTaskId,
    }),
  };
  return registerWithDedup(repoInput);
}
