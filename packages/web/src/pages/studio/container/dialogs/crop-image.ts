// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Turning a picked file into the picture that is uploaded: a studio avatar or
 * a project cover.
 *
 * The browser does the raster work; this module owns the decisions around it —
 * what to refuse before decoding, what to refuse after, and what format to
 * actually ship. Those are split out from the drawing so they can be tested
 * without a canvas.
 *
 * Format conversion happens here, and it costs nothing: cropping already has
 * to encode the canvas to a file, and that step has to name a format. Once the
 * source is drawn onto a canvas the original encoding is gone, so the output's
 * format is whatever is asked for here.
 */

import type { CropRect } from '@web/lib/crop-math';

/** The size and format one kind of picture is uploaded as. */
export interface CropOutput {
  width: number;
  height: number;
  type: 'image/png' | 'image/jpeg';
  /** Encoder quality for a lossy type; absent for PNG, which has none. */
  quality?: number;
}

/**
 * A studio avatar: a 512 square, as PNG.
 *
 * Every place an avatar is shown is a fixed-size element that crops what it is
 * given, and PNG keeps a picture with soft edges intact.
 */
export const AVATAR_OUTPUT: CropOutput = { width: 512, height: 512, type: 'image/png' };

/**
 * A project cover: 800×450, as JPEG.
 *
 * Sized to the card. The Projects and Recent grids are
 * `minmax(190px, 1fr)`, so a column never grows past ~392 CSS px before
 * another one fits — 800 wide covers a 2x screen. A cover sits on an opaque
 * card and has no use for an alpha channel, and as JPEG a photograph at this
 * size is a fraction of what it is as PNG, which matters on a grid that loads
 * every visible cover at once.
 */
export const COVER_OUTPUT: CropOutput = {
  width: 800,
  height: 450,
  type: 'image/jpeg',
  quality: 0.85,
};

/**
 * Refuse a picked file above this size without decoding it.
 *
 * This is not a memory guard — a file's byte count says nothing about how much
 * memory its decoded pixels take (that is what {@link MAX_PICKED_EDGE_PX} is
 * for). It is a "that is obviously not a picture" gate, for the case where
 * someone picks a video or an archive.
 */
export const MAX_PICKED_BYTES = 20 * 1024 * 1024;

/**
 * Refuse an image longer than this on either side after decoding.
 *
 * This one IS about memory: decoded pixels cost width × height × 4 bytes, so
 * an 8000px edge is already ~256 MB for a square. The worst case is the
 * user's own tab stalling — the server never sees these pixels — so it is a
 * courtesy limit with a friendly message, not a security boundary.
 */
export const MAX_PICKED_EDGE_PX = 8000;

/** Why a picked file cannot be used, or `null` when it can. */
export type PickedFileProblem = 'too_large' | 'empty';

/** Why decoded pixels cannot be used, or `null` when they can. */
export type PickedPixelProblem = 'too_many_pixels' | 'not_an_image';

/**
 * Check a picked file before spending anything on decoding it.
 * @param file - The picked file; only its size is consulted.
 * @param file.size - Size in bytes.
 * @returns The problem, or `null` when the file is usable.
 */
export function checkPickedFile(file: { size: number }): PickedFileProblem | null {
  if (file.size === 0) return 'empty';
  if (file.size > MAX_PICKED_BYTES) return 'too_large';
  return null;
}

/**
 * Check a decoded image's dimensions.
 * @param width - Natural width in pixels.
 * @param height - Natural height in pixels.
 * @returns The problem, or `null` when the dimensions are usable.
 */
export function checkPickedPixels(
  width: number,
  height: number,
): PickedPixelProblem | null {
  if (width <= 0 || height <= 0) return 'not_an_image';
  if (width > MAX_PICKED_EDGE_PX || height > MAX_PICKED_EDGE_PX) {
    return 'too_many_pixels';
  }
  return null;
}

/** A canvas encode step — `canvas.toBlob` in production, a stub in tests. */
export type CanvasEncoder = (type: string, quality?: number) => Promise<Blob | null>;

/**
 * Encode the prepared canvas in the output's format.
 *
 * `toBlob` does not fail on a type it cannot produce — it answers with a PNG
 * instead — so the result's type is checked rather than trusted. A null
 * result is the canvas refusing to encode at all (tainted by a cross-origin
 * draw, or out of memory), which no retry fixes.
 * @param encode - The canvas encode step.
 * @param output - The format and quality to ask for.
 * @returns The encoded picture.
 * @throws {Error} When the canvas produces nothing, or something else than asked.
 */
export async function encodeCropBlob(
  encode: CanvasEncoder,
  output: CropOutput,
): Promise<Blob> {
  const blob = await encode(output.type, output.quality);
  if (blob === null) throw new Error('canvas produced no image');
  if (blob.type !== output.type) {
    throw new Error(`canvas produced ${blob.type}, not ${output.type}`);
  }
  return blob;
}

/**
 * Draw the cropped region into a canvas of the output's size and encode it.
 *
 * Everything goes through decode → draw → encode, including browsers that
 * offer a decode-time resize: Firefox still does not support that API's
 * scaling options (Bugzilla #1363861), and one path all browsers agree on is
 * worth more than a per-browser branch.
 * @param image - The decoded source image.
 * @param crop - The crop rect in the source's own (natural) pixels.
 * @param output - The size and format to produce.
 * @returns The encoded picture.
 * @throws {Error} When no 2D context is available or the encode fails.
 */
export async function renderCropBlob(
  image: CanvasImageSource,
  crop: CropRect,
  output: CropOutput,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;
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
    output.width,
    output.height,
  );
  return encodeCropBlob(
    (type, quality) =>
      new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
    output,
  );
}
