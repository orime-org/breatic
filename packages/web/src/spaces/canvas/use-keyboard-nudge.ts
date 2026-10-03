// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { useStoreApi, type InternalNode, type Node } from '@xyflow/react';
import * as React from 'react';

/** The keys xyflow nudges selected nodes with (`arrowKeyDiffs`). */
const ARROW_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** The two listeners the canvas wrapper takes, in capture and bubble order. */
export interface KeyboardNudgeHandlers {
  /** Records where the selected nodes are before xyflow handles the key. */
  onKeyDownCapture: (event: React.KeyboardEvent) => void;
  /** Notes which of them xyflow moved, for the write after the next render. */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/** What the nudge needs from the canvas. */
export interface KeyboardNudgeOptions {
  /** The nodes handed to ReactFlow; the write waits for them to change. */
  rendered: ReadonlyArray<Node>;
  /** A read-only canvas writes nothing. */
  readOnly: boolean;
  /**
   * Whether this client is dragging or resizing; that gesture's release writes.
   * @returns True while a gesture is held.
   */
  gestureRunning: () => boolean;
  /**
   * Plans and writes a move, the same as a drag release.
   * @param moved - The ids xyflow moved.
   */
  commit: (moved: ReadonlyArray<string>) => void;
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
 * across the two names exactly the nodes it moved. The write waits for the
 * render that follows: a nudged Group's unselected members only get their new
 * absolute positions when ReactFlow's `StoreUpdater` effect re-adopts the
 * nodes, and that child effect runs before this component's own.
 * @param options - The rendered nodes, read-only flag, gesture probe and writer.
 * @returns The listeners to put on the ReactFlow wrapper.
 */
export function useKeyboardNudge(
  options: KeyboardNudgeOptions,
): KeyboardNudgeHandlers {
  const { rendered, readOnly, gestureRunning, commit } = options;
  const store = useStoreApi();
  const before = React.useRef<Map<string, { x: number; y: number }> | null>(
    null,
  );
  const pending = React.useRef<ReadonlyArray<string> | null>(null);

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
      if (readOnly || gestureRunning()) return;
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
      if (moved.length > 0) pending.current = moved;
    },
    [store, readOnly, gestureRunning],
  );

  React.useEffect(() => {
    const moved = pending.current;
    if (moved === null) return;
    pending.current = null;
    if (readOnly) return;
    commit(moved);
  }, [rendered, readOnly, commit]);

  return React.useMemo(
    () => ({ onKeyDownCapture, onKeyDown }),
    [onKeyDownCapture, onKeyDown],
  );
}
