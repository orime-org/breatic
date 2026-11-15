// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Writing one node onto a canvas whether or not its tab is open (#1411 design 5.3, #1490 design §9.1): acquire the
 * canvas document, wait for its first sync, write the node beside what is already at the origin, then hand the caller
 * the receipt wait and let the document go once the caller's follow-up ends. The canvas counts as busy for the leave
 * guard until the caller settles it or the follow-up ends.
 */

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { CanvasNodeFields } from '@breatic/shared';
import { acquireDocProvider, hasDocUnsyncedEdits, readDocFacts, releaseDocProvider, subscribeProjectSync } from '@web/data/yjs/collab-socket';
import { addNode, readNodePlacements, runCanvasUndoBatch } from '@web/data/yjs/canvas-space';
import { docName, getDoc } from '@web/data/yjs/manager';
import { stepPastOccupied } from '@web/spaces/canvas/node-clipboard';
import { useSpaceOperationsStore } from '@web/stores/space-operations';

/** Where a node goes. */
export interface PlaceNodeRequest {
  projectId: string;
  /** The canvas Space. */
  spaceId: string;
  /** Where on the canvas to start looking for a free spot. */
  origin: { x: number; y: number };
  /** How long the canvas may take to sync before nothing is written. */
  syncTimeoutMs: number;
  /** A name for this placement in the leave guard. */
  operation: string;
  /**
   * The node to write at the free spot.
   * @returns The node.
   */
  build: (position: { x: number; y: number }) => CanvasNodeFields;
}

/**
 * How the write went: `placed` once the node is written; `unreachable` when the canvas never synced and nothing was
 * written; `refused` when the size gate refused the add.
 */
export type PlaceNodeOutcome =
  | { status: 'placed'; nodeId: string }
  | { status: 'unreachable' }
  | { status: 'refused' };

/** What the caller's follow-up is handed once the node is written. */
export interface PlacedNode {
  nodeId: string;
  /**
   * Wait until collab confirmed every write to the document, or it is gone.
   * @returns Confirmed or gone.
   */
  receipt: () => Promise<'confirmed' | 'gone'>;
  /** End this placement's hold on the leave guard early. */
  settleBusy: () => void;
}

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
 * Write one node onto a canvas and run the caller's follow-up in the background.
 * @param request - The node and where it goes.
 * @param followUp - What runs once the node is written; the document is let go when it ends.
 * @returns How the write went.
 * @throws {Error} When writing the node throws; the document and the leave guard are let go first.
 */
export async function placeNodeOnCanvas(request: PlaceNodeRequest, followUp: (placed: PlacedNode) => Promise<void>): Promise<PlaceNodeOutcome> {
  const { projectId, spaceId, origin, syncTimeoutMs, operation } = request;
  const name = docName.canvasSpace(projectId, spaceId);
  const doc = getDoc(name);
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
    const node = request.build({ x: origin.x + shift.dx, y: origin.y + shift.dy });
    const written = runCanvasUndoBatch(projectId, spaceId, { kind: 'add' }, () => { addNode(projectId, spaceId, node); });
    if (!written.ok) { finish(); return { status: 'refused' }; }
    nodeId = node.id;
  } catch (err) {
    finish();
    throw err;
  }
  void followUp({ nodeId, receipt: () => waitForReceipt(projectId, name, doc), settleBusy }).catch(() => {}).finally(finish);
  return { status: 'placed', nodeId };
}
