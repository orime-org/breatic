// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space's two floating panels, the execution list's tab and the row it marks (#1490 design §13.8). At most
 * one panel is open; the execution list keeps its tab and marked row while closed. Which thread the annotation panel
 * shows is `useMotionAnnotations'`.
 */

/** Which execution-list tab shows: rows that succeeded, rows in progress, or rows that failed, were cancelled or expired. */
export type MotionTab = 'succeeded' | 'running' | 'failed';

/** The panels' state. */
export interface MotionPanelsState {
  panel: 'none' | 'executions' | 'annotations';
  tab: MotionTab;
  /** The row the list marks: the last one accepted, or located while it had not succeeded. */
  marked: string | null;
}

/** What can happen to the panels. */
export type MotionPanelsEvent =
  | { type: 'toggle_executions' }
  | { type: 'toggle_annotations' }
  | { type: 'new' }
  /** An accepted execution, or a located one that has not succeeded: the list opens on its tab and marks it. */
  | { type: 'reveal'; tab: MotionTab; executionId: string }
  /** A thread opened: from its marker, its pin, the panel, "Modified from" or a notification. */
  | { type: 'open_thread' }
  | { type: 'escape' }
  | { type: 'pick_tab'; tab: MotionTab };

/** Both panels closed, on the Completed tab, nothing marked. */
export const MOTION_PANELS_CLOSED: MotionPanelsState = { panel: 'none', tab: 'succeeded', marked: null };

/**
 * The panels after one event.
 * @param state - The panels now.
 * @param event - What happened.
 * @returns The panels after it.
 * @throws {never} Never.
 */
export function transitionMotionPanels(state: MotionPanelsState, event: MotionPanelsEvent): MotionPanelsState {
  switch (event.type) {
    case 'toggle_executions':
      return { ...state, panel: state.panel === 'executions' ? 'none' : 'executions' };
    case 'toggle_annotations':
      return { ...state, panel: state.panel === 'annotations' ? 'none' : 'annotations' };
    case 'reveal':
      return { panel: 'executions', tab: event.tab, marked: event.executionId };
    case 'open_thread':
      return { ...state, panel: 'annotations' };
    case 'escape':
      return { ...state, panel: 'none' };
    case 'pick_tab':
      return { ...state, tab: event.tab };
    case 'new':
      return state;
  }
}
