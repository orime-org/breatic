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
import { queueForReclaim } from "@domain/asset/storage-reclaim.repo.js";

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
 * @param input.source - 'ai' | 'upload' | 'cover' (a first-class video cover
 *   row, #1826 §4.5 — counts toward storage like any other asset).
 * @param input.generationTaskId - Producing task (AI only), for cost link.
 * @param input.ownerStudioId - Authoritative owner studio when the caller
 *   already knows it (the upload grant's studio, #1826 §2.2 v15). Omit to
 *   resolve it from the project + acting user.
 * @returns The asset entity, whether it was a dedup hit, and — only when the
 *   reclaim-queue insert failed — a `reclaimQueueFailed` flag (the
 *   registration itself still succeeded).
 * @throws {NotFoundError} If the project / personal studio is missing.
 *
 * On a DEDUP HIT the ledger keeps the existing row, which makes the object the
 * caller just stored redundant. Runtime never deletes it (#1826 §0 rule 1 —
 * zero delete attack surface); instead the redundant key is queued for the
 * OFFLINE reclaim job (§2.3). Doing it HERE rather than at each call site is
 * deliberate: `register` is the single place that knows a dedup happened, so
 * the browser-upload and worker-generation paths get it without either one
 * re-implementing the rule.
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
  ownerStudioId?: string;
}): Promise<{
  asset: StudioAssetEntity;
  deduped: boolean;
  /**
   * True when the dedup loser could NOT be queued for offline reclaim. The
   * registration still SUCCEEDED — this only tells the application layer it may
   * want to warn (the library layer cannot log). The object simply waits for
   * the offline sweep instead of arriving on its work list.
   */
  reclaimQueueFailed?: true;
}> {
  // `ownerStudioId` overrides attribution when the caller already holds the
  // AUTHORITATIVE studio — the browser-upload path reads it off the upload
  // grant (#1826 §2.2 v15), because the grant recorded where the key was
  // actually issued, whereas the report's `project_id` is client input and a
  // member of two studios could point it at the other one to shift storage
  // cost. Paths with no grant (worker generation) omit it and resolve from the
  // project as before.
  const studioId =
    input.ownerStudioId ??
    (await resolveOwnerStudioId(input.projectId, input.actingUserId));
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
  const result = await registerWithDedup(repoInput);
  if (!result.deduped) return result;
  // The stored object lost dedup → hand it to the offline reclaim job. Only
  // INSERTs; the physical object is untouched. Idempotent on storage_key, so a
  // retried report never queues it twice.
  //
  // NEVER fails the registration (Gate-2 R5 H10). This queue is bookkeeping for
  // an OFFLINE job; the ledger row — the thing callers actually depend on — is
  // already committed by the time we get here. Letting an insert failure throw
  // would make callers treat a fully successful upload / generation as failed
  // (422 to the browser, markFailed + no charge in the worker) over a row no
  // user ever sees. This library layer must not log (that is the application's
  // job, @domain/CLAUDE.md), so the failure surfaces as a flag the caller can
  // warn on; worst case the redundant object waits for the offline sweep that
  // already has to handle orphans from crashes.
  try {
    await queueForReclaim({
      storageKey: input.storageKey,
      contentHash: input.contentHash,
      studioId,
      keptStorageKey: result.asset.storageKey,
      // The asset's own source — 'ai' | 'upload' | 'cover' — so the offline
      // job can tell a worker-produced duplicate from a browser-uploaded one
      // (R5: mapping everything non-'ai' to 'upload' mislabelled worker
      // covers, which are 'cover').
      source: input.source,
    });
    return result;
  } catch {
    return { ...result, reclaimQueueFailed: true };
  }
}
