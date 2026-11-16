// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The preview frame's display size and its display pixels per canvas pixel. */
export interface TimelinePreviewFit { factor: number; width: number; height: number }

/** The preview frame's border on each side, in display pixels. */
const BORDER = 1;

/**
 * The preview frame contained in the area it is placed in (#1502): the frame keeps its ratio inside the area's 1px
 * border, and layers and their handles are drawn with the same factor.
 * @param area - The measured area, its border included.
 * @param area.width - Area width in display pixels.
 * @param area.height - Area height in display pixels.
 * @param frame - The document frame size in canvas pixels.
 * @param frame.width - Frame width.
 * @param frame.height - Frame height.
 * @returns The size inside the border and the factor; all zero when there is no room or no frame.
 * @throws {never} Never.
 */
export function timelinePreviewFit(area: { width: number; height: number }, frame: { width: number; height: number }): TimelinePreviewFit {
  const innerWidth = area.width - 2 * BORDER;
  const innerHeight = area.height - 2 * BORDER;
  if (innerWidth <= 0 || innerHeight <= 0 || frame.width <= 0 || frame.height <= 0) return { factor: 0, width: 0, height: 0 };
  const factor = Math.min(innerWidth / frame.width, innerHeight / frame.height);
  return { factor, width: frame.width * factor, height: frame.height * factor };
}
