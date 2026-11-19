// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which result the Motion Space's preview shows (#1490 design §13.2), and which annotation thread's time the playhead
 * jumps to once that result shows. The one writer is `transitionWebAnimationSelection`. The preview only ever holds a
 * succeeded row; a row still in progress or one that failed is revealed in the execution list instead (the effect asks
 * the panels to open its tab and mark it), and the preview keeps what it showed. The effects also ask the page to fetch
 * a row that is not on a loaded page, or to say a located row was not found. The selection holds the selected row
 * itself, so the preview keeps it when a read of the list no longer holds it, and while a fetch is out it keeps the row
 * it showed before. Every transition that changes the result names the thread to focus, so a focus never outlives the
 * move that asked for it.
 */

import { webAnimationExecutionEnded, type WebAnimationExecutionStatus } from '@breatic/shared/space-content';

import type { MotionTab } from '@web/spaces/web-animation/motion-panels';

/** The part of a row the selection reads. */
export interface SelectionRow {
  id: string;
  status: WebAnimationExecutionStatus;
}

/** What the preview shows: nothing, the row it showed while another is fetched by id, or the selected row as last seen. */
export type SelectionState<R extends SelectionRow = SelectionRow> =
  | { status: 'none' }
  | { status: 'fetching'; executionId: string; requestId: number; focusThreadId: string | null; previous: R | null }
  | { status: 'selected'; row: R; focusThreadId: string | null };

/** What can happen to the selection. */
export type SelectionEvent<R extends SelectionRow = SelectionRow> =
  | { type: 'pick'; row: R }
  /** The row an accept created or answered with. */
  | { type: 'accepted'; row: R }
  /** A request to show a row by id; `row` is its loaded copy, or null when no loaded page holds it. */
  | { type: 'locate'; executionId: string; row: R | null; requestId: number; threadId: string | null }
  | { type: 'fetched'; requestId: number; row: R }
  | { type: 'fetch_failed'; requestId: number }
  /** The page's freshest copy of the selected row. */
  | { type: 'row_changed'; row: R }
  /** The playhead reached the focused thread's time. */
  | { type: 'focused'; threadId: string };

/** What the page does after a transition. */
export type SelectionEffect =
  | { type: 'reveal'; tab: MotionTab; executionId: string }
  | { type: 'fetch'; executionId: string; requestId: number }
  | { type: 'toast_not_found' };

/** A transition's outcome. */
export interface SelectionTransition<R extends SelectionRow = SelectionRow> {
  state: SelectionState<R>;
  effects: SelectionEffect[];
}

export const SELECTION_NONE: SelectionState<never> = { status: 'none' };

/**
 * The execution-list tab a row belongs to.
 * @param status - The row's status.
 * @returns `succeeded`, `running` before it ended, or `failed` once it failed, was cancelled or expired.
 * @throws {never} Never.
 */
export function tabOf(status: WebAnimationExecutionStatus): MotionTab {
  if (status === 'succeeded') return 'succeeded';
  return webAnimationExecutionEnded(status) ? 'failed' : 'running';
}

/**
 * What the preview shows once a fetch is dropped: the row it showed before, or nothing.
 * @param state - The selection now.
 * @returns The selection without the fetch.
 * @throws {never} Never.
 */
function settled<R extends SelectionRow>(state: SelectionState<R>): SelectionState<R> {
  if (state.status !== 'fetching') return state;
  return state.previous === null ? SELECTION_NONE : { status: 'selected', row: state.previous, focusThreadId: null };
}

/**
 * The row the preview shows now.
 * @param state - The selection.
 * @returns The row, or null.
 * @throws {never} Never.
 */
function shown<R extends SelectionRow>(state: SelectionState<R>): R | null {
  return state.status === 'selected' ? state.row : state.status === 'fetching' ? state.previous : null;
}

/**
 * The reveal of a row in the execution list.
 * @param row - The row.
 * @returns The effect.
 * @throws {never} Never.
 */
function reveal(row: SelectionRow): SelectionEffect {
  return { type: 'reveal', tab: tabOf(row.status), executionId: row.id };
}

/**
 * The selection after one event.
 * @param state - The selection now.
 * @param event - What happened.
 * @returns The selection after it and what the page does next.
 * @throws {never} Never.
 */
export function transitionWebAnimationSelection<R extends SelectionRow>(state: SelectionState<R>, event: SelectionEvent<R>): SelectionTransition<R> {
  const stay: SelectionTransition<R> = { state, effects: [] };
  switch (event.type) {
    case 'pick':
      return event.row.status === 'succeeded' ? { state: { status: 'selected', row: event.row, focusThreadId: null }, effects: [] } : stay;
    case 'accepted':
      return {
        state: event.row.status === 'succeeded' ? { status: 'selected', row: event.row, focusThreadId: null } : state,
        effects: [reveal(event.row)],
      };
    case 'locate':
      if (event.row === null) {
        return {
          state: { status: 'fetching', executionId: event.executionId, requestId: event.requestId, focusThreadId: event.threadId, previous: shown(state) },
          effects: [{ type: 'fetch', executionId: event.executionId, requestId: event.requestId }],
        };
      }
      if (event.row.status === 'succeeded') return { state: { status: 'selected', row: event.row, focusThreadId: event.threadId }, effects: [] };
      return { state: settled(state), effects: [reveal(event.row)] };
    case 'fetched':
      if (state.status !== 'fetching' || state.requestId !== event.requestId) return stay;
      if (event.row.status === 'succeeded') return { state: { status: 'selected', row: event.row, focusThreadId: state.focusThreadId }, effects: [] };
      return { state: settled(state), effects: [reveal(event.row)] };
    case 'fetch_failed':
      if (state.status !== 'fetching' || state.requestId !== event.requestId) return stay;
      return { state: settled(state), effects: [{ type: 'toast_not_found' }] };
    case 'row_changed':
      if (state.status !== 'selected' || state.row.id !== event.row.id || state.row === event.row) return stay;
      return { state: { ...state, row: event.row }, effects: [] };
    case 'focused':
      if (state.status !== 'selected' || state.focusThreadId !== event.threadId) return stay;
      return { state: { ...state, focusThreadId: null }, effects: [] };
  }
}
