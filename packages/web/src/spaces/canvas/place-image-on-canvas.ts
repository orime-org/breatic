// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { HocuspocusProvider } from '@hocuspocus/provider';
import { acquireDocProvider, hasDocUnsyncedEdits, readDocFacts, releaseDocProvider, subscribeProjectSync } from '@web/data/yjs/collab-socket';
import { addNode, readNodePlacements, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { stepPastOccupied } from '@web/spaces/canvas/node-clipboard';
import { createEmptyNode } from '@web/spaces/canvas/node-factory';
import { uploadIntoNode } from '@web/spaces/canvas/upload-into-node';
import { useSpaceOperationsStore } from '@web/stores/space-operations';
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
 * How the hand-over went: `placed` once the node is written, its upload going
 * on in the background; `unreachable` when the canvas never synced and nothing
 * was written; `refused` when the size gate refused the add (the canvas is
 * full or is being rebuilt; the gate warns except while rebuilding).
 */
export type PlaceImageOutcome =
  | { status: 'placed'; nodeId: string }
  | { status: 'unreachable' }
  | { status: 'refused' };

/**
 * Wait for the provider's first sync.
 * @param name - The document.
 * @param provider - Its provider.
 * @param timeoutMs - How long to wait.
 * @returns Whether it synced in time.
 */
function waitForSync(name: string, provider: HocuspocusProvider, timeoutMs: number): Promise<boolean> {
  if (readDocFacts(name).hasEverSynced) return Promise.resolve(true);
  return new Promise((resolve) => {
    /**
     * Settle once, whichever comes first.
     * @param synced - Whether the sync arrived.
     */
    const done = (synced: boolean): void => { clearTimeout(timer); provider.off('synced', onSynced); resolve(synced); };
    /**
     * The handshake finished.
     * @returns Nothing.
     */
    const onSynced = (): void => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    provider.on('synced', onSynced);
  });
}

/**
 * Wait until collab confirmed every write to this document, or it is gone.
 * Like an open canvas, it waits as long as it takes; the leave guard holds meanwhile.
 * @param projectId - The project.
 * @param name - The document.
 * @param doc - The document this caller acquired.
 * @returns Confirmed or gone.
 */
function waitForReceipt(projectId: string, name: string, doc: ReturnType<typeof getDoc>): Promise<'confirmed' | 'gone'> {
  return new Promise((resolve) => {
    /**
     * Re-read on every change of the project's sync state.
     * @returns Whether it settled.
     */
    const check = (): boolean => {
      const state = hasDocUnsyncedEdits(name, doc);
      if (state === 'pending') return false;
      unsubscribe();
      resolve(state);
      return true;
    };
    const unsubscribe = subscribeProjectSync(projectId, () => { check(); });
    check();
  });
}

/**
 * Place an image on a canvas whether or not its tab is open (#1411 design
 * 5.3): connect, wait for the sync and write an empty image node of the
 * image's size beside what is already at the origin, with the upload mark the
 * canvas shows while a file is on its way. That hands the image over to the
 * canvas, and the answer comes then. In the background it waits for collab to
 * confirm the node and uploads into it the way a picked file is; the document
 * is held until the bytes are on their way, and the canvas counts as busy for
 * the leave guard until the upload's own send took over.
 * @param request - The image and where it goes.
 * @returns How the hand-over went.
 * @throws {Error} When writing the node throws; the document and the leave guard are let go first.
 */
export async function placeImageOnCanvas(request: PlaceImageRequest): Promise<PlaceImageOutcome> {
  const { projectId, spaceId, file, size, userId, origin, syncTimeoutMs } = request;
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
  const operation = `place-image:${file.name}:${origin.x}:${origin.y}`;
  const ops = useSpaceOperationsStore.getState();
  ops.register(spaceId, operation);
  let busy = true;
  /** End this placement's own hold on the leave guard, once. */
  const settleBusy = (): void => { if (busy) { busy = false; ops.unregister(spaceId, operation); } };
  /** Let go of the document and the leave guard. */
  const finish = (): void => { settleBusy(); releaseDocProvider(name, doc); };
  const provider = acquireDocProvider(name, doc);
  let nodeId: string;
  try {
    if (!(await waitForSync(name, provider, syncTimeoutMs))) { finish(); return { status: 'unreachable' }; }
    const shift = stepPastOccupied([origin], readNodePlacements(projectId, spaceId));
    const built = createEmptyNode('image', { x: origin.x + shift.dx, y: origin.y + shift.dy }, userId);
    const node = { ...built, data: { ...built.data, mediaWidth: size.width, mediaHeight: size.height } };
    const written = runCanvasUndoBatch(projectId, spaceId, { kind: 'add' }, () => { addNode(projectId, spaceId, node); });
    if (!written.ok) { finish(); return { status: 'refused' }; }
    nodeId = node.id;
  } catch (err) {
    finish();
    throw err;
  }
  const marks = useUploadMarksStore.getState();
  const markOp = marks.begin(spaceId, nodeId, 'upload');
  void (async (): Promise<void> => {
    try {
      // A rebuilt document may still hold the node collab already took, so it says why it stayed empty.
      if ((await waitForReceipt(projectId, name, doc)) === 'gone') { marks.fail(spaceId, nodeId, markOp, { key: 'spaces.sizeCap.reason' }); return; }
      // The upload registers its own send from here (`uploadIntoNode`).
      const sent = uploadIntoNode({ projectId, spaceId, nodeId }, file, { continuing: markOp });
      settleBusy();
      await sent;
    } catch {
      marks.fail(spaceId, nodeId, markOp, { key: 'canvas.upload.failed', params: { filename: file.name } });
    } finally {
      finish();
    }
  })();
  return { status: 'placed', nodeId };
}
