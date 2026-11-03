// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Re-prove the product's deletion preconditions at preview, approval and execution.
 */
import { type DbTx } from "@breatic/core";
import type { storageReclaimRepo } from "@breatic/domain";
import { assetRepo, presentationPinService, uploadGrantRepo } from "@breatic/domain";
import type { MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";

/**
 * Product facts required before direct physical checks.
 * @param candidate - Exact queue record.
 * @param dependencies - Clock and protection limit.
 * @param tx - Optional shared-key locked transaction.
 * @returns Machine refusal reason, or null when product facts qualify.
 */
export async function qualify(candidate: storageReclaimRepo.ReclaimCandidate, dependencies: Pick<MaintenanceDependencies, "config" | "now">, tx?: DbTx): Promise<string | null> {
  // A derived presentation object (inner#1306 §7.15) has no grant, canonical or kept twin: it may go once no live
  // asset uses its key, its protection period has passed and no live presentation pin references it.
  if (candidate.kind === "derived") {
    if (await assetRepo.hasLiveStorageKey(candidate.storageKey, tx))
      return "live_reference";
    if (dependencies.now().getTime() - candidate.createdAt.getTime() < dependencies.config.protectionSeconds * 1000)
      return "protection_period";
    if (await presentationPinService.isKeyPinned(candidate.storageKey, tx))
      return "pinned";
    return null;
  }
  if (candidate.keptStorageKey === null || candidate.studioId === null || candidate.contentHash === null || candidate.source === null)
    return "canonical_missing";
  if (candidate.storageKey === candidate.keptStorageKey)
    return "candidate_is_kept";
  if (await assetRepo.hasLiveStorageKey(candidate.storageKey, tx))
    return "live_reference";
  const grant = await uploadGrantRepo.findGrantByKey(candidate.originStorageKey ?? candidate.storageKey, tx);
  if (!grant || grant.studioId !== candidate.studioId)
    return "origin_missing";
  if (grant.consumedAt === null || grant.voidedAt !== null)
    return "origin_not_consumed";
  if (!grant.assetId)
    return "canonical_missing";
  const canonical = await assetRepo.findLiveById(grant.assetId, tx);
  if (!canonical || canonical.studioId !== candidate.studioId)
    return "canonical_missing";
  if (candidate.source !== "cover" && (canonical.storageKey !== candidate.keptStorageKey || canonical.contentHash !== candidate.contentHash))
    return "canonical_missing";
  // A cover's grant completes the parent video, while its dedup winner has its own ledger row.
  if (candidate.source === "cover") {
    const kept = await assetRepo.findLiveByStorageKey(candidate.keptStorageKey, tx);
    if (!kept || kept.contentHash !== candidate.contentHash || kept.kind !== "image")
      return "canonical_missing";
  }
  if (dependencies.now().getTime() - Math.max(candidate.createdAt.getTime(), grant.consumedAt.getTime()) < dependencies.config.protectionSeconds * 1000)
    return "protection_period";
  return null;
}
