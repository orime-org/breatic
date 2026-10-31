// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { getStorageAdapter } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import type { LongMediaSourceReference } from "@breatic/shared";

/**
 * Resolve a stored media URL to the live asset facts used by a long-media job.
 * @param url - The canonical asset URL.
 * @param studioId - The Studio that must own a live asset for the key.
 * @returns The immutable source facts, or null when the URL is not a live asset in that Studio.
 * @throws {Error} When storage configuration or the asset lookup fails.
 */
export async function canonicalMediaSourceFor(
  url: string,
  studioId: string,
): Promise<LongMediaSourceReference | null> {
  const storage = await getStorageAdapter();
  const key = storage.keyFromUrl(url);
  if (key === null) return null;
  const asset = await assetRepo.findLiveByKeyInStudio(studioId, key);
  if (asset === null) return null;
  return {
    key: asset.storageKey,
    sha256: asset.contentHash,
    sizeBytes: asset.sizeBytes,
    mimeType: asset.mimeType,
  };
}
