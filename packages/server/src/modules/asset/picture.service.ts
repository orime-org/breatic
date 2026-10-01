// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The address a project cover or a studio avatar is pointed at.
 *
 * Both pictures are ordinary ledger rows, uploaded the way every asset is. The
 * URL a project or a studio then holds is read off that row, never taken from
 * the caller, so it can only ever name bytes the studio really stores and is
 * billed for.
 */

import { assetRepo } from "@breatic/domain";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";

/**
 * The public URL of a live image row in the studio.
 *
 * Another studio's row, a deleted one, a row that is not an image and an id
 * that names nothing all get the same answer, so the caller learns nothing
 * about rows outside its own studio.
 * @param studioId - The studio the picture has to belong to.
 * @param assetId - The ledger row the caller wants to use.
 * @returns The row's public URL.
 * @throws {NotFoundError} When the studio holds no live image row with that id.
 */
export async function pictureUrl(studioId: string, assetId: string): Promise<string> {
  const asset = await assetRepo.findLiveInStudio(studioId, assetId);
  if (asset === null || asset.kind !== "image") {
    throw new NotFoundError(t("server.error.not_found"));
  }
  return asset.fileUrl;
}
