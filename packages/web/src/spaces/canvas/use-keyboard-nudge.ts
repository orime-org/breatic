// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStoreApi, type InternalNode, type ReactFlowState } from '@xyflow/react';
import { calculateNodePosition, isInputDOMNode, snapPosition } from '@xyflow/system';
import * as React from 'react';

import type { CanvasUndoStep } from '@web/data/yjs/canvas-space';
import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';

/** Where each arrow key moves the selection, as xyflow's `arrowKeyDiffs`. */
const ARROW_DIFFS: Readonly<Record<string, { x: number; y: number }>> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** The listener the canvas wrapper takes. */
export interface KeyboardNudgeHandlers {
  /** Ends a held run: anything the pointer does comes between its presses. */
  onPointerDownCapture: () => void;
}

/** What the nudge needs from the canvas. */
export interface KeyboardNudgeOptions {
  /** The canvas container, which holds the keyboard after a click on empty canvas. */
  container: React.RefObject<HTMLElement | null>;
  /**
   * Whether this client is dragging or resizing; that gesture's release writes.
   * @returns True while a gesture is held.
   */
  gestureRunning: () => boolean;
  /**
   * Plans and writes a move, the same as a drag release.
   * @param moved - The ids xyflow moved.
   * @param joinStep - The undo step a held run is writing into, if any.
   * @returns The undo step the move landed in.
   */
  commit: (
    moved: ReadonlyArray<string>,
    joinStep: CanvasUndoStep | undefined,
  ) => CanvasUndoStep | undefined;
}

/** A nudge made here that the next render will write. */
interface PendingNudge {
  moved: ReadonlyArray<string>;
  repeat: boolean;
}

/**
 * Whether a node rides along with an ancestor that is itself selected.
 *
 * The same test xyflow's drag uses to leave such a node out (`isParentSelected`
 * in `@xyflow/system`), so a nudge hands the planner the set a drag would.
 * @param node - The node to test.
 * @param lookup - xyflow's node lookup.
 * @returns True when some ancestor Group is selected.
 */
function carriedBySelectedAncestor(
  node: InternalNode,
  lookup: ReadonlyMap<string, InternalNode>,
): boolean {
  let parentId = node.parentId;
  while (parentId !== undefined) {
    const parent = lookup.get(parentId);
    if (parent === undefined) return false;
    if (parent.selected === true) return true;
    parentId = parent.parentId;
  }
  return false;
}

/**
 * Whether an arrow key belongs to the canvas selection.
 *
 * The page (nothing focused), the canvas container (a click on empty canvas)
 * and the node or selection box xyflow focuses are where the selection takes
 * arrow keys; a field, a slider, a menu or any other control keeps them, and
 * so does another region holding the keyboard.
 * @param event - The key event.
 * @param container - The canvas container.
 * @returns True when the arrow should move the selection.
 */
function arrowMovesSelection(event: KeyboardEvent, container: HTMLElement | null): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (!regionOwnsKeyboard(target, 'space') || isInputDOMNode(event)) return false;
  return (
    target === document.body ||
    target === container ||
    target.matches('.react-flow__node, .react-flow__nodesselection-rect')
  );
}

/**
 * Moves the selected draggable nodes one step, the way xyflow's own arrow keys
 * do (`useMoveSelectedNodes`): 5px, or a grid step with snapping on.
 * @param state - xyflow's store state.
 * @param direction - The arrow's direction.
 * @param direction.x - Its horizontal step, -1, 0 or 1.
 * @param direction.y - Its vertical step, -1, 0 or 1.
 * @param factor - 4 with Shift held, else 1.
 */
function moveSelectedNodes(
  state: ReactFlowState,
  direction: { x: number; y: number },
  factor: number,
): void {
  const { nodeExtent, snapToGrid, snapGrid, nodesDraggable, onError, updateNodePositions, nodeLookup, nodeOrigin } = state;
  const xDiff = direction.x * (snapToGrid ? snapGrid[0] : 5) * factor;
  const yDiff = direction.y * (snapToGrid ? snapGrid[1] : 5) * factor;
  const updates = new Map<string, InternalNode>();
  for (const [id, node] of nodeLookup) {
    const draggable = node.draggable ?? nodesDraggable;
    if (node.selected !== true || !draggable) continue;
    let next = { x: node.internals.positionAbsolute.x + xDiff, y: node.internals.positionAbsolute.y + yDiff };
    if (snapToGrid) next = snapPosition(next, snapGrid);
    const { position, positionAbsolute } = calculateNodePosition({
      nodeId: id,
      nextPosition: next,
      nodeLookup,
      nodeExtent,
      nodeOrigin,
      onError,
    });
    // xyflow updates its lookup entries in place the same way.
    node.position = position;
    node.internals.positionAbsolute = positionAbsolute;
    updates.set(id, node);
  }
  updateNodePositions(updates);
}

/**
 * Moves the canvas selection with the arrow keys and writes the move into the
 * document (inner#1010, inner#1349 A12).
 *
 * The keys are taken on the document, so the selection moves whether the
 * keyboard sits on a node or on the page, the way an editor moves its
 * selection rather than one focused element. Positions are compared across the
 * move, so a read-only or locked node, which does not move, writes nothing.
 * The write waits for the render that follows: a nudged Group's unselected
 * members only get their new absolute positions when ReactFlow's
 * `StoreUpdater` effect re-adopts the nodes, and that child effect runs before
 * this component's own.
 * @param options - The gesture probe and the writer.
 * @returns The listener to put on the ReactFlow wrapper.
 */
export function useKeyboardNudge(
  options: KeyboardNudgeOptions,
): KeyboardNudgeHandlers {
  const { container, gestureRunning, commit } = options;
  const store = useStoreApi();
  const pending = React.useRef<PendingNudge | null>(null);
  // The undo step the current held run writes into. A fresh press or a
  // pointer press ends the run, so a repeat after either starts its own step.
  const runStep = React.useRef<CanvasUndoStep | undefined>(undefined);

  React.useEffect(() => {
    /**
     * Document keydown, capture phase: moves the selection for an arrow key
     * that belongs to it, ahead of xyflow's own handler on the focused node.
     * @param event - The key event.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = ARROW_DIFFS[event.key];
      if (direction === undefined || !arrowMovesSelection(event, container.current)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) runStep.current = undefined;
      if (gestureRunning()) return;
      const state = store.getState();
      const before = new Map<string, { x: number; y: number }>();
      for (const [id, node] of state.nodeLookup) {
        if (node.selected === true) before.set(id, { ...node.internals.positionAbsolute });
      }
      moveSelectedNodes(state, direction, event.shiftKey ? 4 : 1);
      const lookup = store.getState().nodeLookup;
      const moved: string[] = [];
      for (const [id, was] of before) {
        const node = lookup.get(id);
        if (node === undefined) continue;
        const now = node.internals.positionAbsolute;
        if (now.x === was.x && now.y === was.y) continue;
        if (carriedBySelectedAncestor(node, lookup)) continue;
        moved.push(id);
      }
      if (moved.length > 0) pending.current = { moved, repeat: event.repeat };
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [store, container, gestureRunning]);

  const onPointerDownCapture = React.useCallback((): void => {
    runStep.current = undefined;
  }, []);

  // No dependencies: a nudge is only recorded in the same event that moved
  // nodes, so the commit right after it is the one that rendered the move.
  React.useEffect(() => {
    const nudge = pending.current;
    if (nudge === null) return;
    pending.current = null;
    runStep.current = commit(
      nudge.moved,
      nudge.repeat ? runStep.current : undefined,
    );
  });

  return React.useMemo(() => ({ onPointerDownCapture }), [onPointerDownCapture]);
}
