// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Which result the Motion Space's preview shows (#1490 design §13.2, the table whose one writer is
 * `transitionWebAnimationSelection`). Every cell of the table is one case. The preview only ever holds a succeeded
 * row; a row still in progress or one that failed is revealed in the execution list instead, on its own tab and
 * marked, and the preview keeps what it showed. While a row is fetched by id the preview keeps the row it showed.
 */

import { describe, expect, it } from 'vitest';

import {
  tabOf, transitionWebAnimationSelection, type SelectionEvent, type SelectionRow, type SelectionState,
} from '@web/spaces/web-animation/web-animation-selection';

const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const C = 'c0000000-0000-4000-8000-000000000003';
const T = 't0000000-0000-4000-8000-000000000001';

const NONE: SelectionState = { status: 'none' };
const RUNNING_A: SelectionRow = { id: A, status: 'running' };
const DONE_B: SelectionRow = { id: B, status: 'succeeded' };
const DONE_C: SelectionRow = { id: C, status: 'succeeded' };
const FAILED_A: SelectionRow = { id: A, status: 'failed' };
const ON_B: SelectionState = { status: 'selected', row: DONE_B, focusThreadId: null };
const ON_C: SelectionState = { status: 'selected', row: DONE_C, focusThreadId: null };
const fetching = (previous: SelectionRow | null, focusThreadId: string | null = null): SelectionState =>
  ({ status: 'fetching', executionId: A, requestId: 1, focusThreadId, previous });

type Accepted = Extract<SelectionEvent, { type: 'accepted' }>;
const created: Accepted = { type: 'accepted', row: { id: A, status: 'queued' } };
const answeredDone: Accepted = { type: 'accepted', row: DONE_C };
const answeredRunning: Accepted = { type: 'accepted', row: RUNNING_A };
const reveal = (tab: 'running' | 'succeeded' | 'failed', executionId = A): { type: 'reveal'; tab: typeof tab; executionId: string } => ({ type: 'reveal', tab, executionId });

describe('tabOf', () => {
  it.each([
    ['queued', 'running'], ['running', 'running'], ['cancelling', 'running'], ['awaiting_landing', 'running'],
    ['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'failed'], ['expired', 'failed'],
  ] as const)('puts a %s row on the %s tab', (status, tab) => {
    expect(tabOf(status)).toBe(tab);
  });
});

describe('transitionWebAnimationSelection — nothing selected', () => {
  it('selects a picked row that succeeded, and ignores a pick of one in progress or failed', () => {
    expect(transitionWebAnimationSelection(NONE, { type: 'pick', row: DONE_C })).toEqual({ state: ON_C, effects: [] });
    expect(transitionWebAnimationSelection(NONE, { type: 'pick', row: RUNNING_A })).toEqual({ state: NONE, effects: [] });
    expect(transitionWebAnimationSelection(NONE, { type: 'pick', row: FAILED_A })).toEqual({ state: NONE, effects: [] });
  });

  it('reveals a row a new accept created, leaving the preview empty', () => {
    expect(transitionWebAnimationSelection(NONE, created)).toEqual({ state: NONE, effects: [reveal('running')] });
  });

  it('selects and reveals a succeeded row an accept answered with, and only reveals one in progress', () => {
    expect(transitionWebAnimationSelection(NONE, answeredDone)).toEqual({ state: ON_C, effects: [reveal('succeeded', C)] });
    expect(transitionWebAnimationSelection(NONE, answeredRunning)).toEqual({ state: NONE, effects: [reveal('running')] });
  });

  it('selects a located row that is loaded and succeeded, reveals one that is not, and fetches one not loaded', () => {
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: C, row: DONE_C, requestId: 7, threadId: null })).toEqual({ state: ON_C, effects: [] });
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: A, row: RUNNING_A, requestId: 7, threadId: null })).toEqual({ state: NONE, effects: [reveal('running')] });
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: A, row: FAILED_A, requestId: 7, threadId: null })).toEqual({ state: NONE, effects: [reveal('failed')] });
    expect(transitionWebAnimationSelection(NONE, { type: 'locate', executionId: C, row: null, requestId: 7, threadId: null })).toEqual({
      state: { status: 'fetching', executionId: C, requestId: 7, focusThreadId: null, previous: null }, effects: [{ type: 'fetch', executionId: C, requestId: 7 }],
    });
  });

  it('ignores a fetch answer, a row change and a reached thread', () => {
    for (const event of [
      { type: 'fetched', requestId: 1, row: DONE_C },
      { type: 'fetch_failed', requestId: 1 },
      { type: 'row_changed', row: DONE_C },
      { type: 'focused', threadId: T },
    ] as SelectionEvent[]) {
      expect(transitionWebAnimationSelection(NONE, event)).toEqual({ state: NONE, effects: [] });
    }
  });
});

describe('transitionWebAnimationSelection — fetching', () => {
  it('selects a picked succeeded row and drops the fetch, and keeps fetching on a pick of another row', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'pick', row: DONE_C }).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'pick', row: FAILED_A }).state).toEqual(fetching(DONE_B));
  });

  it('selects a succeeded row an accept answered with and drops the fetch; a new row only reveals', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), answeredDone).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(fetching(DONE_B), created)).toEqual({ state: fetching(DONE_B), effects: [reveal('running')] });
  });

  it('replaces the fetch with a newer locate, keeping the row the preview shows', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'locate', executionId: C, row: null, requestId: 2, threadId: null }).state)
      .toEqual({ status: 'fetching', executionId: C, requestId: 2, focusThreadId: null, previous: DONE_B });
  });

  it('drops the fetch for a newer locate of a loaded row that has not succeeded, back on the row it showed', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'locate', executionId: A, row: RUNNING_A, requestId: 2, threadId: null }))
      .toEqual({ state: ON_B, effects: [reveal('running')] });
  });

  it('selects a fetched row that succeeded', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'fetched', requestId: 1, row: { id: A, status: 'succeeded' } }))
      .toEqual({ state: { status: 'selected', row: { id: A, status: 'succeeded' }, focusThreadId: null }, effects: [] });
  });

  it('goes back to the row it showed and reveals a fetched row that has not succeeded', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'fetched', requestId: 1, row: RUNNING_A })).toEqual({ state: ON_B, effects: [reveal('running')] });
    expect(transitionWebAnimationSelection(fetching(null), { type: 'fetched', requestId: 1, row: FAILED_A })).toEqual({ state: NONE, effects: [reveal('failed')] });
  });

  it('ignores the answer of a fetch a newer locate replaced', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'fetched', requestId: 0, row: DONE_C })).toEqual({ state: fetching(DONE_B), effects: [] });
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'fetch_failed', requestId: 0 })).toEqual({ state: fetching(DONE_B), effects: [] });
  });

  it('goes back to the row it showed and says the row was not found when the fetch fails', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'fetch_failed', requestId: 1 })).toEqual({ state: ON_B, effects: [{ type: 'toast_not_found' }] });
    expect(transitionWebAnimationSelection(fetching(null), { type: 'fetch_failed', requestId: 1 })).toEqual({ state: NONE, effects: [{ type: 'toast_not_found' }] });
  });

  it('keeps fetching through a row change', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_B), { type: 'row_changed', row: DONE_C }).state).toEqual(fetching(DONE_B));
  });
});

describe('transitionWebAnimationSelection — a row selected', () => {
  it('moves to a newly picked succeeded row, and stays on a pick of one that has not succeeded', () => {
    expect(transitionWebAnimationSelection(ON_B, { type: 'pick', row: DONE_C }).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(ON_B, { type: 'pick', row: RUNNING_A })).toEqual({ state: ON_B, effects: [] });
  });

  it('keeps the preview on an accept that created a row, and moves to a succeeded row an accept answered with', () => {
    expect(transitionWebAnimationSelection(ON_B, created)).toEqual({ state: ON_B, effects: [reveal('running')] });
    expect(transitionWebAnimationSelection(ON_B, answeredDone)).toEqual({ state: ON_C, effects: [reveal('succeeded', C)] });
  });

  it('starts a fetch that keeps the row it shows', () => {
    expect(transitionWebAnimationSelection(ON_B, { type: 'locate', executionId: A, row: null, requestId: 3, threadId: null }).state)
      .toEqual({ status: 'fetching', executionId: A, requestId: 3, focusThreadId: null, previous: DONE_B });
  });

  it('keeps a fresher copy of the selected row without asking for anything', () => {
    const later: SelectionRow = { id: B, status: 'succeeded' };
    expect(transitionWebAnimationSelection(ON_B, { type: 'row_changed', row: later })).toEqual({ state: { status: 'selected', row: later, focusThreadId: null }, effects: [] });
  });

  it('does nothing when told about the row it already holds or another row', () => {
    expect(transitionWebAnimationSelection(ON_B, { type: 'row_changed', row: DONE_B }).state).toBe(ON_B);
    expect(transitionWebAnimationSelection(ON_B, { type: 'row_changed', row: DONE_C })).toEqual({ state: ON_B, effects: [] });
  });
});

describe('transitionWebAnimationSelection — the thread to focus', () => {
  const FOCUSED: SelectionState = { status: 'selected', row: DONE_B, focusThreadId: T };

  it('carries a locate\'s thread into the selection, directly or through the fetch', () => {
    expect(transitionWebAnimationSelection(ON_C, { type: 'locate', executionId: B, row: DONE_B, requestId: 3, threadId: T }).state).toEqual(FOCUSED);
    const waiting = transitionWebAnimationSelection(NONE, { type: 'locate', executionId: B, row: null, requestId: 3, threadId: T }).state;
    expect(waiting).toEqual({ status: 'fetching', executionId: B, requestId: 3, focusThreadId: T, previous: null });
    expect(transitionWebAnimationSelection(waiting, { type: 'fetched', requestId: 3, row: DONE_B }).state).toEqual(FOCUSED);
  });

  it('drops the focus when the fetch fails, a row is picked or an accept moves the selection', () => {
    expect(transitionWebAnimationSelection(fetching(DONE_C, T), { type: 'fetch_failed', requestId: 1 }).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'pick', row: DONE_C }).state).toEqual(ON_C);
    expect(transitionWebAnimationSelection(FOCUSED, answeredDone).state).toEqual(ON_C);
  });

  it('replaces the focus with a newer locate\'s, including none', () => {
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'locate', executionId: C, row: DONE_C, requestId: 4, threadId: null }).state).toEqual(ON_C);
  });

  it('spends the focus once it is reached, and ignores a reach of another thread', () => {
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'focused', threadId: T })).toEqual({ state: ON_B, effects: [] });
    expect(transitionWebAnimationSelection(FOCUSED, { type: 'focused', threadId: 'other' })).toEqual({ state: FOCUSED, effects: [] });
  });
});
