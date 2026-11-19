// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** An expansion frame as shares of the source: the source is the rectangle from 0,0 to 1,1 and the frame contains it. */
export interface ExpandFrameShares { x: number; y: number; width: number; height: number }

/** A pixel size. */
export interface ExpandPixelSize { width: number; height: number }

/** The padded canvas's size and where the source's top left sits on it, in source pixels. */
export interface ExpandLayout { width: number; height: number; sourceX: number; sourceY: number }

/** A video expansion's layout: even sides, and whether the long side passes the configured maximum. */
export interface VideoExpandLayout extends ExpandLayout { overSide: boolean }

/**
 * Lay the source on the frame's canvas in whole pixels, never cutting into it (inner#1303 §6.3).
 * @param frame - The frame, as shares of the source.
 * @param source - The source's pixels.
 * @returns The canvas size and the source's offset on it.
 * @throws {never} Never.
 */
export function expandLayout(frame: ExpandFrameShares, source: ExpandPixelSize): ExpandLayout {
  // `|| 0` keeps an unpadded side at 0 rather than -0.
  const sourceX = Math.round(-frame.x * source.width) || 0;
  const sourceY = Math.round(-frame.y * source.height) || 0;
  return {
    width: Math.max(sourceX + source.width, Math.round(frame.width * source.width)),
    height: Math.max(sourceY + source.height, Math.round(frame.height * source.height)),
    sourceX,
    sourceY,
  };
}

/**
 * Whether the frame pads the source by at least one pixel on some side, read from the same whole-pixel layout.
 * @param frame - The frame.
 * @param source - The source's pixels.
 * @returns True when the expansion would be larger than the source.
 * @throws {never} Never.
 */
export function isExpanded(frame: ExpandFrameShares, source: ExpandPixelSize): boolean {
  const layout = expandLayout(frame, source);
  return layout.width > source.width || layout.height > source.height;
}

/**
 * A video expansion's target (execution design §10.5): the image layout with each side rounded up to even, as H.264 needs;
 * a long side over `maxSide` is reported, never clamped.
 * @param frame - The frame, as shares of the source.
 * @param source - The source's pixels.
 * @param maxSide - The configured longest side.
 * @returns The layout.
 * @throws {never} Never.
 */
export function videoExpandLayout(frame: ExpandFrameShares, source: ExpandPixelSize, maxSide: number): VideoExpandLayout {
  const layout = expandLayout(frame, source);
  const width = layout.width + (layout.width % 2);
  const height = layout.height + (layout.height % 2);
  return { ...layout, width, height, overSide: Math.max(width, height) > maxSide };
}
