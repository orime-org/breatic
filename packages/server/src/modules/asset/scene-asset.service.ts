// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { NotFoundError } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { isSceneLookImageMediaType, isSceneModelMediaType, t } from "@breatic/shared";

import * as projectService from "@server/modules/project/project.service.js";

/** A registered model or part picture descriptor consumed by the scene resource loader. */
export interface SceneAssetDescriptor {
  url: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Resolve an existing model asset, or a picture a part look uses, in a Project's owning Studio.
 *
 * Project access is checked before the asset lookup. The repository restricts
 * the lookup to live rows in that Studio; all other ids and unsupported media
 * receive the same not-found result. A model's registered container holds the GLB
 * or the complete versioned model package; a picture is a PNG, JPEG or WebP. Its URL
 * and size come from the row.
 * @param projectId - Project whose scene references the asset.
 * @param userId - Caller who must be able to view that Project.
 * @param assetId - Registered asset id stored in the scene model reference.
 * @returns The registered URL, its MIME type and its registered size.
 * @throws {NotFoundError} When the caller cannot view the Project or no live supported model or picture matches.
 */
export async function resolveSceneAsset(
  projectId: string,
  userId: string,
  assetId: string,
): Promise<SceneAssetDescriptor> {
  const project = await projectService.get(projectId, userId);
  const asset = await assetRepo.findLiveInStudio(project.studioId, assetId);
  if (asset === null || !(isSceneModelMediaType(asset.mimeType) || isSceneLookImageMediaType(asset.mimeType))) {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return { url: asset.fileUrl, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
}
