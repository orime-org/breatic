// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  initialTabState,
  reduceTabState,
  type TabState,
} from '@web/pages/project/tab-state';
import type { TabOrderEntry } from '@breatic/shared';

/**
 * Every fillable cell of the transition table has an assertion here. The five
 * actions carry the events: `spaces` carries E1/E8/E9, `open` carries
 * E2/E3/E4/E7, and `close` / `reorder` carry one each.
 * Cells that share an action, a state AND an outcome are one assertion, named
 * for both.
 *
 * | Cell                          | Test                                          |
 * |-------------------------------|-----------------------------------------------|
 * | E1 x S0, nothing stored       | seeds the newest Space and activates it       |
 * | E1 x S0, spaces empty         | becomes ready with an empty strip             |
 * | E1 x S0, a stored list        | reopens the stored tabs in the stored order   |
 * | E1 x S0, stored list empty    | leaves the strip empty                        |
 * | E1 x S0, stored tabs deleted  | drops them and keeps the rest                 |
 * | E1 x S0, all stored deleted   | falls back to the newest Space                |
 * | E1 x S0, stored active gone   | falls back to the leftmost restored tab       |
 * | E1 x S0, stored list repeats  | opens one tab per Space                       |
 * | E8 x S1                       | leaves an empty strip alone                   |
 * | E8 x S2, active survives      | drops the deleted tabs, keeps the active one  |
 * | E8 x S2, active deleted       | falls back to the leftmost surviving tab      |
 * | E8 x S2, all deleted          | empties the strip without refilling it        |
 * | E9 x S1, E9 x S2              | ignores Spaces somebody else created          |
 * | E2 x S1, E7 x S1              | opens onto an empty strip                     |
 * | E2 x S2, E7 x S2              | appends at the end and activates              |
 * | E3 x S2, E4 x S2              | activates an open tab in place                |
 * | E5 x S2, closing a sibling    | removes it and leaves the active tab alone    |
 * | E5 x S2, closing the active   | activates the leftmost survivor               |
 * | E5 x S2, closing the last     | leaves an empty strip                         |
 * | E6 x S2                       | reorders without changing the active tab      |
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
  persist: true,
  restored: null,
});

/** A fresh page that found nothing stored. */
const fresh = (): TabState => initialTabState(null);

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
  if (state.ready) expect(state.restored).toBeNull();
}

describe('reduceTabState — spaces arriving with nothing stored (E1, E8, E9)', () => {
  it('seeds the newest Space and activates it (E1 x S0, nothing stored)', () => {
    const next = reduceTabState(fresh(), { type: 'spaces', spaces: SPACES });
    expect(next).toEqual(ready(['c'], 'c'));
    expectInvariants(next);
  });

  it('becomes ready with an empty strip (E1 x S0, spaces empty)', () => {
    const next = reduceTabState(fresh(), { type: 'spaces', spaces: [] });
    expect(next).toEqual(ready([], null));
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
    // Not stored: the reader did not choose this empty strip, so the record
    // keeps naming the deleted Space and the next visit falls back.
    expect(next).toEqual({ ...ready([], null), persist: false });
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

describe('reduceTabState — spaces arriving onto a stored strip (E1)', () => {
  it('reopens the stored tabs in the stored order (E1 x S0, a stored list)', () => {
    const state = initialTabState({
      openIds: ['c', 'a'],
      activeId: 'a',
    });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next).toEqual(ready(['c', 'a'], 'a'));
    expectInvariants(next);
  });

  it('leaves the strip empty (E1 x S0, stored list empty)', () => {
    const state = initialTabState({ openIds: [], activeId: null });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next).toEqual(ready([], null));
    expectInvariants(next);
  });

  it('drops them and keeps the rest (E1 x S0, stored tabs deleted)', () => {
    const state = initialTabState({
      openIds: ['a', 'gone', 'c'],
      activeId: 'c',
    });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next.openIds).toEqual(['a', 'c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('falls back to the newest Space (E1 x S0, all stored deleted)', () => {
    const state = initialTabState({
      openIds: ['gone', 'also-gone'],
      activeId: 'gone',
    });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next.openIds).toEqual(['c']);
    expect(next.activeId).toBe('c');
    expectInvariants(next);
  });

  it('falls back to the leftmost restored tab (E1 x S0, stored active gone)', () => {
    const state = initialTabState({
      openIds: ['b', 'c'],
      activeId: 'gone',
    });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next.openIds).toEqual(['b', 'c']);
    expect(next.activeId).toBe('b');
    expectInvariants(next);
  });

  it('opens one tab per Space (E1 x S0, stored list repeats)', () => {
    const state = initialTabState({
      openIds: ['a', 'b', 'a'],
      activeId: 'a',
    });
    const next = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    expect(next.openIds).toEqual(['a', 'b']);
    expectInvariants(next);
  });

  it('spends what was stored on the first arrival only', () => {
    const state = initialTabState({ openIds: ['a', 'b'], activeId: 'b' });
    const first = reduceTabState(state, { type: 'spaces', spaces: SPACES });
    const closed = reduceTabState(first, { type: 'close', spaceId: 'a' });
    const second = reduceTabState(closed, { type: 'spaces', spaces: SPACES });
    expect(second.openIds).toEqual(['b']);
  });
});

describe('reduceTabState — opening a Space (E2, E3, E4, E7)', () => {
  it('opens onto an empty strip (E2 x S1, E7 x S1)', () => {
    const next = reduceTabState(ready([], null), {
      type: 'open',
      spaceId: 'a',
    });
    expect(next).toEqual(ready(['a'], 'a'));
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
    expect(next).toEqual(ready([], null));
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


describe('reduceTabState — what is worth storing', () => {
  it('stores the strip this visit landed on', () => {
    const next = reduceTabState(fresh(), { type: 'spaces', spaces: SPACES });
    expect(next.persist).toBe(true);
  });

  it('does not store a strip that lost a tab to a deleted Space', () => {
    const next = reduceTabState(ready(['a', 'b'], 'b'), {
      type: 'spaces',
      spaces: SPACES.filter((s) => s.id !== 'b'),
    });
    expect(next.openIds).toEqual(['a']);
    expect(next.persist).toBe(false);
  });

  it('does not store the empty strip left by deleting every open Space', () => {
    // The record keeps naming the deleted Spaces, so the next visit filters
    // them out and reaches the rule for a list whose Spaces are all gone.
    const next = reduceTabState(ready(['a', 'b'], 'b'), {
      type: 'spaces',
      spaces: [],
    });
    expect(next.openIds).toEqual([]);
    expect(next.persist).toBe(false);
  });

  it.each([
    ['opening one', { type: 'open', spaceId: 'c' } as const],
    ['closing one', { type: 'close', spaceId: 'a' } as const],
    [
      'reordering',
      { type: 'reorder', spaceId: 'b', beforeSpaceId: 'a' } as const,
    ],
  ])('stores the strip after the reader is done %s', (_name, action) => {
    const next = reduceTabState({ ...ready(['a', 'b'], 'b'), persist: false }, action);
    expect(next.persist).toBe(true);
  });

  it('stores the empty strip the reader closed down to', () => {
    const one = reduceTabState(ready(['a'], 'a'), { type: 'close', spaceId: 'a' });
    expect(one.openIds).toEqual([]);
    expect(one.persist).toBe(true);
  });
});
