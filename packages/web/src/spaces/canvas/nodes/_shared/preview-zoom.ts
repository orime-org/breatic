// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a canvas node stops showing its preview (inner#1320).
 *
 * A preview is 576 pixels wide. Once a node covers more device pixels than
 * that, the preview is being stretched and two pictures can no longer be told
 * apart by their quality, so the node shows its original instead.
 */

import * as React from 'react';
import { PREVIEW_WIDTH } from '@breatic/shared';

/**
 * Whether a node of this width covers more device pixels than its preview has.
 * @param nodeWidth - The node's width in canvas (CSS) pixels.
 * @param zoom - The canvas zoom.
 * @param devicePixelRatio - Device pixels per CSS pixel.
 * @returns True when the original should be shown.
 */
export function zoomedPastPreview(
  nodeWidth: number,
  zoom: number,
  devicePixelRatio: number,
): boolean {
  return nodeWidth * zoom * devicePixelRatio > PREVIEW_WIDTH;
}

/**
 * The canvas's answer for one node, provided by the ReactFlow node wrapper —
 * the layer that reads the zoom. False outside the canvas.
 */
export const NodeZoomedPastPreviewContext: React.Context<boolean> =
  React.createContext(false);

/**
 * Whether this node should show its original. Once true it stays true while
 * the node is mounted: the original is already in the browser, and switching
 * back to the preview would gain nothing.
 * @returns True once the canvas has zoomed this node past its preview.
 */
export function useZoomedPastPreview(): boolean {
  const past = React.useContext(NodeZoomedPastPreviewContext);
  const [seen, setSeen] = React.useState(past);
  if (past && !seen) setSeen(true);
  return past || seen;
}
