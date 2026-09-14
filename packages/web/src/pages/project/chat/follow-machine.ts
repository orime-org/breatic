// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Who the chat column belongs to right now. */
export type FollowState = 'following' | 'travelling' | 'held';

/** Everything that can happen to the chat column. */
export type FollowEvent =
  | 'readerMovedUp'
  | 'readerMovedDownShort'
  | 'readerMovedDownToEnd'
  | 'wayBackPressed'
  | 'messageSent'
  | 'conversationSwitched'
  | 'thinkingOpened'
  | 'earlierLoaded'
  | 'contentGrew'
  | 'contentShrank'
  | 'viewportShrank'
  | 'viewportGrew'
  | 'glideFrame'
  | 'glideArrived';

/**
 * Who the column belongs to after each thing that can happen to it, written
 * out in full. The type makes it total, so a new event or a new state cannot
 * be added without answering for every combination -- which is the whole point
 * of settling the table before writing the code.
 *
 * Eight of these forty-two the column never asks about; what makes each one
 * unreachable is recorded beside it in `__tests__/follow-machine.test.ts`.
 * They answer "nothing changed", so a reason that turns out to be wrong leaves
 * the reader where they are rather than somewhere new.
 */
const TRANSITIONS: Readonly<Record<FollowState, Readonly<Record<FollowEvent, FollowState>>>> = {
  following: {
    readerMovedUp: 'held',
    readerMovedDownShort: 'following',
    readerMovedDownToEnd: 'following',
    wayBackPressed: 'following',
    messageSent: 'following',
    conversationSwitched: 'following',
    thinkingOpened: 'held',
    earlierLoaded: 'following',
    contentGrew: 'following',
    contentShrank: 'following',
    viewportShrank: 'following',
    viewportGrew: 'following',
    glideFrame: 'following',
    glideArrived: 'following',
  },
  travelling: {
    readerMovedUp: 'held',
    // Pressing the way back says "take me to the end", and a push downward
    // agrees with it; only a push back up is a change of mind. This is also
    // where a browser's scroll anchoring lands -- content above the viewport
    // growing taller moves the column down with nobody touching it -- and a
    // journey has no business ending on that.
    readerMovedDownShort: 'travelling',
    readerMovedDownToEnd: 'following',
    wayBackPressed: 'travelling',
    messageSent: 'following',
    conversationSwitched: 'following',
    thinkingOpened: 'held',
    earlierLoaded: 'travelling',
    contentGrew: 'travelling',
    contentShrank: 'travelling',
    viewportShrank: 'travelling',
    viewportGrew: 'travelling',
    glideFrame: 'travelling',
    glideArrived: 'following',
  },
  held: {
    readerMovedUp: 'held',
    readerMovedDownShort: 'held',
    readerMovedDownToEnd: 'following',
    wayBackPressed: 'travelling',
    messageSent: 'following',
    conversationSwitched: 'following',
    thinkingOpened: 'held',
    earlierLoaded: 'held',
    contentGrew: 'held',
    contentShrank: 'held',
    viewportShrank: 'held',
    viewportGrew: 'held',
    glideFrame: 'held',
    glideArrived: 'held',
  },
};

/**
 * Where the column goes next.
 * @param state - Who it belongs to now.
 * @param event - What just happened to it.
 * @returns Who it belongs to after that.
 */
export function nextFollowState(state: FollowState, event: FollowEvent): FollowState {
  return TRANSITIONS[state][event];
}
