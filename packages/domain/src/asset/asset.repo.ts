// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Compatibility exports from the single backend asset repository. */
import { assetRepo } from "@breatic/core";

export type { RegisterAssetInput } from "@breatic/core";

/** The shared repository implementation of findByStudioAndHash. */
export const findByStudioAndHash: typeof assetRepo.findByStudioAndHash = assetRepo.findByStudioAndHash;
/** The shared repository implementation of findLiveInStudio. */
export const findLiveInStudio: typeof assetRepo.findLiveInStudio = assetRepo.findLiveInStudio;
/** The shared repository implementation of findLiveByKeyInStudio. */
export const findLiveByKeyInStudio: typeof assetRepo.findLiveByKeyInStudio = assetRepo.findLiveByKeyInStudio;
/** The shared repository implementation of findById. */
export const findById: typeof assetRepo.findById = assetRepo.findById;
/** The shared repository implementation of fillMediaNumbers. */
export const fillMediaNumbers: typeof assetRepo.fillMediaNumbers = assetRepo.fillMediaNumbers;
/** The shared repository implementation of findLiveByStorageKey. */
export const findLiveByStorageKey: typeof assetRepo.findLiveByStorageKey = assetRepo.findLiveByStorageKey;
/** The shared repository implementation of findHashByStorageKey. */
export const findHashByStorageKey: typeof assetRepo.findHashByStorageKey = assetRepo.findHashByStorageKey;
/** The shared repository implementation of findKindByStorageKey. */
export const findKindByStorageKey: typeof assetRepo.findKindByStorageKey = assetRepo.findKindByStorageKey;
/** The shared repository implementation of registerWithDedup. */
export const registerWithDedup: typeof assetRepo.registerWithDedup = assetRepo.registerWithDedup;
/** The shared repository implementation of setCoverAsset. */
export const setCoverAsset: typeof assetRepo.setCoverAsset = assetRepo.setCoverAsset;
/** The shared repository implementation of findCoverOf. */
export const findCoverOf: typeof assetRepo.findCoverOf = assetRepo.findCoverOf;
/** The shared repository implementation of usageByStudio. */
export const usageByStudio: typeof assetRepo.usageByStudio = assetRepo.usageByStudio;
/** The shared repository implementation of usageByStudios. */
export const usageByStudios: typeof assetRepo.usageByStudios = assetRepo.usageByStudios;
