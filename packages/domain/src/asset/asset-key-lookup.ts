// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a region's ledger holds under storage keys, asked by a paste in this
 * region or another (inner#1955, design 6.15). The bytes sit in the one shared
 * bucket, so a row found here is registered in the pasting Studio without
 * copying them. Every key of a paste is read in two queries.
 */

import { assetRepo } from "@breatic/core";
import type { StudioAssetEntity } from "@breatic/shared";

/** What one region holds under one storage key. */
export interface KeyLookupAnswer {
  /** The live row the key names, or null. */
  asset: StudioAssetEntity | null;
  /** The cover row under the key when it names a video, or null. */
  cover: StudioAssetEntity | null;
}

/**
 * What this region's ledger holds under each key.
 * @param keys - The storage keys.
 * @returns Each key's live row and cover row.
 */
export async function lookupKeysHere(keys: readonly string[]): Promise<Record<string, KeyLookupAnswer>> {
  const found = await assetRepo.findByStorageKeys(keys);
  return Object.fromEntries([...new Set(keys)].map((key) => [key, found.get(key) ?? { asset: null, cover: null }]));
}
