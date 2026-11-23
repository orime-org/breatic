// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Putting an exported video on a canvas whose tab may be closed (#1490 design §9.1): the video is already a registered
 * asset, so the node is written with it and nothing is uploaded; the document is held until collab's receipt.
 */

import type { CanvasNodeFields } from '@breatic/shared';
import { createEmptyNode } from '@web/spaces/canvas/node-factory';
import { placeNodeOnCanvas, type PlaceNodeOutcome } from '@web/spaces/canvas/place-on-canvas';

/** The video as its node carries it. */
export type PlacedVideo = Required<Pick<CanvasNodeFields['data'], 'content' | 'duration' | 'mediaWidth' | 'mediaHeight' | 'mimeType' | 'size' | 'sourceAnimation'>>
  & Pick<CanvasNodeFields['data'], 'coverUrl'>;

/** One exported video to place. */
export interface PlaceVideoRequest {
  projectId: string;
  /** The canvas Space. */
  spaceId: string;
  video: PlacedVideo;
  userId: string;
  /** Where on the canvas to start looking for a free spot. */
  origin: { x: number; y: number };
  /** How long the canvas may take to sync before nothing is written. */
  syncTimeoutMs: number;
  /** Told once collab confirmed the node, or the document is gone. */
  onReceipt?: () => void;
}

/**
 * Place the video and hold the canvas until collab confirmed the node.
 * @param request - The video and where it goes.
 * @returns How the write went.
 * @throws {Error} When writing the node throws.
 */
export function placeVideoOnCanvas(request: PlaceVideoRequest): Promise<PlaceNodeOutcome> {
  const { projectId, spaceId, video, userId, origin, syncTimeoutMs, onReceipt } = request;
  return placeNodeOnCanvas({
    projectId, spaceId, origin, syncTimeoutMs,
    operation: `place-video:${video.sourceAnimation.executionId}:${origin.x}:${origin.y}`,
    build: (position) => {
      const built = createEmptyNode('video', position, userId);
      return { ...built, data: { ...built.data, ...video } };
    },
  }, async ({ receipt }) => {
    await receipt();
    onReceipt?.();
  });
}
