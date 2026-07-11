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
 * The binding is a STATE MACHINE, not a pair of one-shot effects (round-1
 * adversarial, 2026-07-11): a first cut selected the host once on open (keyed
 * on the id changing) and closed on the selected → deselected edge. Two real
 * holes followed from "once": a space-tab round-trip remounts the canvas with
 * the panel id persisted in the store, so the open-shot fired against a
 * not-yet-mirrored EMPTY buffer and never again; and re-choosing Generate on
 * the SAME host mid-pick kept the id unchanged so the shot never re-fired.
 * Both left an open panel on an unselected host with the edge guard
 * permanently disarmed (prev was never true). The machine below closes the
 * gap: while the binding has not been ESTABLISHED (host never seen selected),
 * it keeps asserting the selection; once established, losing it closes.
 *
 * Reference-pick mode holds the machine entirely: picking clicks move
 * selection to candidate source nodes by design, and the ratified pick
 * contract says Exit is the only way out — on exit (or on reopening the panel,
 * which clears the pick), the assert branch re-establishes the binding.
 */

/** One frame of the panel↔selection binding, compared across renders. */
export interface PanelSelectionSnapshot {
  /** The panel host node id (null = no panel open). */
  panelNodeId: string | null;
  /**
   * Whether the host node exists in the render buffer AND is selected;
   * null when the panel is closed or the host node is gone (a vanished host
   * is the node-gone guard's job, not this machine's).
   */
  hostSelected: boolean | null;
}

/** What the binding machine wants done this frame. */
export type PanelSelectionAction = 'close' | 'select' | 'none';

/**
 * Advances the panel⇄selection binding one frame and returns the action due:
 * `'select'` re-asserts the host as the selection while the binding has not
 * yet been established (open gesture, canvas remount with a persisted panel,
 * same-host reopen, pick exit); `'close'` fires on the established binding's
 * selected → deselected edge; `'none'` otherwise. Pick mode holds the machine.
 * @param prev - The previous frame's snapshot.
 * @param next - The current frame's snapshot.
 * @param picking - Whether reference-pick mode is active (machine held: Exit
 *   is the only way out of a pick session).
 * @returns The action due this frame.
 */
export function resolvePanelSelectionAction(
  prev: PanelSelectionSnapshot,
  next: PanelSelectionSnapshot,
  picking: boolean,
): PanelSelectionAction {
  if (next.panelNodeId == null || picking) return 'none';
  // A vanished host is the node-gone guard's job — selecting or closing here
  // would fight it.
  if (next.hostSelected === null) return 'none';
  // Fresh binding (the panel just opened / switched host): assert
  // UNCONDITIONALLY — the host may already be selected yet not be the SOLE
  // selection (a pre-open Cmd-multi-select leaves co-selected nodes/edges
  // holding a Delete-key claim under the panel; round-2 adversarial). The
  // assert is idempotent and reference-stable, so an already-sole host costs
  // nothing.
  if (prev.panelNodeId !== next.panelNodeId) return 'select';
  // Binding holds (host still selected).
  if (next.hostSelected === true) return 'none';
  // Established binding (same host was selected last frame) → losing the
  // selection closes the panel.
  if (prev.hostSelected === true) return 'close';
  // Binding not yet established → keep asserting the host selection until it
  // lands (the buffer may not even contain the host yet on remount).
  return 'select';
}
