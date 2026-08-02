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
 * the byte cap is enforced by the route (`readBoundedBody`) rather than at a
 * presign step. This module receives an already-bounded buffer.
 */

import { randomUUID } from "node:crypto";

import * as studioRepo from "@server/modules/studio/studio.repo.js";
import { AppError, getStorageAdapter, sniffMimeType } from "@breatic/core";
import { t } from "@breatic/shared";
import type { Studio } from "@breatic/shared";

/**
 * Accepted image types, and the extension each is stored under.
 *
 * This is not a validation step and does not try to be one. A stored object
 * needs an extension and a `Content-Type` to be served under, and both have to
 * come from somewhere the client does not control — otherwise a browser is
 * told to render the bytes as something they are not. Sniffing the signature
 * is how that is decided; the request header is the client's claim about
 * content the client also chose, so it takes no part.
 *
 * PNG only, because PNG is what the crop dialog's canvas re-encode produces —
 * `AVATAR_OUTPUT_TYPE` in `packages/web/.../avatar-image.ts` is the other half
 * of this pair, and changing it there without changing this refuses every
 * upload. Anything else would be an upload that did not come from our own
 * client, and there is no picture it could be that the client could not have
 * sent as PNG.
 *
 * A file that is not in this table is refused, which makes the table look like
 * a validation gate. It is not one, and the difference matters for what gets
 * added here: an entry is warranted when we have somewhere to store that type,
 * never when a type "seems safe".
 */
const ACCEPTED_IMAGE_TYPES: Readonly<Record<string, string>> = {
  "image/png": "png",
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
 * What the bytes contain is the client's business. An avatar is one URL on one
 * row, shown in a fixed-size element that crops whatever it is given; it is
 * not a project asset — nothing is billed for it and nothing else consumes it.
 * Only an admin of this studio can get here at all. So the server takes the
 * picture as sent: the caller has already bounded its size, and there is
 * nothing further worth establishing about the pixels inside it.
 *
 * Note what is NOT part of that reasoning: who can SEE the result. The URL
 * goes to any authenticated user who reads the studio shell (`GET /:slug` has
 * no role gate, by decision), and the object itself is served publicly. The
 * argument rests on who can PUT one there, which is an admin of the one studio
 * it will appear on.
 *
 * Storage is written BEFORE the database. The reverse order can leave the row
 * pointing at an object that was never written — a broken image for every
 * viewer, with nothing to retry from. This way the worst case is an object
 * nobody references, which is the cost the storage rules already accept.
 * @param slug - The studio's URL handle
 * @param bytes - The raw image, already bounded by the caller
 * @returns The updated studio
 * @throws {AppError} 404 no such studio — over HTTP this is reachable only if
 *   the studio is soft-deleted between `requireStudioRole`'s lookup and this
 *   one, since that middleware answers `403` for a slug it cannot resolve;
 *   415 bytes whose signature is not one this server has an extension for
 */
export async function setAvatar(slug: string, bytes: Buffer): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));

  const mime = await sniffMimeType(bytes);
  const ext = ACCEPTED_IMAGE_TYPES[mime];
  if (ext === undefined) {
    throw new AppError(415, t("server.studio.avatar_unsupported_type"));
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
 * @throws {AppError} 404 no such studio — as in {@link setAvatar}, reachable
 *   over HTTP only through a soft-delete racing the role middleware's lookup
 */
export async function clearAvatar(slug: string): Promise<Studio> {
  const studio = await studioRepo.getBySlug(slug);
  if (!studio) throw new AppError(404, t("server.error.not_found"));
  const updated = await studioRepo.updateStudio(studio.id, { avatarUrl: null });
  if (!updated) throw new AppError(404, t("server.error.not_found"));
  return updated;
}
