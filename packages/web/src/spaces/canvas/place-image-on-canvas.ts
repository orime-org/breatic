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
 * How placing ended: `uploaded`; `unreachable` when the canvas never synced and
 * nothing was written; `refused` when the size gate refused the add (the
 * canvas is full or is being rebuilt; the gate warns except while rebuilding); `lost` when the document was rebuilt or torn down before collab
 * confirmed the node, so nothing was uploaded; `upload_failed` when the node
 * is there but its upload did not finish, `toasted` saying whether the user
 * was already told.
 */
export type PlaceImageOutcome =
  | { status: 'uploaded'; nodeId: string }
  | { status: 'unreachable' }
  | { status: 'refused' }
  | { status: 'lost' }
  | { status: 'upload_failed'; nodeId: string; toasted: boolean };

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
 * 5.3): connect, wait for the sync, write an empty image node of the image's
 * size beside what is already at the origin, wait for collab to confirm it,
 * then upload into it the way a picked file is. The document is held until the
 * upload ended, so its lock and size reads never meet a released document;
 * the canvas counts as busy for the leave guard until the receipt arrived and
 * the upload's own send took over.
 * @param request - The image and where it goes.
 * @returns How it ended.
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
  const provider = acquireDocProvider(name, doc);
  try {
    if (!(await waitForSync(name, provider, syncTimeoutMs))) return { status: 'unreachable' };
    const occupied = readNodePlacements(projectId, spaceId);
    const shift = stepPastOccupied([origin], occupied);
    const built = createEmptyNode('image', { x: origin.x + shift.dx, y: origin.y + shift.dy }, userId);
    const node = { ...built, data: { ...built.data, mediaWidth: size.width, mediaHeight: size.height } };
    const written = runCanvasUndoBatch(projectId, spaceId, { kind: 'add' }, () => { addNode(projectId, spaceId, node); });
    if (!written.ok) return { status: 'refused' };
    if ((await waitForReceipt(projectId, name, doc)) === 'gone') return { status: 'lost' };
    // The upload registers its own send from here (`uploadIntoNode`).
    const sent = uploadIntoNode({ projectId, spaceId, nodeId: node.id }, file);
    settleBusy();
    const outcome = await sent;
    return outcome.status === 'uploaded'
      ? { status: 'uploaded', nodeId: node.id }
      : { status: 'upload_failed', nodeId: node.id, toasted: outcome.toasted };
  } finally {
    settleBusy();
    releaseDocProvider(name, doc);
  }
}
