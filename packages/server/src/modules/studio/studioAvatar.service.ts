// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Studio avatar: pointing the studio at a picture, and clearing it.
 *
 * The picture is an ordinary asset. It is uploaded the way every asset is —
 * a ticket, the ingest Worker, a ledger row — so it counts toward storage and
 * dedups like anything else the studio stores. What happens here is the last
 * step: the studio row is pointed at that asset's URL.
 */

import { directoryWrites, studioRepo } from "@breatic/domain";
import { pictureUrl } from "@server/modules/asset/picture.service.js";
import { AppError, db } from "@breatic/core";
import { t } from "@breatic/shared";
import type { Studio } from "@breatic/shared";

/**
 * Point the studio's avatar at an uploaded picture.
 *
 * The URL is read off the ledger row, so it can only name an image this studio
 * stores. The picture it replaces stays in the ledger.
 * @param slug - The studio's URL handle
 * @param assetId - The uploaded picture's ledger row
 * @returns The updated studio
 * @throws {AppError} 404 no such studio — over HTTP this is reachable only if
 *   the studio is soft-deleted between `requireStudioRole`'s lookup and this
 *   one, since that middleware answers `403` for a slug it cannot resolve
 * @throws {NotFoundError} when the studio holds no live image row with that id
 */
export async function setAvatar(slug: string, assetId: string): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));
  const url = await pictureUrl(studio.id, assetId);
  return writeAvatar(studio.id, url);
}

/**
 * Remove a studio's avatar, falling the UI back to initials.
 *
 * Clears the column only. The stored object stays where it is — runtime never
 * deletes from storage, and the row no longer references it, so it is simply
 * unreferenced from here on.
 * @param slug - The studio's URL handle
 * @returns The updated studio
 * @throws {AppError} 404 no such studio — as in {@link setAvatar}, reachable
 *   over HTTP only through a soft-delete racing the role middleware's lookup
 */
export async function clearAvatar(slug: string): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));
  return writeAvatar(studio.id, null);
}

/**
 * Write the avatar here and in the directory, in one transaction (inner#1955).
 * @param studioId - The studio.
 * @param avatarUrl - The picture's URL, or null to clear it.
 * @returns The updated studio
 * @throws {AppError} 404 the studio is gone
 */
async function writeAvatar(studioId: string, avatarUrl: string | null): Promise<Studio> {
  return db.transaction(async (tx) => {
    await studioRepo.lockStudio(studioId, tx);
    const updated = await studioRepo.updateStudio(studioId, { avatarUrl });
    if (!updated) throw new AppError(404, t("server.error.not_found"));
    await directoryWrites.profileChanged(studioId, { avatarUrl }, tx);
    return updated;
  });
}
