// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * has to name a format. Choosing PNG there IS the conversion. Renaming the
 * extension instead is not an option — once the source is drawn onto a canvas
 * the original encoding is gone, and a name that disagrees with the bytes
 * renders as a broken image, since browsers decode by declared type.
 */

import type { CropRect } from '@web/spaces/canvas/focus/crop-math';

/**
 * The edge length of the avatar this module produces, in pixels.
 *
 * Local to the browser, because nothing else consults it: the server stores
 * whatever arrives without reading its dimensions, and every place an avatar
 * is shown is a fixed-size element that crops what it is given.
 *
 * Changing it is not free even so — `avatar.max_bytes` in `config/storage.yaml`
 * is sized against the incompressible worst case AT this resolution, and that
 * worst case scales with the pixel count.
 */
export const AVATAR_OUTPUT_PX = 512;

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
 * (~550 KB for a photograph as PNG), and the two never race: this gate is
 * 20 MB and about the file the user picked, not about what we produce.
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

/**
 * The one format an avatar is stored in — settled, not a default to revisit.
 *
 * PNG is lossless, so there is no quality knob to pass and none is: `toBlob`
 * only consults its quality argument for lossy types. It is also the format
 * `toBlob` falls back to whenever it cannot honour the requested type, which
 * makes it the one request that can never come back as something else — so
 * unlike a lossy target, this needs no "check what actually came out" step.
 *
 * The cost is size, and it cannot be tuned away from here: a browser's PNG
 * encoder takes no parameters. A photograph at this size measures ~550 KB,
 * against ~41 KB for the same picture as WebP. Getting PNG smaller means
 * palette quantisation or a better DEFLATE search, neither of which
 * `canvas.toBlob` offers; it would take a WASM encoder here or re-encoding on
 * the server, and the second contradicts this pipeline's "server does no image
 * processing" shape.
 *
 * The incompressible worst case is 1,049,473 bytes, measured by deflating the
 * scanlines of a 512² RGBA frame whose pixels AND alpha are random — the point
 * where deflate has nothing to remove. Random pixels over an opaque alpha
 * channel stop at ~900 KB, which is the more intuitive number and the wrong one
 * to size a cap against: a picture with soft edges has a varying alpha channel
 * and is a legitimate thing to upload. `avatar.max_bytes` (2 MiB) is sized
 * against the first figure, and it is a function of {@link AVATAR_OUTPUT_PX} —
 * change the output size and that cap has to move with it.
 */
export const AVATAR_OUTPUT_TYPE = 'image/png';

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
export type CanvasEncoder = (type: string) => Promise<Blob | null>;

/**
 * Encode the prepared canvas as the avatar's one format.
 *
 * There is no format negotiation left. `toBlob` never fails on a type it
 * cannot produce — it quietly answers with a PNG — so asking for PNG is the
 * one request whose answer cannot be a surprise, and the old
 * check-then-fall-back-to-JPEG dance has nothing left to catch.
 *
 * A null result is different: that is the canvas refusing to encode at all
 * (tainted by a cross-origin draw, or out of memory), which no retry fixes.
 * @param encode - The canvas encode step.
 * @returns The encoded avatar.
 * @throws {Error} When the canvas produces no blob at all.
 */
export async function encodeAvatarBlob(encode: CanvasEncoder): Promise<Blob> {
  const blob = await encode(AVATAR_OUTPUT_TYPE);
  if (blob === null) throw new Error('canvas produced no image');
  return blob;
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
    (type) => new Promise((resolve) => canvas.toBlob(resolve, type)),
  );
}
