// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  nextFollowState,
  type FollowEvent,
  type FollowState,
} from '@web/pages/project/chat/follow-machine';

interface Cell {
  readonly from: FollowState;
  readonly event: FollowEvent;
  readonly to: FollowState;
}

/**
 * The cells the column reaches, in the order the design states them. The
 * table is three states down and fourteen events across; the rest of it is
 * in `UNREACHABLE` below, and the two together have to cover every cell. A
 * row missing from both, or one the machine does not have, is the drift this
 * file exists to catch.
 */
const REACHABLE: readonly Cell[] = [
  { from: 'following', event: 'readerMovedUp', to: 'held' },
  { from: 'travelling', event: 'readerMovedUp', to: 'held' },
  { from: 'held', event: 'readerMovedUp', to: 'held' },

  { from: 'travelling', event: 'readerMovedDownShort', to: 'travelling' },
  { from: 'held', event: 'readerMovedDownShort', to: 'held' },

  { from: 'travelling', event: 'readerMovedDownToEnd', to: 'following' },
  { from: 'held', event: 'readerMovedDownToEnd', to: 'following' },

  { from: 'held', event: 'wayBackPressed', to: 'travelling' },

  { from: 'following', event: 'messageSent', to: 'following' },
  { from: 'travelling', event: 'messageSent', to: 'following' },
  { from: 'held', event: 'messageSent', to: 'following' },

  { from: 'following', event: 'conversationSwitched', to: 'following' },
  { from: 'travelling', event: 'conversationSwitched', to: 'following' },
  { from: 'held', event: 'conversationSwitched', to: 'following' },

  { from: 'following', event: 'thinkingOpened', to: 'held' },
  { from: 'travelling', event: 'thinkingOpened', to: 'held' },
  { from: 'held', event: 'thinkingOpened', to: 'held' },

  { from: 'following', event: 'earlierLoaded', to: 'following' },
  { from: 'travelling', event: 'earlierLoaded', to: 'travelling' },
  { from: 'held', event: 'earlierLoaded', to: 'held' },

  { from: 'following', event: 'contentGrew', to: 'following' },
  { from: 'travelling', event: 'contentGrew', to: 'travelling' },
  { from: 'held', event: 'contentGrew', to: 'held' },

  { from: 'following', event: 'contentShrank', to: 'following' },
  { from: 'travelling', event: 'contentShrank', to: 'travelling' },
  { from: 'held', event: 'contentShrank', to: 'held' },

  { from: 'following', event: 'viewportShrank', to: 'following' },
  { from: 'travelling', event: 'viewportShrank', to: 'travelling' },
  { from: 'held', event: 'viewportShrank', to: 'held' },

  { from: 'following', event: 'viewportGrew', to: 'following' },
  { from: 'travelling', event: 'viewportGrew', to: 'travelling' },
  { from: 'held', event: 'viewportGrew', to: 'held' },

  { from: 'travelling', event: 'glideFrame', to: 'travelling' },

  { from: 'travelling', event: 'glideArrived', to: 'following' },
];

/**
 * The eight cells §4 marks impossible, each with what makes it so. The column
 * never asks the machine about them; the machine answers anyway, and what it
 * answers is "nothing changed", so a design that turns out to be wrong about
 * one of these leaves the reader where they are instead of somewhere new.
 */
const UNREACHABLE: readonly (Cell & { readonly because: string })[] = [
  {
    from: 'following',
    event: 'readerMovedDownShort',
    to: 'following',
    because: 'a following column sits at the end, and the browser raises no scroll event for a push past it',
  },
  {
    from: 'following',
    event: 'readerMovedDownToEnd',
    to: 'following',
    because: 'same: there is no travel left below a column that is already at the end',
  },
  {
    from: 'following',
    event: 'wayBackPressed',
    to: 'following',
    because: 'the way-back button is drawn only while the column is held',
  },
  {
    from: 'travelling',
    event: 'wayBackPressed',
    to: 'travelling',
    because: 'same: the button is gone the moment the glide starts',
  },
  {
    from: 'following',
    event: 'glideFrame',
    to: 'following',
    because: 'a glide only runs while travelling',
  },
  {
    from: 'held',
    event: 'glideFrame',
    to: 'held',
    because: 'every transition out of travelling stops the glide as part of itself',
  },
  {
    from: 'following',
    event: 'glideArrived',
    to: 'following',
    because: 'no glide is in flight',
  },
  {
    from: 'held',
    event: 'glideArrived',
    to: 'held',
    because: 'same: leaving travelling stopped it',
  },
];

describe('nextFollowState', () => {
  it('covers the whole table, once each', () => {
    expect(REACHABLE.length + UNREACHABLE.length).toBe(42);
    const seen = new Set([...REACHABLE, ...UNREACHABLE].map((c) => `${c.from}/${c.event}`));
    expect(seen.size).toBe(42);
  });

  it.each(REACHABLE)('$from, then $event, leaves it $to', ({ from, event, to }) => {
    expect(nextFollowState(from, event)).toBe(to);
  });

  describe('cells the column never reaches', () => {
    it.each(UNREACHABLE)('$from never sees $event, because $because', ({ from, event, to }) => {
      expect(nextFollowState(from, event)).toBe(to);
    });
  });
});
