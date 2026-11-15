// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The Motion Space's two floating panels and the execution list's tab (#1490 design §13.8). At most one panel is open;
 * the execution list keeps its tab while closed, and the annotation panel may focus one thread.
 */

/** Which execution-list tab shows. */
export type MotionTab = 'done' | 'running';

/** The panels' state. */
export interface MotionPanelsState {
  panel: 'none' | 'executions' | 'annotations';
  tab: MotionTab;
  /** The thread the annotation panel opened on, or null. */
  focusThreadId: string | null;
}

/** What can happen to the panels. */
export type MotionPanelsEvent =
  | { type: 'toggle_executions' }
  | { type: 'toggle_annotations' }
  | { type: 'new' }
  | { type: 'accepted'; created: boolean; tab: MotionTab }
  | { type: 'marker'; threadId: string }
  | { type: 'notification'; threadId: string }
  | { type: 'locate' }
  | { type: 'escape' }
  | { type: 'leave' }
  | { type: 'show_tab'; tab: MotionTab }
  | { type: 'pick_tab'; tab: MotionTab };

/** Both panels closed, on the completed tab. */
export const MOTION_PANELS_CLOSED: MotionPanelsState = { panel: 'none', tab: 'done', focusThreadId: null };

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
      return { ...state, panel: state.panel === 'executions' ? 'none' : 'executions', focusThreadId: null };
    case 'toggle_annotations':
      return { ...state, panel: state.panel === 'annotations' ? 'none' : 'annotations', focusThreadId: null };
    case 'accepted':
      return { panel: 'executions', tab: event.tab, focusThreadId: null };
    case 'marker':
    case 'notification':
      return { ...state, panel: 'annotations', focusThreadId: event.threadId };
    case 'escape':
    case 'leave':
      return { ...state, panel: 'none', focusThreadId: null };
    case 'show_tab':
    case 'pick_tab':
      return { ...state, tab: event.tab };
    case 'new':
    case 'locate':
      return state;
  }
}
