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

import { randomUUID } from "node:crypto";

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { readPngSize } from "@server/modules/studio/png-size.js";
import { AppError, getStorageAdapter, sniffMimeType } from "@breatic/core";
import { AVATAR_OUTPUT_PX, t } from "@breatic/shared";
import type { Studio } from "@breatic/shared";

/**
 * Accepted image types, and the extension each is stored under.
 *
 * PNG only, and that is not a restriction on what a user may pick. The file
 * picker still takes anything the browser can decode; what arrives here is
 * always the crop dialog's canvas re-encode, and that is PNG by definition.
 * So accepting JPEG or WebP would only widen the door for requests that did
 * not come from our own client — and those are exactly the ones the size rule
 * below has to hold, which it can only do for a format whose header this
 * server knows how to read.
 *
 * Keyed on what the SNIFFER reports, never on what the client claims.
 * `image/apng` is what an animated PNG sniffs as (measured, not assumed);
 * both forms store as `.png`, because an APNG *is* a PNG file — the animation
 * lives in extra chunks a still decoder ignores.
 */
const ACCEPTED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/apng": "png",
};

/**
 * Build the storage key for a studio's avatar.
 *
 * `studioId` comes from the database row, and the extension from the server's
 * own whitelist — neither is ever taken from the request. A client-supplied
 * filename or extension is exactly the input that makes path traversal
 * possible, so it does not participate.
 *
 * Every upload becomes a new object rather than overwriting the previous one.
 * That is deliberate: caches and already-rendered pages keep pointing at the
 * old URL, and an overwrite would leave them showing the new image under the
 * old address (or a broken one mid-write). The cost is an orphaned object per
 * replacement, which the storage rules accept — runtime never deletes.
 *
 * The timestamp alone does not deliver that. Two uploads landing in the same
 * millisecond produce the same key, and the second silently replaces the
 * first — rare over a network, ordinary for a script, and impossible to
 * notice afterwards. The nonce is what makes the property true rather than
 * likely; the timestamp stays because a sortable key is worth keeping.
 * @param studioId - The studio's UUID, read from its row
 * @param ext - Extension from {@link ACCEPTED_IMAGE_TYPES}
 * @param now - Millisecond timestamp to stamp into the key
 * @param nonce - Per-upload random suffix, so the clock is not load-bearing
 * @returns The storage key
 */
export function avatarStorageKey(
  studioId: string,
  ext: string,
  now: number,
  nonce: string,
): string {
  return `avatar/${studioId}/${now}-${nonce}.${ext}`;
}

/**
 * Store an uploaded avatar and point the studio at it.
 *
 * The bytes are typed by sniffing their signature; the `Content-Type` header
 * is ignored entirely, since it is the client's claim about content the
 * client also chose. An unrecognised or non-image signature is refused.
 *
 * Dimensions are checked as well as bytes, and the two catch different things.
 * The byte cap bounds what one request can make this process hold; it says
 * nothing about how expensive the result is to LOOK at, because PNG is
 * compressed — a few hundred kilobytes of flat colour can declare tens of
 * thousands of pixels a side, and then every viewer's browser decodes
 * gigabytes for one avatar. Reading the header (not decoding) is what closes
 * that, and it costs 24 bytes of attention.
 *
 * Storage is written BEFORE the database. The reverse order can leave the row
 * pointing at an object that was never written — a broken image for every
 * viewer, with nothing to retry from. This way the worst case is an object
 * nobody references, which is the cost the storage rules already accept.
 * @param slug - The studio's URL handle
 * @param bytes - The raw image, already bounded by the caller
 * @returns The updated studio
 * @throws {AppError} 404 no such studio, 415 the bytes are not an accepted
 *   image, 422 the image is not the agreed avatar square
 */
export async function setAvatar(slug: string, bytes: Buffer): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));

  const mime = await sniffMimeType(bytes);
  const ext = ACCEPTED_IMAGE_TYPES[mime];
  if (ext === undefined) {
    throw new AppError(415, t("server.studio.avatar_unsupported_type"));
  }

  const size = readPngSize(bytes);
  if (
    size === null ||
    size.width !== AVATAR_OUTPUT_PX ||
    size.height !== AVATAR_OUTPUT_PX
  ) {
    throw new AppError(422, t("server.studio.avatar_unsupported_size"));
  }

  const key = avatarStorageKey(
    studio.id,
    ext,
    Date.now(),
    randomUUID().slice(0, 8),
  );
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
