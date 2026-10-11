// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What turning a picture upright inside the media container is agreed on
 * (inner#1367 design §4.3): the vips arguments, and where the container writes
 * the result back.
 *
 * Shared by the Worker, which asks for it, and the container, which runs it,
 * so the two sides read one copy of the agreement.
 */

import { objectUrlOn } from "@ingest/object-url.js";

/**
 * The host the container writes an upright picture back to. Only the
 * write-back handler answers on it, and only for the one key it was set for.
 */
export const UPRIGHT_OBJECT_HOST = "upright.local";

/** What the container is told to turn upright and where to put it. */
export interface UprightOrder {
  /** Where to PUT the upright bytes. */
  writeUrl: string;
  /** What the stored bytes read as; decides the encoder. */
  contentType: string;
  /** Whether a WebP's image data is lossless. */
  lossless: boolean;
  /** JPEG and lossy WebP quality, 1-100. */
  quality: number;
  /** The most the upright picture may weigh, in bytes. */
  maxBytes: number;
}

/** The name the media container refers to the write-back handler by. */
export const WRITE_UPRIGHT = "writeUpright";

/** What one run's write-back handler may write: one key, one type, a ceiling. */
export interface UprightWriteGrant {
  /** `uprightKeyFor` of the key the run reads. */
  key: string;
  /** What the stored picture reads as; the upright copy keeps its format. */
  contentType: string;
  /** The most the upright copy may weigh, in bytes. */
  maxBytes: number;
}

/** The headers the container's write-back states the picture's pixel size in. */
export const UPRIGHT_WIDTH_HEADER = "x-upright-width";
export const UPRIGHT_HEIGHT_HEADER = "x-upright-height";

/** How turning a picture upright ended, as the container answers it. */
export type UprightOutcome =
  | { state: "written" }
  | { state: "failed"; step: "turn" | "write" };

/**
 * Where the container writes one key back.
 * @param storageKey - The object being turned upright.
 * @returns The URL.
 */
export function uprightObjectUrl(storageKey: string): string {
  return objectUrlOn(UPRIGHT_OBJECT_HOST, storageKey);
}

/**
 * The vips arguments that turn a picture upright and drop its orientation tag.
 *
 * `autorot` applies all eight EXIF orientations, mirrored ones included, and
 * removes the tag. The colour profile is kept: a Display P3 picture without it
 * is shown as sRGB. The source comes on stdin and the result goes to stdout.
 * @param order - What is being turned.
 * @param order.contentType - What the stored bytes read as.
 * @param order.lossless - Whether a WebP's image data is lossless.
 * @param order.quality - JPEG and lossy WebP quality.
 * @returns The argument list, without the program name; null for a type this
 *   cannot write back.
 */
export function uprightArgs(order: Pick<UprightOrder, "contentType" | "lossless" | "quality">): string[] | null {
  const output = outputFor(order);
  return output === null ? null : ["autorot", "stdin", output];
}

/**
 * The output format string for one picture.
 * @param order - What is being turned.
 * @param order.contentType - What the stored bytes read as.
 * @param order.lossless - Whether a WebP's image data is lossless.
 * @param order.quality - JPEG and lossy WebP quality.
 * @returns The vips output suffix with its options, or null.
 */
function outputFor(order: Pick<UprightOrder, "contentType" | "lossless" | "quality">): string | null {
  switch (order.contentType) {
    case "image/jpeg":
      return `.jpg[Q=${order.quality},keep=icc]`;
    case "image/webp":
      return order.lossless ? ".webp[lossless,keep=icc]" : `.webp[Q=${order.quality},keep=icc]`;
    case "image/png":
      return ".png[keep=icc]";
    default:
      return null;
  }
}
