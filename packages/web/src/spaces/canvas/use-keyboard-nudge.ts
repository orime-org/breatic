// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStoreApi, type InternalNode } from '@xyflow/react';
import * as React from 'react';

import type { CanvasUndoStep } from '@web/data/yjs/canvas-space';

/** The keys xyflow nudges selected nodes with (`arrowKeyDiffs`). */
const ARROW_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** The listeners the canvas wrapper takes. */
export interface KeyboardNudgeHandlers {
  /** Records where the selected nodes are before xyflow handles the key. */
  onKeyDownCapture: (event: React.KeyboardEvent) => void;
  /** Notes which of them xyflow moved, for the write after the next render. */
  onKeyDown: (event: React.KeyboardEvent) => void;
  /** Ends a held run: anything the pointer does comes between its presses. */
  onPointerDownCapture: () => void;
}

/** What the nudge needs from the canvas. */
export interface KeyboardNudgeOptions {
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

/** A nudge xyflow made that the next render will write. */
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
 * Writes xyflow's arrow-key nudges into the document.
 *
 * xyflow moves the nodes itself (on the focused node or the selection rect)
 * between the wrapper's capture and bubble phases, so comparing positions
 * across the two names exactly the nodes it moved; a read-only or locked node
 * is one xyflow does not move. The write waits for the render that follows: a
 * nudged Group's unselected members only get their new absolute positions when
 * ReactFlow's `StoreUpdater` effect re-adopts the nodes, and that child effect
 * runs before this component's own.
 * @param options - The gesture probe and the writer.
 * @returns The listeners to put on the ReactFlow wrapper.
 */
export function useKeyboardNudge(
  options: KeyboardNudgeOptions,
): KeyboardNudgeHandlers {
  const { gestureRunning, commit } = options;
  const store = useStoreApi();
  const before = React.useRef<Map<string, { x: number; y: number }> | null>(
    null,
  );
  const pending = React.useRef<PendingNudge | null>(null);
  // The undo step the current held run writes into. A fresh press or a
  // pointer press ends the run, so a repeat after either starts its own step.
  const runStep = React.useRef<CanvasUndoStep | undefined>(undefined);

  const onKeyDownCapture = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (!ARROW_KEYS.has(event.key)) return;
      const snapshot = new Map<string, { x: number; y: number }>();
      for (const [id, node] of store.getState().nodeLookup) {
        if (node.selected === true) {
          snapshot.set(id, { ...node.internals.positionAbsolute });
        }
      }
      before.current = snapshot;
    },
    [store],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent): void => {
      const snapshot = before.current;
      before.current = null;
      if (snapshot === null || !ARROW_KEYS.has(event.key)) return;
      if (!event.repeat) runStep.current = undefined;
      if (gestureRunning()) return;
      const lookup = store.getState().nodeLookup;
      const moved: string[] = [];
      for (const [id, was] of snapshot) {
        const node = lookup.get(id);
        if (node === undefined) continue;
        const now = node.internals.positionAbsolute;
        if (now.x === was.x && now.y === was.y) continue;
        if (carriedBySelectedAncestor(node, lookup)) continue;
        moved.push(id);
      }
      if (moved.length > 0) pending.current = { moved, repeat: event.repeat };
    },
    [store, gestureRunning],
  );

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

  return React.useMemo(
    () => ({ onKeyDownCapture, onKeyDown, onPointerDownCapture }),
    [onKeyDownCapture, onKeyDown, onPointerDownCapture],
  );
}
