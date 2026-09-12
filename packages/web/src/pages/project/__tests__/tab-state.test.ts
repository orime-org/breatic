// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  INITIAL_TAB_STATE,
  reduceTabState,
  type TabState,
} from '@web/pages/project/tab-state';
import type { TabOrderEntry } from '@breatic/shared';

/**
 * Every fillable cell of the transition table has an assertion here. The five
 * actions carry the ten events: `spaces` carries E1/E8/E9, `open` carries
 * E2/E3/E4/E7, and `close` / `reorder` / `reset` carry one each. Cells that
 * share an action, a state AND an outcome are one assertion, named for both.
 *
 * | Cell                        | Test                                          |
 * |-----------------------------|-----------------------------------------------|
 * | E1 x S0, spaces non-empty   | seeds the newest Space and activates it       |
 * | E1 x S0, spaces empty       | becomes ready with an empty strip             |
 * | E8 x S1                     | leaves an empty strip alone                   |
 * | E8 x S2, active survives    | drops the deleted tabs, keeps the active one  |
 * | E8 x S2, active deleted     | falls back to the leftmost surviving tab      |
 * | E8 x S2, all deleted        | empties the strip without refilling it        |
 * | E9 x S1, E9 x S2            | ignores Spaces somebody else created          |
 * | E2 x S1, E7 x S1            | opens onto an empty strip                     |
 * | E2 x S2, E7 x S2            | appends at the end and activates              |
 * | E3 x S2, E4 x S2            | activates an open tab in place                |
 * | E5 x S2, closing a sibling  | removes it and leaves the active tab alone    |
 * | E5 x S2, closing the active | activates the leftmost survivor               |
 * | E5 x S2, closing the last   | leaves an empty strip                         |
 * | E6 x S2                     | reorders without changing the active tab      |
 * | E10 x S1, E10 x S2          | resets to the unready state                   |
 */

const space = (id: string, createdAt: number): TabOrderEntry => ({
  id,
  createdAt,
});

const SPACES = [space('a', 100), space('b', 200), space('c', 300)];

/** A ready state holding `openIds` with `activeId` selected. */
const ready = (openIds: string[], activeId: string | null): TabState => ({
  ready: true,
  openIds,
  activeId,
});

/**
 * Assert the invariants that hold at every moment (I1, I2, I4).
 * @param state - The state to check.
 * @returns Nothing.
 */
function expectInvariants(state: TabState): void {
  expect(state.activeId === null).toBe(state.openIds.length === 0);
  if (state.activeId !== null) {
    expect(state.openIds).toContain(state.activeId);
  }
  expect(new Set(state.openIds).size).toBe(state.openIds.length);
}

describe('reduceTabState — spaces arriving (E1, E8, E9)', () => {
  it('seeds the newest Space and activates it (E1 x S0, spaces non-empty)', () => {
    const next = reduceTabState(INITIAL_TAB_STATE, {
      type: 'spaces',
      spaces: SPACES,
    });
    expect(next).toEqual({ ready: true, openIds: ['c'], activeId: 'c' });
    expectInvariants(next);
  });

  it('becomes ready with an empty strip (E1 x S0, spaces empty)', () => {
    const next = reduceTabState(INITIAL_TAB_STATE, {
      type: 'spaces',
      spaces: [],
    });
    expect(next).toEqual({ ready: true, openIds: [], activeId: null });
    expectInvariants(next);
  });

  it('leaves an empty strip alone (E8 x S1)', () => {
    const state = ready([], null);
    expect(reduceTabState(state, { type: 'spaces', spaces: [SPACES[0]!] })).toBe(
      state,
    );
  });

  it('drops the deleted tabs, keeps the active one (E8 x S2, active survives)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'c'), {
      type: 'spaces',
      spaces: [SPACES[0]!, SPACES[2]!],
    });
    expect(next.openIds).toEqual(['a', 'c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('falls back to the leftmost surviving tab (E8 x S2, active deleted)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'b'), {
      type: 'spaces',
      spaces: [SPACES[0]!, SPACES[2]!],
    });
    expect(next.openIds).toEqual(['a', 'c']);
    expect(next.activeId).toBe('a');
    expectInvariants(next);
  });

  it('empties the strip without refilling it (E8 x S2, all deleted)', () => {
    const next = reduceTabState(ready(['b'], 'b'), {
      type: 'spaces',
      spaces: [SPACES[0]!, SPACES[2]!],
    });
    expect(next).toEqual({ ready: true, openIds: [], activeId: null });
    expectInvariants(next);
  });

  it('drops several tabs in one batch (E8 x S2, a multi-delete transaction)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'a'), {
      type: 'spaces',
      spaces: [SPACES[1]!],
    });
    expect(next.openIds).toEqual(['b']);
    expect(next.activeId).toBe('b');
    expectInvariants(next);
  });

  it('ignores Spaces somebody else created (E9 x S1, E9 x S2)', () => {
    const empty = ready([], null);
    expect(reduceTabState(empty, { type: 'spaces', spaces: SPACES })).toBe(
      empty,
    );
    const open = ready(['a'], 'a');
    expect(reduceTabState(open, { type: 'spaces', spaces: SPACES })).toBe(open);
  });
});

describe('reduceTabState — opening a Space (E2, E3, E4, E7)', () => {
  it('opens onto an empty strip (E2 x S1, E7 x S1)', () => {
    const next = reduceTabState(ready([], null), {
      type: 'open',
      spaceId: 'a',
    });
    expect(next).toEqual({ ready: true, openIds: ['a'], activeId: 'a' });
    expectInvariants(next);
  });

  it('appends at the end and activates (E2 x S2, E7 x S2)', () => {
    const next = reduceTabState(ready(['a', 'b'], 'a'), {
      type: 'open',
      spaceId: 'c',
    });
    expect(next.openIds).toEqual(['a', 'b', 'c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('activates an open tab in place (E3 x S2, E4 x S2)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'a'), {
      type: 'open',
      spaceId: 'c',
    });
    expect(next.openIds).toEqual(['a', 'b', 'c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('stands still when the tab is already the active one', () => {
    const state = ready(['a', 'b'], 'b');
    expect(reduceTabState(state, { type: 'open', spaceId: 'b' })).toBe(state);
  });
});

describe('reduceTabState — closing a tab (E5)', () => {
  it('removes it and leaves the active tab alone (E5 x S2, closing a sibling)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'c'), {
      type: 'close',
      spaceId: 'b',
    });
    expect(next.openIds).toEqual(['a', 'c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('activates the leftmost survivor (E5 x S2, closing the active)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'b'), {
      type: 'close',
      spaceId: 'b',
    });
    expect(next.openIds).toEqual(['a', 'c']);
    expect(next.activeId).toBe('a');
    expectInvariants(next);
  });

  it('leaves an empty strip (E5 x S2, closing the last)', () => {
    const next = reduceTabState(ready(['a'], 'a'), {
      type: 'close',
      spaceId: 'a',
    });
    expect(next).toEqual({ ready: true, openIds: [], activeId: null });
    expectInvariants(next);
  });
});

describe('reduceTabState — reordering (E6)', () => {
  it('reorders without changing the active tab (E6 x S2)', () => {
    const next = reduceTabState(ready(['a', 'b', 'c'], 'b'), {
      type: 'reorder',
      spaceId: 'c',
      beforeSpaceId: 'a',
    });
    expect(next.openIds).toEqual(['c', 'a', 'b']);
    expect(next.activeId).toBe('b');
    expectInvariants(next);
  });

  it('stands still when the move lands where the tab already is', () => {
    const state = ready(['a', 'b'], 'a');
    expect(
      reduceTabState(state, {
        type: 'reorder',
        spaceId: 'b',
        beforeSpaceId: null,
      }),
    ).toBe(state);
  });
});

describe('reduceTabState — switching project (E10)', () => {
  it('resets to the unready state (E10 x S1, E10 x S2)', () => {
    expect(reduceTabState(ready(['a', 'b'], 'b'), { type: 'reset' })).toEqual(
      INITIAL_TAB_STATE,
    );
    expect(reduceTabState(ready([], null), { type: 'reset' })).toEqual(
      INITIAL_TAB_STATE,
    );
  });

  it('takes the next project s newest Space after a reset', () => {
    const afterReset = reduceTabState(ready(['a'], 'a'), { type: 'reset' });
    const next = reduceTabState(afterReset, {
      type: 'spaces',
      spaces: [space('x', 10), space('y', 20)],
    });
    expect(next).toEqual({ ready: true, openIds: ['y'], activeId: 'y' });
    expectInvariants(next);
  });
});
