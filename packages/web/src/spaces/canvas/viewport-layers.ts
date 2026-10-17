// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The z-indexes the canvas hands out inside the viewport's stacking context,
 * in one place so each layer can be derived from the ones it has to clear.
 */

/**
 * Render-layer z for the node a focus crop is open on (#2000), set instead of
 * touching `selected` — that field is the selection set six commands read to
 * pick their range, and this is a purely visual need.
 *
 * The ceiling it has to clear is a group member whose group is selected:
 * xyflow adds SELECTED_NODE_Z (1000) to the group, and `calculateChildXYZ`
 * gives the member `parentZ + 1`. That makes 1001 the highest a node
 * reaches, and 1002 clears it — on two conditions.
 *
 * Groups stay one level deep, which four separate places enforce:
 * `group-toolbar.ts`'s `allLoose` (a group cannot be put inside a new
 * group), `group-drag.ts`'s `draggedMembers` filter (a group dragged over
 * another never reparents), the loose-node filter inside `CanvasSpace.tsx`'s
 * `commitGroupResize` (a grown group swallows loose nodes only), and
 * `node-clipboard.ts`'s group branch, which drops the parentId it just
 * resolved (a pasted group is always a root — and that payload is parsed
 * out of the clipboard, so it is the one path an outside shape can enter).
 * Nesting two levels would put a member at 1002 and three at 1003.
 *
 * And `zIndexMode` stays `'basic'`, its default, which we never override.
 * Under `'auto'` xyflow adds `rootParentIndex * 10` to a root that has
 * children, counting from 1, on top of whatever `calculateZ` already gave
 * it — so the FIRST selected group with children lands on 1010 and its
 * member on 1011.
 *
 * It does not clear the generate panel, and cannot: NodeToolbar portals into
 * `.react-flow__renderer`, landing as a sibling of the pane that holds every
 * node, and the viewport inside that pane is its own stacking context.
 */
export const FOCUS_TARGET_Z = 1002;

/**
 * Where a pin paints, above every content node and above the +1000 xyflow adds
 * to a selected one. A note points at something, so it stays visible while the
 * thing it points at is being worked on; the focus-crop target still comes out
 * on top of it, since that gesture owns the screen while it runs.
 */
export const ANNOTATION_PIN_Z = 1001;

/**
 * What xyflow adds to a selected node's z: `SELECTED_NODE_Z`
 * (`@xyflow/system@0.0.79:1547`), applied by `calculateZ` whenever
 * `elevateNodesOnSelect` is on — its default (`@xyflow/react@12.11.2:3324`),
 * which we never override.
 */
export const XYFLOW_SELECTED_NODE_Z = 1000;

/**
 * Stacking for what the canvas draws over its nodes inside the viewport
 * portal, the new-note box and the expand frame: above every node on the
 * board, selected or not. Peers' pointers sit one above it.
 *
 * Derived rather than picked, because picked is how it went wrong — written as
 * 1000 it sat UNDER an ordinary pin at 1001, and measured on a board, a note
 * already on the canvas painted over the box somebody was typing into. The
 * ceiling is the highest z we hand a node plus what xyflow adds on selection;
 * anything at or below it is a node this box can end up behind.
 *
 * The box and the nodes share one stacking context — `.react-flow__nodes`
 * sets no z of its own, so both resolve against `.react-flow__viewport`, which
 * is where the ViewportPortal puts this. Measured: the node wrapper carries
 * `z-index: 1001` inline and the viewport carries 2.
 */
export const VIEWPORT_TOP_Z = Math.max(FOCUS_TARGET_Z, ANNOTATION_PIN_Z) + XYFLOW_SELECTED_NODE_Z + 1;
