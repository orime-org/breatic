// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NotFoundError } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { t } from "@breatic/shared";

import * as projectService from "@server/modules/project/project.service.js";

/** A registered model descriptor consumed by the scene resource loader. */
export interface SceneAssetDescriptor {
  url: string;
  mimeType: string;
}

/**
 * Resolve an existing model asset in a Project's owning Studio.
 *
 * Project access is checked before the asset lookup. The repository restricts
 * the lookup to live rows in that Studio; all other ids and unsupported media
 * receive the same not-found result. The current scene loader supports GLB;
 * glTF bundles and external dependencies belong to the import follow-up.
 * The URL comes from the registered row.
 * @param projectId - Project whose scene references the asset.
 * @param userId - Caller who must be able to view that Project.
 * @param assetId - Registered asset id stored in the scene model reference.
 * @returns The registered URL and its model MIME type.
 * @throws {NotFoundError} When the caller cannot view the Project or no live supported model matches.
 */
export async function resolveSceneAsset(
  projectId: string,
  userId: string,
  assetId: string,
): Promise<SceneAssetDescriptor> {
  const project = await projectService.get(projectId, userId);
  const asset = await assetRepo.findLiveInStudio(project.studioId, assetId);
  if (asset === null || asset.mimeType !== "model/gltf-binary") {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return { url: asset.fileUrl, mimeType: asset.mimeType };
}
