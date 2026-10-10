// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When a canvas node stops showing its preview (inner#1320).
 *
 * A preview is at most 576 pixels wide, narrower for a narrow or very tall
 * picture. Once a node covers more device pixels than its preview has, the
 * preview is being stretched and two pictures can no longer be told apart by
 * their quality, so the node shows its original instead. The preview's width
 * is the one its loaded image reports (`usePreviewWidth`).
 */

import * as React from 'react';

/**
 * Whether a node of this width covers more device pixels than its preview has.
 * @param nodeWidth - The node's width in canvas (CSS) pixels.
 * @param zoom - The canvas zoom.
 * @param devicePixelRatio - Device pixels per CSS pixel.
 * @param previewWidth - How wide this picture's preview is, null until it has
 *   loaded.
 * @returns True when the original should be shown.
 */
export function zoomedPastPreview(
  nodeWidth: number,
  zoom: number,
  devicePixelRatio: number,
  previewWidth: number | null,
): boolean {
  return previewWidth !== null && nodeWidth * zoom * devicePixelRatio > previewWidth;
}

/**
 * The picture a node shows: a video's cover, any other node's content.
 * @param data - The node's data.
 * @param data.content - What it holds.
 * @param data.coverUrl - A video's cover, when it has one.
 * @returns The picture's address, or nothing.
 */
export function nodePicture(data: { content?: unknown; coverUrl?: unknown }): string | undefined {
  if (typeof data.coverUrl === 'string') return data.coverUrl;
  return typeof data.content === 'string' ? data.content : undefined;
}

/**
 * The canvas's answer for one node, provided by the ReactFlow node wrapper —
 * the layer that reads the zoom. False outside the canvas.
 */
export const NodeZoomedPastPreviewContext: React.Context<boolean> =
  React.createContext(false);

/**
 * Whether a picture should show its original. Once true it stays true for that
 * image while the caller is mounted: its original is already in the browser,
 * and switching back to the preview would gain nothing. A new image is judged
 * afresh, since nothing of it has loaded.
 * @param image - The address of the image shown.
 * @param past - Whether the image is shown past its preview right now.
 * @returns True once the image has been shown past its preview.
 */
export function useLatchedFor(image: string | undefined, past: boolean): boolean {
  const [seenFor, setSeenFor] = React.useState(past ? image : undefined);
  if (past && seenFor !== image) setSeenFor(image);
  return past || (seenFor !== undefined && seenFor === image);
}

/**
 * Whether this node should show its original, kept once true
 * ({@link useLatchedFor}).
 * @param image - The address of the image the node shows.
 * @returns True once the canvas has zoomed this image past its preview.
 */
export function useZoomedPastPreview(image: string | undefined): boolean {
  return useLatchedFor(image, React.useContext(NodeZoomedPastPreviewContext));
}
