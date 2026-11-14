// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Where a Timeline layer is drawn, shared by the preview and its hit test, and what a sender sends for it
 * (#1410). A layer occupies its base box (the source contained and centred in the canvas); `transform` offsets the box
 * centre by a fraction of the frame width and height (#1502), scales it around that centre and rotates it clockwise in
 * degrees. Offsets that follow the frame keep every layer at the same place relative to the frame when the frame size
 * changes.
 */

/** A clip's stored placement; `frameX` and `frameY` are the centre offset as fractions of the frame width and height. */
export interface TimelineLayerTransform { frameX: number; frameY: number; scaleX: number; scaleY: number; rotation: number }

/** A frame size in canvas pixels. */
export interface TimelineLayerFrame { width: number; height: number }

/** A rectangle in canvas pixels. */
export interface TimelineLayerBox { left: number; top: number; width: number; height: number }

/** A point in canvas pixels. */
export interface TimelineLayerPoint { x: number; y: number }

/** The values `set_transform` accepts; frameX and frameY are bounded by this multiple of the frame size. */
export const TIMELINE_LAYER_TRANSFORM_LIMITS = {
  scale: { min: 0.01, max: 100 },
  rotation: { min: -180, max: 180 },
  offsetCanvasMultiple: 10,
  /** The step senders round to before sending. */
  // The offset step keeps a whole canvas pixel exact at the widest preset, 2520 pixels.
  precision: { offset: 0.00001, scale: 0.0001, rotation: 0.01 },
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
 * A frame offset in canvas pixels from the frame centre.
 * @param frame - The frame size.
 * @param offset - The offset as fractions of the frame.
 * @param offset.frameX - Horizontal offset as a fraction of the frame width.
 * @param offset.frameY - Vertical offset as a fraction of the frame height.
 * @returns The offset in canvas pixels.
 * @throws {never} Never.
 */
export function timelineLayerOffsetPixels(frame: TimelineLayerFrame, offset: { frameX: number; frameY: number }): TimelineLayerPoint {
  return { x: offset.frameX * frame.width, y: offset.frameY * frame.height };
}

/**
 * A canvas-pixel offset from the frame centre as fractions of the frame.
 * @param frame - The frame size.
 * @param offset - The offset in canvas pixels.
 * @returns The offset as fractions of the frame.
 * @throws {never} Never.
 */
export function timelineLayerFrameOffset(frame: TimelineLayerFrame, offset: TimelineLayerPoint): { frameX: number; frameY: number } {
  return { frameX: offset.x / frame.width, frameY: offset.y / frame.height };
}

/** A placed layer's style in display pixels, for an absolutely positioned element in the preview frame. */
export interface TimelineLayerStyle { left: string; top: string; width: string; height: string; transform: string; transformOrigin: string }

/**
 * The CSS transform of an element placed on its base box with `transform-origin: center`.
 * @param frame - The frame size.
 * @param transform - The stored placement.
 * @param factor - Display pixels per canvas pixel.
 * @returns The CSS `transform` value.
 * @throws {never} Never.
 */
function timelineLayerCss(frame: TimelineLayerFrame, transform: TimelineLayerTransform, factor: number): string {
  const offset = timelineLayerOffsetPixels(frame, transform);
  return `translate(${offset.x * factor}px, ${offset.y * factor}px) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`;
}

/**
 * A layer's box and transform in display pixels.
 * @param frame - The frame size.
 * @param base - Its base box in canvas pixels.
 * @param transform - Its stored or live placement.
 * @param factor - Display pixels per canvas pixel.
 * @returns The style.
 * @throws {never} Never.
 */
export function timelineLayerStyle(frame: TimelineLayerFrame, base: TimelineLayerBox, transform: TimelineLayerTransform, factor: number): TimelineLayerStyle {
  return {
    left: `${base.left * factor}px`, top: `${base.top * factor}px`, width: `${base.width * factor}px`, height: `${base.height * factor}px`,
    transform: timelineLayerCss(frame, transform, factor), transformOrigin: "center",
  };
}

/**
 * The four corners of a placed layer: top-left, top-right, bottom-right, bottom-left of the unrotated box.
 * @param frame - The frame size.
 * @param base - The layer's base box.
 * @param transform - The stored placement.
 * @returns The corners in canvas pixels.
 * @throws {never} Never.
 */
export function timelineLayerCorners(frame: TimelineLayerFrame, base: TimelineLayerBox, transform: TimelineLayerTransform): TimelineLayerPoint[] {
  const offset = timelineLayerOffsetPixels(frame, transform);
  const cx = base.left + base.width / 2 + offset.x;
  const cy = base.top + base.height / 2 + offset.y;
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

/**
 * Round to a step given as a power of ten.
 * @param value - The value.
 * @param step - The step, such as 0.01.
 * @returns The rounded value.
 * @throws {never} Never.
 */
function roundTo(value: number, step: number): number {
  const factor = Math.round(1 / step);
  return Math.round(value * factor) / factor;
}

/**
 * A frame offset rounded to the step senders send.
 * @param value - The offset as a fraction of the frame.
 * @returns The rounded offset.
 * @throws {never} Never.
 */
export function roundTimelineFrameOffset(value: number): number {
  return roundTo(value, TIMELINE_LAYER_TRANSFORM_LIMITS.precision.offset);
}

/**
 * An angle in degrees as the one value sent for it: above -180 and at most 180 (#1410 design §3.1).
 * @param degrees - Any angle.
 * @returns The normalised angle.
 * @throws {never} Never.
 */
function normalizeTimelineRotation(degrees: number): number {
  const turned = ((degrees % 360) + 360) % 360;
  return turned > 180 ? turned - 360 : turned;
}

/**
 * A scale within the accepted range.
 * @param value - Any scale.
 * @returns The clamped scale.
 * @throws {never} Never.
 */
export function clampTimelineScale(value: number): number {
  return Math.min(TIMELINE_LAYER_TRANSFORM_LIMITS.scale.max, Math.max(TIMELINE_LAYER_TRANSFORM_LIMITS.scale.min, value));
}

/**
 * What a sender sends for a transform: scale clamped, rotation normalised, every part rounded (#1410 design §3.1).
 * @param transform - The value from a gesture or a field.
 * @returns The value to send.
 * @throws {never} Never.
 */
export function normalizeTimelineLayerTransform(transform: TimelineLayerTransform): TimelineLayerTransform {
  return {
    frameX: roundTimelineFrameOffset(transform.frameX),
    frameY: roundTimelineFrameOffset(transform.frameY),
    scaleX: roundTo(clampTimelineScale(transform.scaleX), TIMELINE_LAYER_TRANSFORM_LIMITS.precision.scale),
    scaleY: roundTo(clampTimelineScale(transform.scaleY), TIMELINE_LAYER_TRANSFORM_LIMITS.precision.scale),
    rotation: roundTo(normalizeTimelineRotation(transform.rotation), TIMELINE_LAYER_TRANSFORM_LIMITS.precision.rotation),
  };
}

/**
 * Whether two transforms are the same placement.
 * @param a - One transform.
 * @param b - The other.
 * @returns Whether every part is equal.
 * @throws {never} Never.
 */
export function sameTimelineLayerTransform(a: TimelineLayerTransform, b: TimelineLayerTransform): boolean {
  return a.frameX === b.frameX && a.frameY === b.frameY && a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.rotation === b.rotation;
}

/**
 * Whether a point lies inside a placed layer, given its corners in order around the box.
 * @param corners - The four corners from `timelineLayerCorners`.
 * @param point - The point, in the same pixels.
 * @returns Whether it is inside or on an edge.
 * @throws {never} Never.
 */
export function timelineLayerContains(corners: readonly TimelineLayerPoint[], point: TimelineLayerPoint): boolean {
  let sign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const a = corners[index]!;
    const b = corners[(index + 1) % corners.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    if (sign === 0) sign = Math.sign(cross);
    else if (Math.sign(cross) !== sign) return false;
  }
  return true;
}
