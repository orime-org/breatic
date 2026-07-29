// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Turning a picked file into the 512×512 avatar the server stores.
 *
 * The browser does the raster work; this module owns the decisions around it —
 * what to refuse before decoding, what to refuse after, and what format to
 * actually ship. Those are split out from the drawing so they can be tested
 * without a canvas.
 *
 * Format conversion happens here rather than on the server, and it costs
 * nothing: cropping already has to encode the canvas to a file, and that step
 * has to name a format. Choosing WebP there IS the conversion. Renaming the
 * extension instead is not an option — once the source is drawn onto a canvas
 * the original encoding is gone, and a name that disagrees with the bytes
 * renders as a broken image, since browsers decode by declared type.
 */

import type { CropRect } from '@web/spaces/canvas/focus/crop-math';

/**
 * Refuse a picked file above this size without decoding it.
 *
 * This is not a memory guard — a file's byte count says nothing about how much
 * memory its decoded pixels take (that is what {@link MAX_AVATAR_INPUT_EDGE_PX}
 * is for). It is a "that is obviously not an avatar" gate, for the case where
 * someone picks a video or an archive.
 *
 * It stays a constant rather than a served config value: an operator has no
 * reason to tune "how big is obviously not a portrait", and the authoritative
 * limit — the one that protects the server — is `avatar.max_bytes` in
 * `config/storage.yaml`, enforced on upload. That one caps the CROPPED result
 * (~30–60 KB in practice), so the two never race.
 */
export const MAX_AVATAR_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * Refuse an image longer than this on either side after decoding.
 *
 * This one IS about memory: decoded pixels cost width × height × 4 bytes, so
 * an 8000px edge is already ~256 MB for a square. The worst case is the
 * user's own tab stalling — the server never sees these pixels — so it is a
 * courtesy limit with a friendly message, not a security boundary.
 */
export const MAX_AVATAR_INPUT_EDGE_PX = 8000;

/** The stored avatar is always a 512×512 square, whatever was cropped. */
export const AVATAR_OUTPUT_PX = 512;

/** Encoder quality; at 512px this lands around 30–60 KB. */
export const AVATAR_OUTPUT_QUALITY = 0.9;

const PRIMARY_TYPE = 'image/webp';
const FALLBACK_TYPE = 'image/jpeg';

/** Why a picked file cannot be used, or `null` when it can. */
export type AvatarFileProblem = 'too_large' | 'empty';

/** Why decoded pixels cannot be used, or `null` when they can. */
export type AvatarPixelProblem = 'too_many_pixels' | 'not_an_image';

/**
 * Check a picked file before spending anything on decoding it.
 * @param file - The picked file; only its size is consulted.
 * @param file.size - Size in bytes.
 * @returns The problem, or `null` when the file is usable.
 */
export function checkAvatarFile(file: {
  size: number;
}): AvatarFileProblem | null {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_AVATAR_INPUT_BYTES) return 'too_large';
  return null;
}

/**
 * Check a decoded image's dimensions.
 * @param width - Natural width in pixels.
 * @param height - Natural height in pixels.
 * @returns The problem, or `null` when the dimensions are usable.
 */
export function checkAvatarPixels(
  width: number,
  height: number,
): AvatarPixelProblem | null {
  if (width <= 0 || height <= 0) return 'not_an_image';
  if (width > MAX_AVATAR_INPUT_EDGE_PX || height > MAX_AVATAR_INPUT_EDGE_PX) {
    return 'too_many_pixels';
  }
  return null;
}

/** A canvas encode step — `canvas.toBlob` in production, a stub in tests. */
export type CanvasEncoder = (
  type: string,
  quality: number,
) => Promise<Blob | null>;

/**
 * Encode the prepared canvas, insisting on a format the result actually is.
 *
 * `toBlob` does not fail on a type it cannot produce — it quietly answers with
 * a PNG. So the produced type is checked rather than assumed; a PNG handed out
 * as WebP would be uploaded under the wrong extension and render broken.
 *
 * The second attempt's result is accepted whatever it turns out to be. A
 * browser supporting neither WebP nor JPEG is hypothetical, and retrying past
 * that point would hang the dialog; PNG is a format the server accepts anyway,
 * so the cost is a larger upload rather than a failure.
 * @param encode - The canvas encode step.
 * @returns The encoded avatar.
 * @throws {Error} When the canvas produces no blob at all.
 */
export async function encodeAvatarBlob(encode: CanvasEncoder): Promise<Blob> {
  const primary = await encode(PRIMARY_TYPE, AVATAR_OUTPUT_QUALITY);
  if (primary === null) throw new Error('canvas produced no image');
  if (primary.type === PRIMARY_TYPE) return primary;

  const fallback = await encode(FALLBACK_TYPE, AVATAR_OUTPUT_QUALITY);
  if (fallback === null) throw new Error('canvas produced no image');
  return fallback;
}

/**
 * Draw the cropped region into a 512×512 canvas and encode it.
 *
 * Everything goes through decode → draw → encode, including browsers that
 * offer a decode-time resize: Firefox still does not support that API's
 * scaling options (Bugzilla #1363861), and one path all browsers agree on is
 * worth more than a per-browser branch.
 * @param image - The decoded source image.
 * @param crop - The crop rect in the source's own (natural) pixels.
 * @returns The encoded 512×512 avatar.
 * @throws {Error} When no 2D context is available or the encode produces nothing.
 */
export async function renderAvatarBlob(
  image: CanvasImageSource,
  crop: CropRect,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_OUTPUT_PX;
  canvas.height = AVATAR_OUTPUT_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    AVATAR_OUTPUT_PX,
    AVATAR_OUTPUT_PX,
  );
  return encodeAvatarBlob(
    (type, quality) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
  );
}
