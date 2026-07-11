// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Selection-driven Generate-panel lifecycle (user-ratified 2026-07-11).
 *
 * The panel binds to its host node's SELECTION as the single source of truth:
 * opening the panel selects the host, and the host losing selection closes the
 * panel — through ANY path (clicking another node, clicking empty canvas,
 * creating a node from the library menu, pasting, grouping, or any future
 * route that moves selection). The previous design enumerated close triggers
 * per event handler and missed the programmatic-selection paths (menu-create /
 * paste auto-select the new node), which left the panel orphaned on an
 * unselected node.
 *
 * The rule is EDGE-triggered, not level-triggered: it closes only on the
 * host's selected → deselected transition. A level rule ("not selected =
 * close") would race the open gesture — the store opens the panel first and
 * the selection effect writes `selected` a beat later, so the first render
 * after opening would read "open + unselected" and kill the panel instantly.
 * The edge form is immune to open ordering and to switching the panel from
 * node A directly to node B (the transition is compared per host id).
 *
 * Reference-pick mode is exempt: picking clicks move selection to candidate
 * source nodes by design, and the ratified pick contract says Exit is the only
 * way out — the Exit handler restores the host's selection so the invariant
 * re-establishes on the way back.
 */

/** One frame of the panel↔selection binding, compared across renders. */
export interface PanelSelectionSnapshot {
  /** The panel host node id (null = no panel open). */
  panelNodeId: string | null;
  /**
   * Whether the host node exists in the render buffer AND is selected;
   * null when the panel is closed or the host node is gone (a vanished host
   * is the node-gone guard's job, not this rule's).
   */
  hostSelected: boolean | null;
}

/**
 * Decides whether the Generate panel must auto-close because its host node
 * just LOST selection (selected → deselected edge on the same host, outside
 * reference-pick mode).
 * @param prev - The previous render's snapshot.
 * @param next - The current render's snapshot.
 * @param picking - Whether reference-pick mode is active (exempt: Exit is the
 *   only way out of a pick session).
 * @returns True when the panel should close.
 */
export function shouldCloseOnSelectionEdge(
  prev: PanelSelectionSnapshot,
  next: PanelSelectionSnapshot,
  picking: boolean,
): boolean {
  if (next.panelNodeId == null || picking) return false;
  // Edges only count within the SAME host: switching the panel to another
  // node starts a fresh binding (its selection effect runs this same commit).
  if (prev.panelNodeId !== next.panelNodeId) return false;
  return prev.hostSelected === true && next.hostSelected === false;
}
