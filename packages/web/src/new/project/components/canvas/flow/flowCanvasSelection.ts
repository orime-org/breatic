import type { Node } from '@xyflow/react';

/**
 * Count of selected React Flow nodes that participate in canvas selection UX.
 * Matches {@link ../common/LocalGroupToolbarPanel}: `connectEndAnchor` is excluded so
 * connection UX does not inflate “multi-select” and hide per-node toolbars incorrectly.
 *
 * @param state - React Flow store slice with `nodes`
 * @returns Number of selected non-anchor nodes
 */
export function selectFlowCanvasSelectedCount(state: { nodes: Node[] }): number {
  return state.nodes.filter((n) => n.selected && n.type !== 'connectEndAnchor').length;
}
