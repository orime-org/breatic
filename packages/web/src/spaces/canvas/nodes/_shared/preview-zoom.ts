// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a canvas node stops showing its preview (inner#1320).
 *
 * A preview is at most 576 pixels wide, narrower for a narrow or very tall
 * picture. Once a node covers more device pixels than its preview has, the
 * preview is being stretched and two pictures can no longer be told apart by
 * their quality, so the node shows its original instead.
 */

import * as React from 'react';
import { PREVIEW_WIDTH, previewWidthFor } from '@breatic/shared';

/**
 * Whether a node of this width covers more device pixels than its preview has.
 * @param nodeWidth - The node's width in canvas (CSS) pixels.
 * @param zoom - The canvas zoom.
 * @param devicePixelRatio - Device pixels per CSS pixel.
 * @param previewWidth - How wide this picture's preview is.
 * @returns True when the original should be shown.
 */
export function zoomedPastPreview(
  nodeWidth: number,
  zoom: number,
  devicePixelRatio: number,
  previewWidth: number,
): boolean {
  return nodeWidth * zoom * devicePixelRatio > previewWidth;
}

/**
 * How wide a node's preview is, from the picture size it carries; the full
 * preview width when it carries none. A video's preview is cut from a cover
 * fitted inside 1920, and below 576 wide that cover's width is its preview's,
 * so the video's own size gives the same answer wherever the two can differ in
 * what the reader sees.
 * @param size - The picture's size, when the node carries one.
 * @param size.width - The picture's width.
 * @param size.height - The picture's height.
 * @returns The preview's width in pixels.
 */
export function nodePreviewWidth(size: { width?: unknown; height?: unknown }): number {
  return typeof size.width === 'number' && typeof size.height === 'number'
    ? previewWidthFor(size.width, size.height)
    : PREVIEW_WIDTH;
}

/**
 * The canvas's answer for one node, provided by the ReactFlow node wrapper —
 * the layer that reads the zoom. False outside the canvas.
 */
export const NodeZoomedPastPreviewContext: React.Context<boolean> =
  React.createContext(false);

/**
 * Whether this node should show its original. Once true it stays true for that
 * image while the node is mounted: its original is already in the browser, and
 * switching back to the preview would gain nothing. A new image in the node is
 * judged afresh, since nothing of it has loaded.
 * @param image - The address of the image the node shows.
 * @returns True once the canvas has zoomed this image past its preview.
 */
export function useZoomedPastPreview(image: string | undefined): boolean {
  const past = React.useContext(NodeZoomedPastPreviewContext);
  const [seenFor, setSeenFor] = React.useState(past ? image : undefined);
  if (past && seenFor !== image) setSeenFor(image);
  return past || (seenFor !== undefined && seenFor === image);
}
