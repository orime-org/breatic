// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { TIMELINE_LAYER_TRANSFORM_LIMITS, type TimelineLayerPoint, type TimelineLayerTransform } from '@breatic/shared';

const { scale, precision } = TIMELINE_LAYER_TRANSFORM_LIMITS;

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
 * An angle in degrees as the one value sent for it: above -180 and at most 180 (#1410 design §3.1).
 * @param degrees - Any angle.
 * @returns The normalised angle.
 * @throws {never} Never.
 */
export function normalizeTimelineRotation(degrees: number): number {
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
  return Math.min(scale.max, Math.max(scale.min, value));
}

/**
 * What a sender sends for a transform: scale clamped, rotation normalised, every part rounded (#1410 design §3.1).
 * @param transform - The value from a gesture or a field.
 * @returns The value to send.
 * @throws {never} Never.
 */
export function normalizeTimelineLayerTransform(transform: TimelineLayerTransform): TimelineLayerTransform {
  return {
    x: roundTo(transform.x, precision.offset),
    y: roundTo(transform.y, precision.offset),
    scaleX: roundTo(clampTimelineScale(transform.scaleX), precision.scale),
    scaleY: roundTo(clampTimelineScale(transform.scaleY), precision.scale),
    rotation: roundTo(normalizeTimelineRotation(transform.rotation), precision.rotation),
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
  return a.x === b.x && a.y === b.y && a.scaleX === b.scaleX && a.scaleY === b.scaleY && a.rotation === b.rotation;
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
