// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { assetRepo, NotFoundError, projectAssetReferenceService } from "@breatic/core";
import { t } from "@breatic/shared";
import type { StoredAsset } from "@breatic/domain";

/**
 * Accept an existing registered output before handing its canonical metadata to a node.
 * @param projectId - The producing task's Project.
 * @param url - The owned storage URL returned by the producer.
 * @returns Canonical metadata for a live asset in the Project's owning Studio.
 * @throws {NotFoundError} When the URL has no eligible registered identity.
 * @throws {Error} When accepting the durable Project relationship fails.
 */
export async function resolveRegisteredProjectMedia(projectId: string, url: string): Promise<StoredAsset> {
  const result = await projectAssetReferenceService.referenceRegisteredProjectMedia({ projectId, urls: [url] });
  const asset = result.resolved[0]?.asset;
  if (asset === undefined) throw new NotFoundError(t("server.error.not_found"));
  const cover = asset.kind === "video" ? await assetRepo.findCoverOf(asset.id) : null;
  return {
    assetId: asset.id,
    fileUrl: asset.fileUrl,
    kind: asset.kind,
    coverUrl: cover !== null && cover.studioId === asset.studioId ? cover.fileUrl : null,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  };
}
