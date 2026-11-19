// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { createEmptyNode } from '@web/spaces/canvas/node-factory';
import { placeNodeOnCanvas, type PlaceNodeOutcome } from '@web/spaces/canvas/place-on-canvas';
import { uploadIntoNode } from '@web/spaces/canvas/upload-into-node';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/** One captured image to place on a canvas. */
export interface PlaceImageRequest {
  projectId: string;
  /** The canvas Space. */
  spaceId: string;
  file: File;
  /** The image's size, held by the empty node until its content lands. */
  size: { width: number; height: number };
  userId: string;
  /** Where on the canvas to start looking for a free spot. */
  origin: { x: number; y: number };
  /** How long the canvas may take to sync before nothing is written. */
  syncTimeoutMs: number;
}

/**
 * Place an image on a canvas whether or not its tab is open (#1411 design
 * 5.3): write an empty image node of the image's size beside what is already
 * at the origin, with the upload mark the canvas shows while a file is on its
 * way. That hands the image over to the canvas, and the answer comes then. In
 * the background it waits for collab to confirm the node and uploads into it
 * the way a picked file is; the document is held until the bytes are on their
 * way, and the canvas counts as busy for the leave guard until the upload's
 * own send took over.
 * @param request - The image and where it goes.
 * @returns How the hand-over went: `placed` with the upload going on in the background, `unreachable` when nothing
 * was written, `refused` when the size gate refused the add (it warns except while the canvas is rebuilt).
 * @throws {Error} When writing the node throws; the document and the leave guard are let go first.
 */
export function placeImageOnCanvas(request: PlaceImageRequest): Promise<PlaceNodeOutcome> {
  const { projectId, spaceId, file, size, userId, origin, syncTimeoutMs } = request;
  return placeNodeOnCanvas({
    projectId, spaceId, origin, syncTimeoutMs,
    operation: `place-image:${file.name}:${origin.x}:${origin.y}`,
    build: (position) => {
      const built = createEmptyNode('image', position, userId);
      return { ...built, data: { ...built.data, mediaWidth: size.width, mediaHeight: size.height } };
    },
  }, async ({ nodeId, receipt, settleBusy }) => {
    const marks = useUploadMarksStore.getState();
    const markOp = marks.begin(spaceId, nodeId, 'upload');
    try {
      // A rebuilt document may still hold the node collab already took, so it says why it stayed empty.
      if ((await receipt()) === 'gone') { marks.fail(spaceId, nodeId, markOp, { key: 'spaces.sizeCap.reason' }); return; }
      // The upload registers its own send from here (`uploadIntoNode`).
      const sent = uploadIntoNode({ projectId, spaceId, nodeId }, file, { continuing: markOp });
      settleBusy();
      await sent;
    } catch {
      marks.fail(spaceId, nodeId, markOp, { key: 'canvas.upload.failed', params: { filename: file.name } });
    }
  });
}
