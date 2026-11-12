// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a Timeline layer is drawn, shared by the preview, its hit test and the export (#1410). A layer occupies its
 * base box (the source contained and centred in the canvas); `transform` offsets the box centre in canvas pixels,
 * scales it around that centre and rotates it clockwise in degrees.
 */

/** A clip's stored placement. */
export interface TimelineLayerTransform { x: number; y: number; scaleX: number; scaleY: number; rotation: number }

/** A rectangle in canvas pixels. */
export interface TimelineLayerBox { left: number; top: number; width: number; height: number }

/** A point in canvas pixels. */
export interface TimelineLayerPoint { x: number; y: number }

/** The values `set_transform` accepts; x and y are bounded by this multiple of the document's canvas size. */
export const TIMELINE_LAYER_TRANSFORM_LIMITS = {
  scale: { min: 0.01, max: 100 },
  rotation: { min: -180, max: 180 },
  offsetCanvasMultiple: 10,
  /** The step senders round to before sending. */
  precision: { offset: 0.01, scale: 0.0001, rotation: 0.01 },
} as const;

/**
 * The base box of a source in the canvas: contained and centred.
 * @param canvas - The document canvas size.
 * @param canvas.width - Canvas width in pixels.
 * @param canvas.height - Canvas height in pixels.
 * @param source - The registered source size; a missing dimension means the canvas size.
 * @param source.width - Registered source width, or null.
 * @param source.height - Registered source height, or null.
 * @returns The base box in canvas pixels.
 * @throws {never} Never.
 */
export function timelineLayerBase(
  canvas: { width: number; height: number },
  source: { width: number | null; height: number | null },
): TimelineLayerBox {
  if (source.width === null || source.height === null || source.width <= 0 || source.height <= 0) {
    return { left: 0, top: 0, width: canvas.width, height: canvas.height };
  }
  const fit = Math.min(canvas.width / source.width, canvas.height / source.height);
  const width = source.width * fit;
  const height = source.height * fit;
  return { left: (canvas.width - width) / 2, top: (canvas.height - height) / 2, width, height };
}

/**
 * The CSS transform of an element placed on its base box with `transform-origin: center`.
 * @param transform - The stored placement.
 * @param factor - Display pixels per canvas pixel.
 * @returns The CSS `transform` value.
 * @throws {never} Never.
 */
export function timelineLayerCss(transform: TimelineLayerTransform, factor: number): string {
  return `translate(${transform.x * factor}px, ${transform.y * factor}px) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`;
}

/**
 * The four corners of a placed layer: top-left, top-right, bottom-right, bottom-left of the unrotated box.
 * @param base - The layer's base box.
 * @param transform - The stored placement.
 * @returns The corners in canvas pixels.
 * @throws {never} Never.
 */
export function timelineLayerCorners(base: TimelineLayerBox, transform: TimelineLayerTransform): TimelineLayerPoint[] {
  const cx = base.left + base.width / 2 + transform.x;
  const cy = base.top + base.height / 2 + transform.y;
  const hw = (base.width * transform.scaleX) / 2;
  const hh = (base.height * transform.scaleY) / 2;
  const angle = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({
    x: cx + dx! * cos - dy! * sin,
    y: cy + dx! * sin + dy! * cos,
  }));
}
