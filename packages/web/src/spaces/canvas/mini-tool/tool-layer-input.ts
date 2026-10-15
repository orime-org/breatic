// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a tool layer drawn on a node keeps from the canvas while its tool is
 * open (inner#1303 §6.6). The layer sits inside the ReactFlow node, so the
 * node's own handlers see everything pressed on it: a Shift press starts the
 * canvas marquee (xyflow skips only `.nokey` targets), a Cmd/Ctrl click
 * unselects the host (and so closes the panel), and the arrows move the host.
 * The canvas's copy, paste and duplicate ask `toolLayerOpen` themselves.
 */

import * as React from 'react';

import { gridShapeOf, isModelTool, miniToolById } from '@breatic/shared/mini-tools';

import { isEditableTarget } from '@web/lib/is-editable-target';
import { miniToolOpenOn, type CanvasSessionState } from '@web/stores/canvas-session';

/** The classes a tool layer's root carries: no node drag, no canvas pan, no Shift marquee. */
export const TOOL_LAYER_CLASS = 'nodrag nopan nokey';

const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/**
 * Where xyflow moves nodes by the arrows: a selected node, which carries the
 * `selected` class, or the box around several, each from the keys pressed in
 * it (`@xyflow/react@12.11.2` index.mjs:2091, 2309, 2350).
 */
const MOVED_BY_ARROWS = '.react-flow__node.selected, .react-flow__nodesselection';

/**
 * Whether a tool that draws on its node is open: the focus crop, or the panel
 * of a markup, drawing, expand, grid or crop tool. These are the drafts the
 * node's layers render from.
 * @param s - The canvas session.
 * @returns True while such a layer is on a node.
 */
export function toolLayerOpen(s: CanvasSessionState): boolean {
  if (s.focusCrop !== null) return true;
  const draft = miniToolOpenOn(s.panelHostId)(s);
  if (draft === null) return false;
  if (draft.mark !== null || draft.drawing !== null || draft.expand !== null) return true;
  const spec = miniToolById(draft.toolId);
  if (spec === undefined || isModelTool(spec)) return false;
  return gridShapeOf(spec, draft.params) !== null || spec.params.some((param) => param.kind === 'rect');
}

/**
 * Keep a click on a tool layer from the node it sits in.
 * @param event - The click.
 */
export function stopNodeClick(event: React.MouseEvent): void {
  event.stopPropagation();
}

/**
 * Keep the arrows pressed in a selected node while a tool layer is open:
 * xyflow would move the node under the tool, whichever region holds the
 * keyboard. Text boxes keep theirs, and so does every control xyflow moves
 * nothing from (a panel's slider, the focus crop's timeline, a player in a
 * node that is not selected). Mounted once by the canvas, which stays
 * mounted while any node is culled; a hidden Space's effects are torn down,
 * so only the shown canvas listens.
 * @param active - Whether a tool layer is open.
 */
export function useToolLayerArrows(active: boolean): void {
  React.useEffect(() => {
    if (!active) return undefined;
    /**
     * Take an arrow pressed in a node.
     * @param event - The key.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target;
      if (!ARROWS.has(event.key) || !(target instanceof Element) || isEditableTarget(target)) return;
      if (target.closest(MOVED_BY_ARROWS) === null) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
