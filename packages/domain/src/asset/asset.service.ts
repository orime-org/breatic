// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Asset service — attribution + registration orchestration for the
 * asset layer (spec 2026-07-04-asset-layer-v1).
 *
 * ATTRIBUTION (user 2026-07-28, #1839 — supersedes the 2026-07-04 rule):
 * an asset belongs to the studio that owns the PROJECT it was produced in,
 * personal and team studios alike. Who acted does not enter into it. Dedup
 * then happens within that owner studio.
 *
 * The superseded rule sent a PERSONAL-studio project's asset to the ACTING
 * user's own personal studio ("each collaborator keeps their own"). That
 * split one concept into two models: a project owner could not see a
 * collaborator's output inside their own project, and dedup was effectively
 * off in personal projects — one domain per collaborator meant the same
 * bytes were stored once per person.
 *
 * PRODUCER is now its own column (`produced_by_user_id`) instead of being
 * implied by attribution. On a dedup hit the existing row keeps its original
 * producer: the question that column answers is "who FIRST brought this
 * content into the studio".
 *
 * TRUST MODEL (user 2026-07-28 — DECIDED, NOT TECHNICALLY CLOSED): one dedup
 * domain per studio means every editor of any project in that studio shares
 * the studio's hash namespace. Inviting someone into a studio or project is
 * an act of trust. The residual risks — content-existence probing via a hash
 * the caller already holds, cross-user dedup poisoning (`/local-upload` does
 * not verify the hash and `/uploaded` trusts the client's), quota consumption,
 * and using any of another member's assets as the cover of one's own video
 * node (the cover_hash residual in routes/assets.ts) — are borne by the user
 * who issued the invitation. NOTE: the product intends to spell these out in a
 * user manual and terms of service, but NEITHER EXISTS YET — there is no
 * route, no locale copy, no document. Treat the disclosure as OUTSTANDING, not
 * done. These are ACCEPTED risks, not fixed ones — do not read "decided" as
 * "closed". The decision and its rationale live in the private engineering
 * record.
 */

import { and, eq, isNull } from "drizzle-orm";
import { db, projects, NotFoundError } from "@breatic/core";
import {
  registerWithDedup,
  type RegisterAssetInput,
} from "@domain/asset/asset.repo.js";
import type { StudioAssetEntity } from "@breatic/shared";
import { queueForReclaim } from "@domain/asset/storage-reclaim.repo.js";

/**
 * Resolve which studio owns an asset produced in `projectId` — always the
 * project's own studio, personal and team alike (#1839).
 *
 * This stayed a service function rather than collapsing into its callers
 * because it is the single place that states the attribution POLICY. The
 * body is one query today; the rule it encodes is what other code depends
 * on, and dedup scope + future billing both derive from this one answer.
 * @param projectId - Project the asset was produced in.
 * @returns The owner studio id.
 * @throws {NotFoundError} If the project does not exist or is soft-deleted.
 */
export async function resolveOwnerStudioId(projectId: string): Promise<string> {
  const proj = await db
    .select({ studioId: projects.studioId })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
    .limit(1);
  if (!proj[0]) throw new NotFoundError(`Project ${projectId} not found`);
  return proj[0].studioId;
}

/**
 * Register an asset against its owner studio, with within-studio dedup.
 * Callers (server upload handshake, worker generation Stage 4) pass the
 * project + acting user: the project decides the OWNER studio, the acting
 * user is recorded as the PRODUCER (#1839).
 * @param input - Project + acting user + physical asset fields.
 * @param input.projectId - Project the asset was produced in.
 * @param input.actingUserId - User who uploaded / triggered generation.
 *   Stored as `produced_by_user_id`; does NOT affect which studio owns the
 *   asset. On a dedup hit the existing row's producer is kept.
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
 *   resolve it from the project.
 * @returns The asset entity, whether it was a dedup hit, and — only when the
 *   reclaim-queue insert failed — a `reclaimQueueFailed` flag (the
 *   registration itself still succeeded).
 * @throws {NotFoundError} If the project does not exist or is soft-deleted.
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
    input.ownerStudioId ?? (await resolveOwnerStudioId(input.projectId));
  const repoInput: RegisterAssetInput = {
    studioId,
    producedByUserId: input.actingUserId,
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
