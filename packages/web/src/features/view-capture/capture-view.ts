// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { encodeWithin, fitEdge } from '@web/features/view-capture/encode-capture';
import { viewCapturerOf } from '@web/features/view-capture/registry';

/** What goes back for a capture request: a picture and its view, or a note. */
export type ViewCaptureUpload =
  | { image: Blob; view: Record<string, unknown> }
  | { note: string; view: Record<string, unknown> };

/** Said when the project is open but no Space is in front. */
export const NO_SPACE_NOTE = 'The user has the project open but no Space in front.';

/** Said when the Space in front offers no capture. */
export const NOT_CAPTURABLE_NOTE = 'The Space in front cannot be captured.';

/**
 * Redraw a canvas at another size.
 * @param source - The canvas.
 * @param width - The width wanted.
 * @param height - The height wanted.
 * @returns A new canvas.
 */
function redraw(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  out.getContext('2d')?.drawImage(source, 0, 0, width, height);
  return out;
}

/**
 * Encode a canvas.
 * @param canvas - The canvas.
 * @param type - The image type.
 * @param quality - The quality.
 * @returns The image.
 * @throws {Error} When the browser produced no image.
 */
function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error('the canvas gave no image')) : resolve(blob)), type, quality);
  });
}

/**
 * Capture the Space in front within the request's limits.
 * @param spaceId - The Space in front, or null for none.
 * @param limits - The request's limits.
 * @param limits.maxEdgePx - The longest edge allowed.
 * @param limits.maxBytes - The largest image allowed.
 * @returns What to upload.
 * @throws {Error} When drawing or encoding fails.
 */
export async function captureView(
  spaceId: string | null,
  limits: { maxEdgePx: number; maxBytes: number },
): Promise<ViewCaptureUpload> {
  if (spaceId === null) return { note: NO_SPACE_NOTE, view: {} };
  const capturer = viewCapturerOf(spaceId);
  if (capturer === undefined) return { note: NOT_CAPTURABLE_NOTE, view: { spaceId } };
  const { canvas, view } = await capturer();
  const fit = fitEdge(canvas.width, canvas.height, limits.maxEdgePx);
  const sized = fit.width === canvas.width && fit.height === canvas.height ? canvas : redraw(canvas, fit.width, fit.height);
  const image = await encodeWithin(sized, limits.maxBytes, toBlob, (w, h) => redraw(sized, w, h));
  return { image, view: { spaceId, ...view } };
}
