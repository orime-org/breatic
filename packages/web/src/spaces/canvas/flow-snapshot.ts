// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the reader left on a canvas that ReactFlow forgets when the canvas is
 * hidden: its `StoreUpdater` resets the whole store in an effect cleanup
 * (`@xyflow/react` 12.11.2 `dist/esm/index.mjs:274-280`), which puts the
 * camera back at the origin and drops the selection box. The snapshot is
 * taken before that reset and put back once the canvas is shown.
 */

/** The camera and the selection box of one canvas. */
export interface FlowSnapshot {
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly nodesSelectionActive: boolean;
}

/** The two fields of ReactFlow's store a snapshot reads. */
interface FlowStoreFields {
  readonly transform: readonly [number, number, number];
  readonly nodesSelectionActive: boolean;
}

/** What restoring needs from ReactFlow. */
interface FlowRestoreTarget {
  readonly setViewport: (
    viewport: { x: number; y: number; zoom: number },
    options: { duration: number },
  ) => unknown;
  readonly setState: (partial: { nodesSelectionActive: boolean }) => void;
}

/**
 * Reads the camera and the selection box from ReactFlow's store.
 * @param state - The live store state.
 * @returns The snapshot.
 */
export function snapshotFlow(state: FlowStoreFields): FlowSnapshot {
  const [x, y, zoom] = state.transform;
  return { viewport: { x, y, zoom }, nodesSelectionActive: state.nodesSelectionActive };
}

/**
 * Puts a snapshot back, with no animation.
 * @param target - ReactFlow's viewport setter and store setter.
 * @param snapshot - What to put back.
 */
export function restoreFlow(target: FlowRestoreTarget, snapshot: FlowSnapshot): void {
  target.setViewport({ ...snapshot.viewport }, { duration: 0 });
  target.setState({ nodesSelectionActive: snapshot.nodesSelectionActive });
}
