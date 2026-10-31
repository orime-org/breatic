// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Re-prove the product's deletion preconditions at preview, approval and execution.
 */
import { type DbTx } from "@breatic/core";
import type { storageReclaimRepo } from "@breatic/domain";
import { assetRepo, uploadGrantRepo } from "@breatic/domain";
import type { MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";

/**
 * Product facts required before direct physical checks.
 * @param candidate - Exact queue record.
 * @param dependencies - Clock and protection limit.
 * @param tx - Optional shared-key locked transaction.
 * @returns Machine refusal reason, or null when product facts qualify.
 */
export async function qualify(candidate: storageReclaimRepo.ReclaimCandidate, dependencies: Pick<MaintenanceDependencies, "config" | "now">, tx?: DbTx): Promise<string | null> {
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
