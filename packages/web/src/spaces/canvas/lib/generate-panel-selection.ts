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
 * The binding is a STATE MACHINE, not a pair of one-shot effects (adversarial
 * rounds 1-3, 2026-07-11). Holes closed per round:
 * - Round 1: a one-shot open effect (keyed on the id changing) missed the
 *   canvas-remount and same-host-reopen paths, leaving an open panel on an
 *   unselected host with the close edge permanently disarmed. The machine
 *   keeps asserting until the binding is established.
 * - Round 2: opening on an ALREADY-selected host skipped the sole-selection
 *   assert (a pre-open Cmd-multi-select left co-selected nodes/edges holding
 *   a Delete-key claim under the panel). Fresh-binding frames now assert
 *   unconditionally — the assert is idempotent and reference-stable, so an
 *   already-sole host costs nothing.
 * - Round 3: the same co-selection could be BUILT during a pick (Cmd-click
 *   with the host still selected) and survive Exit, because the machine only
 *   re-asserted when the host was deselected. Leaving a pick is a REBINDING
 *   moment exactly like opening: the pick-exit frame now asserts
 *   unconditionally too.
 *
 * Reference-pick mode holds the machine entirely: picking clicks move
 * selection to candidate source nodes by design, and the ratified pick
 * contract says Exit is the only way out — the exit frame (or reopening the
 * panel, which clears the pick) re-establishes the binding via the assert.
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
  /** Whether reference-pick mode was active this frame. */
  picking: boolean;
}

/** What the binding machine wants done this frame. */
export type PanelSelectionAction = 'close' | 'select' | 'none';

/**
 * Advances the panel⇄selection binding one frame and returns the action due:
 * `'select'` re-asserts the host as the sole selection on every REBINDING
 * frame (panel opened / switched host / pick just exited) and while the
 * binding has not yet been established; `'close'` fires on the established
 * binding's selected → deselected edge; `'none'` otherwise. Pick mode holds
 * the machine.
 * @param prev - The previous frame's snapshot.
 * @param next - The current frame's snapshot.
 * @returns The action due this frame.
 */
export function resolvePanelSelectionAction(
  prev: PanelSelectionSnapshot,
  next: PanelSelectionSnapshot,
): PanelSelectionAction {
  if (next.panelNodeId == null || next.picking) return 'none';
  // A vanished host is the node-gone guard's job — selecting or closing here
  // would fight it.
  if (next.hostSelected === null) return 'none';
  // Rebinding frames assert UNCONDITIONALLY — the host may already be
  // selected yet not be the SOLE selection (a Cmd-multi-select before opening
  // or during a pick leaves co-selected nodes/edges holding a Delete-key
  // claim under the panel; rounds 2-3). The assert is idempotent and
  // reference-stable, so an already-sole host costs nothing. Two rebinding
  // edges exist: the panel id changed (open / host switch), and the pick just
  // ended (Exit or a reopen clearing it).
  if (prev.panelNodeId !== next.panelNodeId || prev.picking) return 'select';
  // Binding holds (host still selected).
  if (next.hostSelected === true) return 'none';
  // Established binding (same host was selected last frame) → losing the
  // selection closes the panel.
  if (prev.hostSelected === true) return 'close';
  // Binding not yet established → keep asserting the host selection until it
  // lands (the buffer may not even contain the host yet on remount).
  return 'select';
}
