// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The pictures a 3D generation reads, resolved against its Project
 * (inner#1691 design 4.2 step 4, 6.1).
 *
 * The 3D Space's dialog names a view by its Project asset id; the agent names
 * it by an id or by the address it saw (a chat upload, a saved picture, a
 * Canvas node's media). Either way the view is accepted only as an image this
 * Project references, and it travels on as its registered address, so the
 * submit route and the proposal tool agree on what a view is.
 */

import { assetRepo, getStorageAdapter, NotFoundError, projectsRepo, ValidationError } from "@breatic/core";
import { t } from "@breatic/shared";

import { findLiveByKeyInStudio } from "@domain/asset/asset.repo.js";
import { SCENE_VIEW_SLOTS } from "@domain/model-catalog/scene-generation.js";

/** One resolved view. */
export interface ProjectImageInput {
  assetId: string;
  /** Its registered address. */
  url: string;
  /** Its name in the Project; null for a backend upload, which has none. */
  displayName: string | null;
}

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The words naming a view slot, for a refusal.
 * @param index - The view's place in the order.
 * @returns Its number and name.
 */
function slotOf(index: number): { index: number; slot: string } {
  return { index: index + 1, slot: SCENE_VIEW_SLOTS[index] ?? "other" };
}

/**
 * Resolve the views in order to Project images.
 * @param projectId - The Project the run belongs to.
 * @param inputs - Asset ids or registered addresses, in front, left, back, right order.
 * @returns One resolved image per input, in the same order.
 * @throws {NotFoundError} When the Project has no live owning Studio.
 * @throws {ValidationError} 422 naming the view slot when an input is not an image this Project references.
 * @throws {Error} When storage configuration or a database read fails.
 */
export async function resolveProjectImageInputs(projectId: string, inputs: readonly string[]): Promise<ProjectImageInput[]> {
  if (inputs.length === 0) return [];
  const studioId = await projectsRepo.findLiveOwnerStudioId(projectId);
  if (studioId === undefined) throw new NotFoundError(t("server.error.not_found"));
  const storage = await getStorageAdapter();
  const resolved: ProjectImageInput[] = [];
  for (const [index, input] of inputs.entries()) {
    let assetId: string | null = ASSET_ID.test(input) ? input : null;
    if (assetId === null) {
      const key = storage.keyFromUrl(input);
      assetId = key === null ? null : ((await findLiveByKeyInStudio(studioId, key))?.id ?? null);
    }
    const [row] = assetId === null ? [] : await assetRepo.readProjectMedia({ projectId, studioId, assetId, limit: 1 });
    if (row === undefined) {
      throw new ValidationError(t("server.three_d.view_not_found", { ...slotOf(index), input }));
    }
    if (row.media.kind !== "image") {
      throw new ValidationError(t("server.three_d.view_not_image", { ...slotOf(index), kind: row.media.kind }));
    }
    resolved.push({ assetId: row.media.assetId, url: row.media.fileUrl, displayName: row.media.displayName });
  }
  return resolved;
}
