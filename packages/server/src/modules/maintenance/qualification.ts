// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Re-prove the product's deletion preconditions at preview, approval and execution.
 */
import { type DbTx } from "@breatic/core";
import type { storageReclaimRepo } from "@breatic/domain";
import { assetRepo, presentationPinService, uploadGrantRepo } from "@breatic/domain";
import type { MaintenanceDependencies } from "@server/modules/maintenance/dependencies.js";

/** The fixed key of a canonical key's current presentation descriptor (frames-split §7.15); it follows the canonical object. */
const DESCRIPTOR_SUFFIX = ".video-presentation.v1.json";

/**
 * Every `storageKey` a stored descriptor names, at any depth: its playback carrier, manifest and edit file.
 * @param value - The parsed descriptor.
 * @returns The keys.
 * @throws {never} Never.
 */
function descriptorKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptorKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([field, inner]) => (field === "storageKey" && typeof inner === "string" ? [inner] : descriptorKeys(inner)));
}

/**
 * Whether the canonical key's current R2 descriptor references a derived object (frames-split §7.15): the DO publishes P
 * outside the SQL pin transaction, so an object it references may have no pin yet. An unreadable descriptor refuses.
 * @param storageKey - The derived object.
 * @param canonicalKey - Its canonical key.
 * @param storage - The maintenance storage port.
 * @returns The refusal, or null when the descriptor does not reference it.
 * @throws {Error} When the storage read fails.
 */
async function descriptorReason(storageKey: string, canonicalKey: string, storage: Pick<MaintenanceDependencies["storage"], "read"> | null): Promise<string | null> {
  if (storage === null) return "executor_unavailable";
  const text = await storage.read(`${canonicalKey}${DESCRIPTOR_SUFFIX}`);
  if (text === null) return null;
  let descriptor: unknown;
  try { descriptor = JSON.parse(text); }
  catch { return "descriptor_unreadable"; }
  return descriptorKeys(descriptor).includes(storageKey) ? "descriptor_reference" : null;
}

/**
 * Product facts required before direct physical checks.
 * @param candidate - Exact queue record.
 * @param dependencies - Clock, protection limit and the storage port a derived row's descriptor is read through (null when
 *   the executor is not configured).
 * @param tx - Optional shared-key locked transaction.
 * @returns Machine refusal reason, or null when product facts qualify.
 */
export async function qualify(candidate: storageReclaimRepo.ReclaimCandidate, dependencies: Pick<MaintenanceDependencies, "config" | "now"> & { storage: Pick<MaintenanceDependencies["storage"], "read"> | null }, tx?: DbTx): Promise<string | null> {
  // A derived object (inner#1306 §7.15) has no grant or dedup twin: it may go once no live asset uses its key, its
  // protection period has passed, no live presentation pin references it and, for a presentation-derived object (its
  // canonical key in keptStorageKey), the canonical key's current descriptor does not reference it either.
  if (candidate.kind === "derived") {
    if (await assetRepo.hasLiveStorageKey(candidate.storageKey, tx))
      return "live_reference";
    if (dependencies.now().getTime() - candidate.createdAt.getTime() < dependencies.config.protectionSeconds * 1000)
      return "protection_period";
    if (await presentationPinService.isKeyPinned(candidate.storageKey, tx))
      return "pinned";
    return candidate.keptStorageKey === null ? null : descriptorReason(candidate.storageKey, candidate.keptStorageKey, dependencies.storage);
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
