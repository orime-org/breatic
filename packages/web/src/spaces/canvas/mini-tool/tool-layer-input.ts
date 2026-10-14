// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool layer drawn on a node keeps from the canvas while its tool is
 * open (inner#1303 §6.6). The layer sits inside the ReactFlow node, so the
 * node's own handlers see everything pressed on it: a Shift press starts the
 * canvas marquee (xyflow skips only `.nokey` targets), a Cmd/Ctrl click
 * unselects the host (and so closes the panel), and arrows and Cmd/Ctrl+C, V,
 * X, D act on the host node.
 */

import * as React from 'react';

import { regionOwnsKeyboard } from '@web/features/active-region/keyboard-scope';

/** The classes a tool layer's root carries: no node drag, no canvas pan, no Shift marquee. */
export const TOOL_LAYER_CLASS = 'nodrag nopan nokey';

/** The node keys a tool layer keeps while its tool is open. */
const NODE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/**
 * Where xyflow moves nodes by the arrows: a node, or the box around several,
 * each from the keys pressed in it (`@xyflow/react@12.11.2` index.mjs:2091, 2309).
 */
const MOVED_BY_ARROWS = '.react-flow__node, .react-flow__nodesselection';
/** The node shortcuts, pressed with Cmd or Ctrl, a tool layer keeps. */
const NODE_SHORTCUTS = new Set(['c', 'v', 'x', 'd']);

/**
 * Keep a click on a tool layer from the node it sits in.
 * @param event - The click.
 */
export function stopNodeClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

/**
 * Whether a key goes to a text box, which keeps its own keys.
 * @param target - What the key was pressed on.
 * @returns True for a text input, a text area or editable content.
 */
function typesText(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Keep the node's keys while a tool is open on it: they would move, copy or
 * duplicate the host instead of acting in the tool. Text boxes keep theirs,
 * and so does every control outside the nodes for its arrows (a panel's
 * slider, the focus crop's timeline), which xyflow does not move nodes by.
 * @param active - Whether the tool is open on this node.
 */
export function useToolLayerKeys(active: boolean): void {
  React.useEffect(() => {
    if (!active) return undefined;
    /**
     * Take a node key meant for this space.
     * @param event - The key.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (typesText(event.target) || !regionOwnsKeyboard(event.target, 'space')) return;
      const shortcut = (event.metaKey || event.ctrlKey) && NODE_SHORTCUTS.has(event.key.toLowerCase());
      const moves =
        NODE_KEYS.has(event.key) && event.target instanceof Element && event.target.closest(MOVED_BY_ARROWS) !== null;
      if (!shortcut && !moves) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
