// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which result the Motion Space's preview shows (#1490 design §13.2). The one writer is
 * `transitionWebAnimationSelection`; the effects it returns ask the panels to show a tab, the page to fetch a row that
 * is not on a loaded page, or to say a located row was not found.
 */

import { webAnimationExecutionEnded, type WebAnimationExecutionStatus } from '@breatic/shared/space-content';

import type { MotionTab } from '@web/spaces/web-animation/motion-panels';

/** What the preview shows. */
export type SelectionState =
  | { status: 'none' }
  | { status: 'fetching'; executionId: string; requestId: number }
  | { status: 'selected'; executionId: string };

/** The part of a row the selection reads. */
export interface SelectionRow {
  id: string;
  status: WebAnimationExecutionStatus;
}

/** What can happen to the selection. */
export type SelectionEvent =
  | { type: 'pick'; executionId: string }
  | { type: 'accepted'; created: boolean; row: SelectionRow }
  | { type: 'locate'; executionId: string; loaded: boolean; requestId: number }
  | { type: 'fetched'; requestId: number; row: SelectionRow }
  | { type: 'fetch_failed'; requestId: number }
  | { type: 'row_changed'; row: SelectionRow }
  | { type: 'tab' }
  | { type: 'leave' };

/** What the page does after a transition. */
export type SelectionEffect =
  | { type: 'show_tab'; tab: MotionTab }
  | { type: 'fetch'; executionId: string; requestId: number }
  | { type: 'toast_not_found' };

/** A transition's outcome. */
export interface SelectionTransition {
  state: SelectionState;
  effects: SelectionEffect[];
}

export const SELECTION_NONE: SelectionState = { status: 'none' };

/**
 * The execution-list tab a row belongs to.
 * @param status - The row's status.
 * @returns `done` once it ended, `running` before.
 * @throws {never} Never.
 */
export function tabOf(status: WebAnimationExecutionStatus): MotionTab {
  return webAnimationExecutionEnded(status) ? 'done' : 'running';
}

/**
 * The selection after one event.
 * @param state - The selection now.
 * @param event - What happened.
 * @returns The selection after it and what the page does next.
 * @throws {never} Never.
 */
export function transitionWebAnimationSelection(state: SelectionState, event: SelectionEvent): SelectionTransition {
  const stay: SelectionTransition = { state, effects: [] };
  switch (event.type) {
    case 'pick':
      return { state: { status: 'selected', executionId: event.executionId }, effects: [] };
    case 'accepted':
      return {
        state: { status: 'selected', executionId: event.row.id },
        effects: [{ type: 'show_tab', tab: event.created ? 'running' : tabOf(event.row.status) }],
      };
    case 'locate':
      if (event.loaded) return { state: { status: 'selected', executionId: event.executionId }, effects: [] };
      return {
        state: { status: 'fetching', executionId: event.executionId, requestId: event.requestId },
        effects: [{ type: 'fetch', executionId: event.executionId, requestId: event.requestId }],
      };
    case 'fetched':
      if (state.status !== 'fetching' || state.requestId !== event.requestId) return stay;
      return { state: { status: 'selected', executionId: event.row.id }, effects: [{ type: 'show_tab', tab: tabOf(event.row.status) }] };
    case 'fetch_failed':
      if (state.status !== 'fetching' || state.requestId !== event.requestId) return stay;
      return { state: SELECTION_NONE, effects: [{ type: 'toast_not_found' }] };
    case 'row_changed':
      if (state.status !== 'selected' || state.executionId !== event.row.id) return stay;
      return { state, effects: [{ type: 'show_tab', tab: tabOf(event.row.status) }] };
    case 'tab':
      return stay;
    case 'leave':
      return { state: SELECTION_NONE, effects: [] };
  }
}
