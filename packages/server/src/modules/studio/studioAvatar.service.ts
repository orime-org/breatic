// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio avatar upload / removal.
 *
 * An avatar is a plain image and nothing more. It is deliberately NOT a
 * project asset: no ledger row, no upload grant, no dedup, no activity entry.
 * Those exist so a studio can be billed for storage and so an upload can be
 * attributed to whoever paid for it; an avatar is neither billed nor
 * attributed, and threading it through that machinery would only add ways to
 * fail. Changing an avatar is changing one URL.
 *
 * Uploads come THROUGH the server rather than by presigned direct upload, so
 * the byte cap is enforced here (see `readBoundedBody`) rather than at a
 * presign step.
 */

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { AppError, getStorageAdapter, sniffMimeType } from "@breatic/core";
import { t } from "@breatic/shared";
import type { Studio } from "@breatic/shared";

/**
 * Accepted image types, and the extension each is stored under.
 *
 * Keyed on what the SNIFFER reports, never on what the client claims. Two
 * entries deserve a note:
 *   - `image/apng` is what an animated PNG sniffs as (measured, not assumed).
 *     Omitting it would reject a perfectly valid PNG while the error message
 *     said PNG was supported.
 *   - both PNG forms store as `.png`, because an APNG *is* a PNG file — the
 *     animation lives in extra chunks a still decoder ignores.
 */
const ACCEPTED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/apng": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Build the storage key for a studio's avatar.
 *
 * `studioId` comes from the database row, and the extension from the server's
 * own whitelist — neither is ever taken from the request. A client-supplied
 * filename or extension is exactly the input that makes path traversal
 * possible, so it does not participate.
 *
 * The timestamp makes every upload a new object rather than overwriting the
 * previous one. That is deliberate: caches and already-rendered pages keep
 * pointing at the old URL, and an overwrite would leave them showing the new
 * image under the old address (or a broken one mid-write). The cost is an
 * orphaned object per replacement, which the storage rules accept — runtime
 * never deletes.
 * @param studioId - The studio's UUID, read from its row
 * @param ext - Extension from {@link ACCEPTED_IMAGE_TYPES}
 * @param now - Millisecond timestamp to stamp into the key
 * @returns The storage key
 */
export function avatarStorageKey(
  studioId: string,
  ext: string,
  now: number,
): string {
  return `avatar/${studioId}/${now}.${ext}`;
}

/**
 * Store an uploaded avatar and point the studio at it.
 *
 * The bytes are typed by sniffing their signature; the `Content-Type` header
 * is ignored entirely, since it is the client's claim about content the
 * client also chose. An unrecognised or non-image signature is refused.
 *
 * Storage is written BEFORE the database. The reverse order can leave the row
 * pointing at an object that was never written — a broken image for every
 * viewer, with nothing to retry from. This way the worst case is an object
 * nobody references, which is the cost the storage rules already accept.
 * @param slug - The studio's URL handle
 * @param bytes - The raw image, already bounded by the caller
 * @returns The updated studio
 * @throws {AppError} 404 no such studio, 415 the bytes are not an accepted image
 */
export async function setAvatar(slug: string, bytes: Buffer): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));

  const mime = await sniffMimeType(bytes);
  const ext = ACCEPTED_IMAGE_TYPES[mime];
  if (ext === undefined) {
    throw new AppError(415, t("server.studio.avatar_unsupported_type"));
  }

  const key = avatarStorageKey(studio.id, ext, Date.now());
  const adapter = await getStorageAdapter();
  const url = await adapter.upload(key, bytes, mime);

  const updated = await studioRepo.updateStudio(studio.id, { avatarUrl: url });
  if (!updated) throw new AppError(404, t("server.error.not_found"));
  return updated;
}

/**
 * Remove a studio's avatar, falling the UI back to initials.
 *
 * Clears the column only. The stored object stays where it is — runtime never
 * deletes from storage, and the row no longer references it, so it is simply
 * unreferenced from here on.
 * @param slug - The studio's URL handle
 * @returns The updated studio
 * @throws {AppError} 404 no such studio
 */
export async function clearAvatar(slug: string): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));
  const updated = await studioRepo.updateStudio(studio.id, { avatarUrl: null });
  if (!updated) throw new AppError(404, t("server.error.not_found"));
  return updated;
}
