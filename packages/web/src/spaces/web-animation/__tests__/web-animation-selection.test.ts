// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which result the Motion Space's preview shows (#1490 design §13.2, the table whose one writer is
 * `transitionWebAnimationSelection`). Every cell of the table is one case. A row that ended belongs to the
 * "done" tab and one still open to "running"; the effects ask the panels to show a tab or the page to toast.
 */

import { describe, expect, it } from 'vitest';

import {
  transitionWebAnimationSelection, type SelectionEvent, type SelectionRow, type SelectionState,
} from '@web/spaces/web-animation/web-animation-selection';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';

const NONE: SelectionState = { status: 'none' };
const T = 't0000000-0000-4000-8000-000000000001';
const ROW_A: SelectionRow = { id: A, status: 'running' };
const ROW_B: SelectionRow = { id: B, status: 'succeeded' };
const ROW_C: SelectionRow = { id: C, status: 'succeeded' };
const FETCHING: SelectionState = { status: 'fetching', executionId: B, requestId: 1, focusThreadId: null };
const SELECTED: SelectionState = { status: 'selected', row: ROW_A, focusThreadId: null };
const ON_C: SelectionState = { status: 'selected', row: ROW_C, focusThreadId: null };

const pick: SelectionEvent = { type: 'pick', row: ROW_C };
type Accepted = Extract<SelectionEvent, { type: 'accepted' }>;
const created: Accepted = { type: 'accepted', created: true, row: { id: C, status: 'queued' } };
const existingDone: Accepted = { type: 'accepted', created: false, row: ROW_C };
const existingRunning: Accepted = { type: 'accepted', created: false, row: { id: C, status: 'running' } };

describe('transitionWebAnimationSelection — nothing selected', () => {
  it('selects a picked row', () => {
    expect(transitionWebAnimationSelection(NONE, pick)).toEqual({ state: ON_C, effects: [] });
  });

  it('selects a row a new accept created and shows the running tab', () => {
    expect(transitionWebAnimationSelection(NONE, created)).toEqual({ state: { status: 'selected', row: created.row, focusThreadId: null }, effects: [{ type: 'show_tab', tab: 'running' }] });
  });

  it.each([[existingDone, 'done'], [existingRunning, 'running']] as const)('selects a row an accept answered with and shows its own tab (%#)', (event, tab) => {
    expect(transitionWebAnimationSelection(NONE, event)).toEqual({ state: { status: 'selected', row: event.row, focusThreadId: null }, effects: [{ type: 'show_tab', tab }] });
  });

  it('selects a located row that is loaded and shows its tab, and fetches one that is not', () => {
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: C, row: ROW_C, requestId: 7, threadId: null })).toEqual({ state: ON_C, effects: [{ type: 'show_tab', tab: 'done' }] });
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: C, row: null, requestId: 7, threadId: null })).toEqual({
      state: { status: 'fetching', executionId: C, requestId: 7, focusThreadId: null }, effects: [{ type: 'fetch', executionId: C, requestId: 7 }],
    });
  });

  it('ignores a fetch answer, a row change and a tab switch, and stays empty on leave', () => {
    for (const event of [
      { type: 'fetched', requestId: 1, row: { id: C, status: 'succeeded' } },
      { type: 'fetch_failed', requestId: 1 },
      { type: 'row_changed', row: { id: C, status: 'failed' } },
      { type: 'focused', threadId: T },
      { type: 'tab' },
      { type: 'leave' },
    ] as SelectionEvent[]) {
      expect(transitionWebAnimationSelection(NONE, event)).toEqual({ state: NONE, effects: [] });
    }
  });
});

describe('transitionWebAnimationSelection — fetching', () => {
  it('selects a picked row and drops the fetch', () => {
    expect(transitionWebAnimationSelection(FETCHING, pick).state).toEqual(ON_C);
  });

  it('selects an accepted row and drops the fetch', () => {
    expect(transitionWebAnimationSelection(FETCHING, created).state).toEqual({ status: 'selected', row: created.row, focusThreadId: null });
    expect(transitionWebAnimationSelection(FETCHING, existingDone).state).toEqual(ON_C);
  });

  it('replaces the fetch with a newer locate', () => {
    expect(transitionWebAnimationSelection(FETCHING, { type: 'locate', executionId: C, row: null, requestId: 2, threadId: null }).state).toEqual({ status: 'fetching', executionId: C, requestId: 2, focusThreadId: null });
  });

  it('selects the fetched row and shows its tab', () => {
    expect(transitionWebAnimationSelection(FETCHING, { type: 'fetched', requestId: 1, row: ROW_B })).toEqual({
      state: { status: 'selected', row: ROW_B, focusThreadId: null }, effects: [{ type: 'show_tab', tab: 'done' }],
    });
  });

  it('ignores the answer of a fetch a newer locate replaced', () => {
    expect(transitionWebAnimationSelection(FETCHING, { type: 'fetched', requestId: 0, row: { id: A, status: 'succeeded' } })).toEqual({ state: FETCHING, effects: [] });
  });

  it('clears the selection and says the row was not found when the fetch fails', () => {
    expect(transitionWebAnimationSelection(FETCHING, { type: 'fetch_failed', requestId: 1 })).toEqual({ state: NONE, effects: [{ type: 'toast_not_found' }] });
  });

  it('keeps fetching through a row change and a tab switch, and clears on leave', () => {
    expect(transitionWebAnimationSelection(FETCHING, { type: 'row_changed', row: { id: A, status: 'failed' } }).state).toEqual(FETCHING);
    expect(transitionWebAnimationSelection(FETCHING, { type: 'tab' }).state).toEqual(FETCHING);
    expect(transitionWebAnimationSelection(FETCHING, { type: 'leave' }).state).toEqual(NONE);
  });
});

describe('transitionWebAnimationSelection — a row selected', () => {
  it('moves to a newly picked row', () => {
    expect(transitionWebAnimationSelection(SELECTED, pick).state).toEqual(ON_C);
  });

  it('moves to an accepted row, showing running for a new one and its own tab for one that existed', () => {
    expect(transitionWebAnimationSelection(SELECTED, created).effects).toEqual([{ type: 'show_tab', tab: 'running' }]);
    expect(transitionWebAnimationSelection(SELECTED, existingDone).effects).toEqual([{ type: 'show_tab', tab: 'done' }]);
  });

  it('follows the selected row into the other tab when its status crosses, keeping the fresher copy', () => {
    const ended: SelectionRow = { id: A, status: 'succeeded' };
    expect(transitionWebAnimationSelection(SELECTED, { type: 'row_changed', row: ended })).toEqual({
      state: { status: 'selected', row: ended, focusThreadId: null }, effects: [{ type: 'show_tab', tab: 'done' }],
    });
  });

  it('keeps a fresher copy in the same tab without asking for a tab', () => {
    const later: SelectionRow = { id: A, status: 'cancelling' };
    expect(transitionWebAnimationSelection(SELECTED, { type: 'row_changed', row: later })).toEqual({ state: { status: 'selected', row: later, focusThreadId: null }, effects: [] });
  });

  it('does nothing when told about the row it already holds', () => {
    const outcome = transitionWebAnimationSelection(SELECTED, { type: 'row_changed', row: ROW_A });
    expect(outcome.state).toBe(SELECTED);
    expect(outcome.effects).toEqual([]);
  });

  it('ignores a change of another row', () => {
    expect(transitionWebAnimationSelection(SELECTED, { type: 'row_changed', row: ROW_B })).toEqual({ state: SELECTED, effects: [] });
  });

  it('keeps the preview on the selected result when the tab is switched', () => {
    expect(transitionWebAnimationSelection(SELECTED, { type: 'tab' })).toEqual({ state: SELECTED, effects: [] });
  });

  it('clears on leave', () => {
    expect(transitionWebAnimationSelection(SELECTED, { type: 'leave' }).state).toEqual(NONE);
  });
});

describe('transitionWebAnimationSelection — the thread to focus', () => {
  const FOCUSED: SelectionState = { status: 'selected', row: ROW_A, focusThreadId: T };

  it('carries a locate\'s thread into the selection, directly or through the fetch', () => {
    expect(transitionWebAnimationSelection(SELECTED, { type: 'locate', executionId: A, row: ROW_A, requestId: 3, threadId: T }).state).toEqual(FOCUSED);
    const fetching = transitionWebAnimationSelection(NONE, { type: 'locate', executionId: B, row: null, requestId: 3, threadId: T }).state;
    expect(fetching).toEqual({ status: 'fetching', executionId: B, requestId: 3, focusThreadId: T });
    expect(transitionWebAnimationSelection(fetching, { type: 'fetched', requestId: 3, row: ROW_B }).state)
      .toEqual({ status: 'selected', row: ROW_B, focusThreadId: T });
  });

  it('drops the focus when the fetch fails, a row is picked or an accept moves the selection', () => {
    const fetching: SelectionState = { status: 'fetching', executionId: B, requestId: 1, focusThreadId: T };
    expect(transitionWebAnimationSelection(fetching, { type: 'fetch_failed', requestId: 1 }).state).toEqual(NONE);
    expect(transitionWebAnimationSelection(fetching, pick).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(FOCUSED, pick).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(FOCUSED, created).state).toEqual({ status: 'selected', row: created.row, focusThreadId: null });
  });

  it('replaces the focus with a newer locate\'s, including none', () => {
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'locate', executionId: C, row: ROW_C, requestId: 4, threadId: null }).state).toEqual(ON_C);
  });

  it('spends the focus once it is reached, and ignores a reach of another thread', () => {
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'focused', threadId: T })).toEqual({ state: SELECTED, effects: [] });
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'focused', threadId: 'other' })).toEqual({ state: FOCUSED, effects: [] });
  });
});
