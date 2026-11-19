// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Encoding a captured view within the request's limits (#1488 §19.1): WebP
 * first, JPEG where the browser writes PNG for WebP (Safari, WebKit bug
 * 226950), the quality stepped down until it fits, then the size.
 */

/** Something with pixels to encode: a canvas, or a stand-in in tests. */
export interface Sized {
  width: number;
  height: number;
}

/** Turns pixels into an image of a type at a quality. */
export type Encoder<S extends Sized = Sized> = (source: S, type: string, quality: number) => Promise<Blob>;

/** The qualities tried, best first. */
const QUALITIES = [0.92, 0.8, 0.65, 0.5, 0.35] as const;

/** How much each pass shrinks the picture once the lowest quality is still too big. */
const SHRINK = 0.75;

/**
 * The size a picture takes when its longest edge may be at most `edge`.
 * @param width - Its width.
 * @param height - Its height.
 * @param edge - The longest edge allowed.
 * @returns The size, the aspect kept and each side at least 1.
 */
export function fitEdge(width: number, height: number, edge: number): Sized {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.min(edge, Math.round(width * scale))),
    height: Math.max(1, Math.min(edge, Math.round(height * scale))),
  };
}

/**
 * Encode a picture within a byte bound.
 * @param source - The picture.
 * @param maxBytes - The largest the result may be.
 * @param encode - The encoder.
 * @param resize - Draws the picture at a smaller size.
 * @returns The encoded image.
 * @throws {Error} When even one pixel at the lowest quality is over the bound.
 */
export async function encodeWithin<S extends Sized>(
  source: S,
  maxBytes: number,
  encode: Encoder<S>,
  resize: (width: number, height: number) => S,
): Promise<Blob> {
  let current = source;
  let type = 'image/webp';
  for (;;) {
    for (const quality of QUALITIES) {
      let blob = await encode(current, type, quality);
      if (type === 'image/webp' && blob.type !== type) {
        type = 'image/jpeg';
        blob = await encode(current, type, quality);
      }
      if (blob.size <= maxBytes) return blob;
    }
    if (current.width <= 1 && current.height <= 1) throw new Error('a capture does not fit the byte bound at one pixel');
    current = resize(
      Math.max(1, Math.floor(current.width * SHRINK)),
      Math.max(1, Math.floor(current.height * SHRINK)),
    );
  }
}
